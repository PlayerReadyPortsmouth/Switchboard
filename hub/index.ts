import { join, dirname } from "path"
import { unlinkSync, appendFileSync, mkdirSync, readFileSync, existsSync, statSync, renameSync, readdirSync } from "fs"
import { config as loadEnv } from "./env"
import { loadConfigs } from "./config"
import { BaseGate } from "./baseGate"
import { Gateway } from "./gateway"
import { Dispatcher, type AgentTransport } from "./transports/index"
import { StreamJsonTransport, makeBunProcessSpawner } from "./transports/streamJson"
import { ReplicaPool } from "./agentPool"
import { ShimSocketServer } from "./transports/shimSocket"
import { makeRouterRunner } from "./transports/spawnClaude"
import { route as routeFn } from "./router"
import { Orchestrator } from "./orchestrator"
import { NotifyRouter } from "./notifyRouter"
import { startWebhookListener, type WebhookHandler } from "./webhookListener"
import { startCron, CronState } from "./scheduler"
import { drainApprovals } from "./approvals"
import { CardRegistry } from "./cardRegistry"
import { CardLifecycle } from "./cardLifecycle"
import { matchGatedAction, requiresApprover } from "./gatedActions"
import { isDeployAuthorized } from "./deployGate"
import { clearReactionAgent } from "./channelPin"
import { MessageCache } from "./messageCache"
import { enrich, foldQuote } from "./enrich"
import { expandHome } from "./config"
import { MemoryStore, type Scope } from "./memory/store"
import { VectorIndex } from "./memory/vectorIndex"
import type { MemoryIndex } from "./memory/memoryIndex"
import { TransformersEmbedder, type Embedder } from "./memory/embedder"
import { HttpEmbedder } from "./memory/httpEmbedder"
import { QdrantIndex } from "./memory/qdrantIndex"
import { MemoryRetriever } from "./memory/retriever"
import { AccessStore } from "./memory/accessStore"
import { Gardener } from "./memory/gardener"
import { distill } from "./memory/distiller"
import { Overseer } from "./overseer"
import { SessionGovernor } from "./sessionGovernor"
import { contextWindow } from "./usage"
import { StatusRegistry, type AgentStatus, type OverseerStatus } from "./statusRegistry"
import { renderBoard, Throttle } from "./statusBoard"
import { matchDirectCommand, runDirect, interpolateArgs, type DirectExecutor } from "./directCommands"
import { OutboundDelivery } from "./outboundDelivery"
import { matchOutbound, renderBody } from "./outbound"
import { AuditLog } from "./auditLog"
import { parseJsonlTail, shouldRotate, rotationsToPrune } from "./audit"
import { parseAuditCommand, renderAuditLines, renderAuditSummary } from "./auditCommand"
import { buildReplay, renderReplay, chunkLines } from "./replay"
import { ApprovalRegistry, renderApprovalCard, parseApprovalCustomId, type ApprovalRequest, type ApprovalDecision, type ApprovalFire } from "./approval"
import { startMetricsServer } from "./metricsServer"
import { renderHealth, type MetricsInput } from "./metrics"
import { startWebServer } from "./webServer"
import { type WebInput } from "./web"
import { ConsultRegistry, mayConsult, consultAnswerFromReply } from "./consult"
import { MissionRegistry, findWorkflow, renderStepPrompt, renderMissionCard, type MissionRun } from "./workflow"
import type { AgentConfig, AgentReply, SpawnTrigger, SpawnCardUpdate, CardSpec, DirectCommand, OutboundRoute } from "./types"

const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const { hub, agents } = loadConfigs(CONFIG_DIR)

loadEnv(join(hub.stateDir, ".env"))   // load DISCORD_BOT_TOKEN + agent env if present
const startedAt = Date.now()          // for the metrics/health uptime gauge
const token = process.env[hub.botTokenEnv]
if (!token) { console.error(`missing ${hub.botTokenEnv}`); process.exit(1) }

const gateway = new Gateway(hub, agents)
const deployApprover = hub.deployApproverUserId ?? ""
// Approval buttons are pressable only by configured approvers (default: the
// deploy approver); everything else keeps the existing deploy/gated-action gate.
const approvalApprovers = hub.approvals?.approvers ?? (deployApprover ? [deployApprover] : [])
gateway.setNotifyButtonGate((customId, userId) => {
  if (customId.startsWith("approval:")) return approvalApprovers.includes(userId)
  return isDeployAuthorized(customId, userId, deployApprover) &&
    (requiresApprover(customId, hub.gatedActions ?? []) ? !!deployApprover && userId === deployApprover : true)
})
const routerRunner = makeRouterRunner()
const spawner = makeBunProcessSpawner()

const SHIM_PATH = join(import.meta.dir, "..", "shim", "server.ts")
const notifyRouter = new NotifyRouter()

// key → live transport (persistent agent name, or jobId for spawned workers).
const transports = new Map<string, StreamJsonTransport>()

// Recent-message cache (per Discord channel), persisted so it survives restarts
// and feeds the background distiller. Source for "where relevant" context injection.
const messageCache = new MessageCache(hub.contextCacheSize ?? 20, join(hub.stateDir, "cache"))

// Memory vault: Obsidian-style .md notes + local-embedding recall + Claude
// librarian. Reindexed once at boot; the embedder loads its model lazily.
const memoryDir = hub.memoryDir ? expandHome(hub.memoryDir) : join(hub.stateDir, "memory")
const memoryStore = new MemoryStore(memoryDir)

// Backend selection (default: fully local, no secrets). Hosted options behind
// the same seams: Qdrant for recall, an OpenAI-compatible endpoint for embeddings.
const mem = hub.memory ?? {}
const embedder: Embedder = mem.embedder === "openai" && mem.openai
  ? new HttpEmbedder({
      baseUrl: mem.openai.baseUrl, model: mem.openai.model,
      apiKey: mem.openai.apiKeyEnv ? process.env[mem.openai.apiKeyEnv] : undefined,
    })
  : new TransformersEmbedder()
const vectorIndex: MemoryIndex = mem.index === "qdrant" && mem.qdrant
  ? new QdrantIndex({
      url: mem.qdrant.url, collection: mem.qdrant.collection,
      apiKey: mem.qdrant.apiKeyEnv ? process.env[mem.qdrant.apiKeyEnv] : undefined,
    })
  : new VectorIndex(join(memoryDir, ".index", "vectors.json"))
// Usage signal: records access hits, weights recall, drives the proactive hot set.
const garden = hub.gardener ?? {}
const accessStore = new AccessStore(join(memoryDir, ".access.json"), garden.decayHalfLifeMs)
const memoryRetriever = new MemoryRetriever({
  store: memoryStore, index: vectorIndex, embedder,
  run: makeRouterRunner(), librarianModel: hub.librarianModel ?? hub.routerModel,
  access: accessStore,
  importanceWeight: garden.importanceWeight ?? (garden.enabled ? 0.15 : 0),
  hotSetSize: garden.hotSetSize ?? (garden.enabled ? 3 : 0),
})
void memoryRetriever.reindexAll().catch((e) => process.stderr.write(`memory: reindex failed: ${e}\n`))

/** Background dedup for a just-written note: auto-merge distiller dups, append
 *  suspected protected dups to a review log (never silently touch hand-written notes). */
function runDedup(path: string): void {
  void (async () => {
    try {
      const { removed, flagged } = await memoryRetriever.dedupe(memoryStore.read(path))
      for (const r of removed) process.stderr.write(`memory: deduped (merged away) ${r}\n`)
      if (flagged.length) {
        mkdirSync(memoryDir, { recursive: true })
        for (const f of flagged) {
          appendFileSync(join(memoryDir, ".dedup-review.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...f }) + "\n")
        }
      }
    } catch (e) { process.stderr.write(`memory: dedup failed: ${e}\n`) }
  })()
}

// Per-conversation activity clock — drives the background distiller's idle sweep.
const convActivity = new Map<string, number>()
const distilledAt = new Map<string, number>()
const distillerRunner = makeRouterRunner()

/** Distill one idle conversation's recent cache into memory-vault notes. */
async function runDistill(convId: string): Promise<void> {
  const msgs = messageCache.recent(convId)
  if (msgs.length < 2) return
  const conversation = msgs
    .map((m) => `[${m.role === "agent" ? (m.agent ?? "agent") : (m.user ?? "user")}] ${m.text}`)
    .join("\n")
  const userIds = [...new Set(msgs.map((m) => m.userId).filter((u): u is string => !!u))]
  const scopes = ["global", `channels/${convId}`, ...userIds.map((u) => `users/${u}`)] as Scope[]
  const existing = memoryStore.list(scopes).map((n) => ({ scope: n.scope, title: n.title }))
  const upserts = await distill(
    { conversation, existing }, distillerRunner, hub.distillerModel ?? hub.routerModel,
  )
  for (const u of upserts) {
    try {
      // Protected: never let the distiller overwrite a hand-written (agent-authored) note.
      const target = memoryStore.notePath(u.scope as Scope, u.title)
      try {
        if (memoryStore.read(target).source.startsWith("agent:")) {
          process.stderr.write(`distill: skipping protected note ${target}\n`); continue
        }
      } catch {}
      const path = memoryStore.write(u.scope as Scope, { title: u.title, tags: u.tags, body: u.body, source: "distiller" })
      await memoryRetriever.indexNote(memoryStore.read(path)).catch(() => {})
      runDedup(path)
    } catch (e) { process.stderr.write(`distill: write failed: ${e}\n`) }
  }
}

const cardRegistry = new CardRegistry()
const cardLifecycle = new CardLifecycle(cardRegistry, {
  sendCard: (chatId, card) => gateway.sendCard(chatId, card),
  editCard: (chatId, messageId, card) => gateway.editCard(chatId, messageId, card),
  registerButtons: (ids, key) => notifyRouter.register(ids, key),
  forgetButtons: (ids) => notifyRouter.forget(ids),
  registerModals: (card) => { for (const b of card.buttons) if (b.modal) gateway.registerModal(b.customId, b.modal) },
  unregisterModals: (ids) => gateway.unregisterModals(ids),
  ownerOf: (customId) => notifyRouter.agentFor(customId),
  closeTransport: (key) => { void transports.get(key)?.close() },
  runCommand: (cmd) => Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit" }).exited,
})

/** Build (but do not start) a StreamJsonTransport and register it under `key`. */
function makeTransport(name: string, key: string, cfg: AgentConfig): StreamJsonTransport {
  const socketPath = join(hub.stateDir, `${key}.sock`)
  const socket = new ShimSocketServer(socketPath)
  // Agent-initiated memory: `remember` writes a note (scope defaults to this
  // agent's own folder) and indexes it; `recall` searches and returns notes.
  socket.onRemember(({ scope, title, tags, body }) => {
    const s = (scope && /^(global$|users\/|agents\/|channels\/)/.test(scope) ? scope : `agents/${name}`) as Scope
    try {
      const path = memoryStore.write(s, { title, tags, body, source: `agent:${name}` })
      void memoryRetriever.indexNote(memoryStore.read(path)).then(() => runDedup(path)).catch(() => {})
    } catch (e) { process.stderr.write(`memory: remember failed: ${e}\n`) }
  })
  socket.onRecall(async ({ query, scopes }) => {
    const sc = (scopes?.length ? scopes : ["global", `agents/${name}`]) as Scope[]
    try { return (await memoryRetriever.relevant(query, sc)).notes.map((n) => ({ title: n.title, body: n.body })) }
    catch { return [] }
  })
  // Agent-initiated outbound: fire a named (operator-configured) outbound route.
  socket.onPostWebhook(({ target, body }) => { fireOutboundNamed(target, body, `agent:${name}`, name) })
  // Agent-initiated consult: ask another agent and get its reply back. Gated by
  // consult.enabled + the target's access.consultableBy; recorded as a `consult`
  // event. The target runs on a virtual channel so its reply is intercepted in
  // onAgentReply and returned here, not posted to Discord.
  socket.onAskAgent(({ agent: targetName, message }) => new Promise<string>((resolveAnswer) => {
    const requester = name
    if (!hub.consult?.enabled || !mayConsult(requester, targetName, agents[targetName])) {
      audit.record({ kind: "consult", actor: `agent:${requester}`, action: "ask", target: targetName, outcome: "deny" })
      resolveAnswer(`(not permitted to consult "${targetName}")`)
      return
    }
    const e = consultRegistry.open(requester, targetName, resolveAnswer)
    audit.record({ kind: "consult", actor: `agent:${requester}`, action: "ask", target: targetName, chat: e.channel, outcome: "ok", corr: e.id })
    const ok = dispatcher.dispatch(targetName, e.channel, {
      chatId: e.channel, messageId: `consult:${requester}`, userId: "system", user: "hub",
      content: message, ts: new Date().toISOString(), isDM: false,
    })
    if (!ok) consultRegistry.settle(e.channel, `(agent "${targetName}" is unavailable)`)
  }))
  const t = new StreamJsonTransport(name, cfg, {
    spawner,
    socket,
    shimPath: SHIM_PATH,
    socketPath,
    mcpConfigPath: join(hub.stateDir, `${key}.mcp.json`),
    resumable: cfg.runtime.resumable === true,
    sessionPath: join(hub.stateDir, `${key}.session`),
    consultEnabled: !!hub.consult?.enabled,
    onOverflow: (inbound) => {
      // A consult that overflows the target's queue must settle the caller's
      // ask_agent now (not post a "busy" notice to the virtual channel and hang).
      if (consultRegistry.isConsultChannel(inbound.chatId)) {
        consultRegistry.settle(inbound.chatId, `(agent "${name}" is busy)`)
        return
      }
      // Likewise a mission step: fail it now so the run aborts promptly instead of
      // posting a "busy" notice to the virtual channel and hanging to the timeout.
      if (missionRegistry.isMissionChannel(inbound.chatId)) {
        missionRegistry.fail(inbound.chatId, `agent "${name}" is busy`)
        return
      }
      void gateway.sendPlain(inbound.chatId, `${cfg.emoji} ${name} is busy — please resend in a moment.`)
    },
  })
  t.onReply((reply) => { void onAgentReply(reply, key) })
  transports.set(key, t)
  return t
}

// Spawn triggers: any agent's outbound text matching `pattern` fires an
// ephemeral spawn (and is NOT forwarded to Discord).
const spawnTriggers = (hub.spawnTriggers ?? []).map((t) => ({ ...t, re: new RegExp(t.pattern) }))

// Outbound webhooks: agents (and hub events) push signed POSTs to named routes.
// The hub owns the URL+secret — agents address routes by id, never a raw URL.
const outboundRoutes = hub.outboundWebhooks ?? []
function appendJsonl(path: string, entry: unknown): void {
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(entry) + "\n") }
  catch (e) { process.stderr.write(`outbound log append failed: ${e}\n`) }
}
const outboundDelivery = new OutboundDelivery({
  fetch: async (url, init) => {
    const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
    return { status: r.status }
  },
  appendLog: (e) => appendJsonl(join(hub.stateDir, "outbound-log.jsonl"), e),
  appendDeadLetter: (e) => appendJsonl(join(hub.stateDir, "outbound-dead.jsonl"), e),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => Date.now(),
  secretFor: (route) => (route.secretEnv ? process.env[route.secretEnv] : undefined),
  retries: hub.outboundRetries,
  allowedHosts: hub.outboundAllowedHosts,
})

// Audit log: one append-only ledger of every governed effect (route, spawn,
// exec, outbound, session, access, event, …). Off unless `hub.audit.enabled`.
// Secrets — outbound + direct-command env values, plus any `audit.redactEnv` —
// are masked in `detail` before append. `record()` never throws.
const auditFile = join(hub.stateDir, hub.audit?.file ?? "audit.jsonl")
const auditSecrets = [
  hub.botTokenEnv,
  ...(hub.outboundWebhooks ?? []).map((r) => r.secretEnv),
  ...(hub.directCommands ?? []).map((c) => (c.exec.type === "http" ? c.exec.secretEnv : undefined)),
  ...(hub.audit?.redactEnv ?? []),
]
  .filter((n): n is string => !!n)
  .map((n) => process.env[n])
  .filter((v): v is string => !!v)
/** Append one event, rotating the ledger first when it reaches `audit.maxBytes`
 *  (renamed to audit-<ts>.jsonl, oldest rotations pruned to `keepFiles`). */
function appendAudit(e: unknown): void {
  try {
    const max = hub.audit?.maxBytes
    if (existsSync(auditFile) && shouldRotate(statSync(auditFile).size, max)) {
      renameSync(auditFile, join(hub.stateDir, `audit-${Date.now()}.jsonl`))
      const rotated = readdirSync(hub.stateDir).filter((f) => /^audit-\d+\.jsonl$/.test(f))
      for (const f of rotationsToPrune(rotated, hub.audit?.keepFiles)) {
        try { unlinkSync(join(hub.stateDir, f)) } catch {}
      }
    }
  } catch (err) { process.stderr.write(`audit rotate failed: ${err}\n`) }
  appendJsonl(auditFile, e)
}
const audit = new AuditLog({
  append: appendAudit,
  readTail: (n) => { try { return parseJsonlTail(readFileSync(auditFile, "utf8"), n) } catch { return [] } },
  now: () => Date.now(),
  secrets: auditSecrets,
  enabled: hub.audit?.enabled ?? false,
  kinds: hub.audit?.kinds,
})
/** Per-agent audit opt-out: an agent with `runtime.audit === false` is excluded
 *  from agent-attributed events even when the hub master switch is on. */
const auditOptedOut = (agent?: string): boolean =>
  !!agent && agents[agent]?.runtime.audit === false

// Approval gate: a requireApproval effect parks here, posts an Approve/Deny card,
// and fires only on a configured approver's grant (fail-closed on deny / expiry /
// restart). Off unless approvals.enabled. Every step is an `approval` audit event
// threaded by the approval id as `corr`.
const approvalsEnabled = !!hub.approvals?.enabled
if (approvalsEnabled) {
  if (approvalApprovers.length === 0)
    console.error("switchboard hub: approvals enabled but no approver configured — every requireApproval effect will expire unapproved")
  if (!hub.approvals?.channelId)
    console.error("switchboard hub: approvals enabled with no channelId — approvals for routes lacking an origin chat (post_webhook / events) cannot post a card and will expire")
}
let approvalCounter = 0
const approvalRegistry = new ApprovalRegistry(
  () => Date.now(),
  () => `appr-${++approvalCounter}`,
  hub.approvals?.ttlMs ?? 3_600_000,
)
const approvalCards = new Map<string, { chatId: string; messageId: string }>()
// Inter-agent consult: ask_agent dispatches the question to the target on a
// virtual "consult:<id>" channel; the target's reply is intercepted in
// onAgentReply and returned to the caller. Off unless consult.enabled.
let consultCounter = 0
const consultRegistry = new ConsultRegistry(
  () => Date.now(),
  () => `c${++consultCounter}`,
  hub.consult?.timeoutMs ?? 90_000,
)

// Agent workflows / missions: a mission runs a workflow's steps in order, each on
// a hidden mission:<id> channel (captured like a consult) whose output feeds the
// next step's prompt, with a live progress card. Off unless workflow.enabled.
const missionStepTimeoutMs = hub.workflow?.stepTimeoutMs ?? 120_000
let missionStepCounter = 0
let missionRunCounter = 0
const missionRegistry = new MissionRegistry(() => `s${++missionStepCounter}`)
const missionCards = new Map<string, { chatId: string; messageId: string }>()

/** Run one mission step: dispatch the prompt to `agent` on a hidden channel and
 *  await the captured reply. Resolves {ok:false} on an unavailable/busy agent or
 *  a per-step timeout. The registry is single-shot, so whichever of settle (real
 *  reply), fail (busy via onOverflow / timeout), or the unavailable path fires
 *  first wins; the timer is cleared on resolve. */
function runMissionStep(label: string, agent: string, prompt: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const { channel } = missionRegistry.open((ok, output) => { clearTimeout(timer); resolve({ ok, output }) })
    timer = setTimeout(() => missionRegistry.fail(channel, "(step timed out)"), missionStepTimeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    const ok = dispatcher.dispatch(agent, channel, {
      chatId: channel, messageId: `mission:${label}`, userId: "system", user: "hub",
      content: prompt, ts: new Date().toISOString(), isDM: false,
    })
    if (!ok) missionRegistry.fail(channel, `agent "${agent}" is unavailable`)
  })
}

/** Run a workflow as a mission: execute steps in order, feeding each output into
 *  the next step's prompt, with a live progress card and per-step audit (corr =
 *  runId). Aborts the run on the first failed step. */
async function runWorkflow(workflowId: string, input: string, chatId: string, actor: string): Promise<void> {
  const wf = findWorkflow(hub.workflows ?? [], workflowId)
  if (!wf || wf.enabled === false) { void gateway.sendPlain(chatId, `⚠️ unknown workflow "${workflowId}" — try \`!workflows\``); return }
  if (!wf.steps.length) { void gateway.sendPlain(chatId, `⚠️ workflow "${workflowId}" has no steps`); return }
  const runId = `run-${++missionRunCounter}`
  const run: MissionRun = {
    runId, workflowId, input, chatId, state: "running",
    steps: wf.steps.map((s) => ({ id: s.id, agent: s.agent, state: "pending" })),
  }
  audit.record({ kind: "mission", actor, action: "start", target: workflowId, chat: chatId, outcome: "ok", corr: runId, detail: { steps: wf.steps.length } })
  const msgId = await gateway.sendCard(chatId, renderMissionCard(run))
  if (msgId) missionCards.set(runId, { chatId, messageId: msgId })
  const editCard = () => { const loc = missionCards.get(runId); if (loc) void gateway.editCard(loc.chatId, loc.messageId, renderMissionCard(run)) }

  // try/finally guarantees the card entry is reclaimed on every exit path —
  // success, an aborted step, or an unexpected throw (the call is fire-and-forget).
  try {
    const outputs: Record<string, string> = {}
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i]
      run.steps[i].state = "running"; editCard()
      const res = await runMissionStep(`${workflowId}:${step.id}`, step.agent, renderStepPrompt(step.prompt, { input, steps: outputs }))
      if (!res.ok) {
        run.steps[i].state = "failed"; run.steps[i].output = res.output; run.state = "failed"; editCard()
        audit.record({ kind: "mission", actor: "hub", action: "error", target: workflowId, chat: chatId, outcome: "error", corr: runId, detail: { step: step.id, agent: step.agent } })
        void gateway.sendPlain(chatId, `❌ mission \`${workflowId}\` failed at step \`${step.id}\`: ${res.output}`)
        return
      }
      outputs[step.id] = res.output
      run.steps[i].state = "done"; run.steps[i].output = res.output; editCard()
      audit.record({ kind: "mission", actor: "hub", action: "step", target: step.agent, chat: chatId, outcome: "ok", corr: runId, detail: { step: step.id } })
    }
    run.state = "done"; editCard()
    audit.record({ kind: "mission", actor: "hub", action: "done", target: workflowId, chat: chatId, outcome: "ok", corr: runId })
    void gateway.sendPlain(chatId, `✅ mission \`${workflowId}\` complete:\n\n${outputs[wf.steps[wf.steps.length - 1].id]}`)
  } finally {
    missionCards.delete(runId)
  }
}
/** Park an effect for human approval: record the request, post the card, and
 *  remember it for editing on resolution. */
async function requestApproval(req: ApprovalRequest, fire: ApprovalFire): Promise<void> {
  const e = approvalRegistry.request(req, fire)
  audit.record({
    kind: "approval", actor: req.actor, action: "request", target: req.target,
    chat: req.chat, outcome: "pending", corr: e.id, detail: { kind: req.kind },
  })
  const channel = hub.approvals?.channelId ?? req.chat
  if (!channel) { process.stderr.write(`approval ${e.id}: no channel to post to\n`); return }
  const messageId = await gateway.sendCard(channel, renderApprovalCard(e))
  if (messageId) approvalCards.set(e.id, { chatId: channel, messageId })
}
/** Resolve an approval from a button click: audit the decision, edit the card to
 *  its terminal state, and (on grant) fire the held effect exactly once. */
async function resolveApproval(id: string, decision: ApprovalDecision, userId: string): Promise<void> {
  const e = approvalRegistry.resolve(id, decision)
  if (!e) return   // unknown or already resolved — single-shot
  audit.record({
    kind: "approval", actor: `user:${userId}`, action: decision === "grant" ? "grant" : "deny",
    target: e.target, chat: e.chat, outcome: decision === "grant" ? "ok" : "deny", corr: e.id,
  })
  const loc = approvalCards.get(e.id); approvalCards.delete(e.id)
  if (loc) await gateway.editCard(loc.chatId, loc.messageId, renderApprovalCard(e))
  if (decision === "grant") {
    try { await e.fire(e.id) } catch (err) { process.stderr.write(`approval ${e.id} fire failed: ${err}\n`) }
  }
}
/** The actual deliver + audit, used directly or as the held effect after an
 *  approval grant. `corr`, when present, threads this row to the approval. */
function doDeliver(route: OutboundRoute, body: string, actor: string, agent?: string, corr?: string): void {
  void outboundDelivery.deliver(route, body)
    .then((res) => {
      if (!auditOptedOut(agent)) audit.record({
        kind: "outbound", actor, action: "deliver", target: route.id, corr,
        outcome: res.ok ? "ok" : "error", detail: { status: res.status, attempts: res.attempts },
      })
    })
    .catch((e) => process.stderr.write(`outbound deliver failed: ${e}\n`))
}
/** Deliver an outbound route — but when it's flagged `requireApproval` and the
 *  approvals subsystem is enabled, park it for a human grant first (the delivery
 *  becomes the held effect). `actor` is who triggered it; `agent` honors
 *  per-agent audit opt-out; `chat` is the approval card's fallback channel. */
function deliverAudited(route: OutboundRoute, body: string, actor: string, agent?: string, chat?: string): void {
  if (approvalsEnabled && route.requireApproval) {
    void requestApproval(
      { kind: "outbound", target: route.id, actor, chat, summary: `POST → ${route.id}` },
      (corr) => doDeliver(route, body, actor, agent, corr),
    )
    return
  }
  doDeliver(route, body, actor, agent)
}
/** Fire any text-triggered outbound routes for `text`. Returns true if a matched
 *  route asked to `consume` the text (suppress the Discord post). */
function fireOutboundText(text: string, agent: string, chat: string): boolean {
  let consume = false
  for (const { route, groups } of matchOutbound(text, outboundRoutes)) {
    deliverAudited(route, renderBody(route.template, { groups }), `agent:${agent}`, agent, chat)
    if (route.consume) consume = true
  }
  return consume
}
/** Deliver to a named route by id (the post_webhook tool path). Unknown ⇒ false. */
function fireOutboundNamed(id: string, body?: string, actor = "hub", agent?: string): boolean {
  const route = outboundRoutes.find((r) => r.id === id)
  if (!route) { process.stderr.write(`post_webhook: unknown route "${id}"\n`); return false }
  deliverAudited(route, renderBody(route.template, { body }), actor, agent)
  return true
}
/** Fire a hub lifecycle event: record it to the ledger, and if a route with
 *  `event` as its id is configured, deliver it so external systems observe the
 *  hub (schedules, etc). */
function emitHubEvent(event: string, data: Record<string, unknown>): void {
  audit.record({ kind: "event", actor: "hub", action: event, detail: data })
  if (outboundRoutes.some((r) => r.id === event)) {
    fireOutboundNamed(event, JSON.stringify({ event, ts: Date.now(), ...data }))
  }
}

/** Handle one reply from a transport: cards → Discord card (+ register buttons);
 *  text → spawn-trigger match or a plain reply; react/edit → passthrough. */
async function onAgentReply(reply: AgentReply, key: string): Promise<void> {
  // Inter-agent consult: a reply on a virtual consult channel is the answer to a
  // pending ask_agent — settle it (return the answer to the caller) and never post
  // it to Discord or run the normal reply pipeline. Settle on the first text OR
  // card reply (an agent that answers with a card would otherwise never settle and
  // the consult would time out); a card is serialized to its title + body.
  if (consultRegistry.isConsultChannel(reply.chatId)) {
    const answer = consultAnswerFromReply(reply)
    if (answer !== undefined) {
      const settled = consultRegistry.settle(reply.chatId, answer)
      if (settled) audit.record({
        kind: "consult", actor: `agent:${settled.target}`, action: "answer",
        target: settled.requester, chat: reply.chatId, outcome: "ok", corr: settled.id,
      })
    }
    return
  }
  // Mission step: a reply on a virtual mission channel is a workflow step's output
  // — capture it (text or card) for the engine and never post it to Discord.
  if (missionRegistry.isMissionChannel(reply.chatId)) {
    const out = consultAnswerFromReply(reply)
    if (out !== undefined) missionRegistry.settle(reply.chatId, out)
    return
  }
  if (reply.kind === "card" && reply.card) {
    await cardLifecycle.onCard(reply, key)
    return
  }
  if (reply.kind === "update" && reply.card && reply.correlationId) {
    await cardLifecycle.onUpdate(reply.correlationId, reply.chatId, reply.card, key)
    return
  }
  if (reply.kind === "reply" && reply.text) {
    for (const trig of spawnTriggers) {
      const m = trig.re.exec(reply.text)
      if (m) { await runSpawnTrigger(trig, m as unknown as string[], reply.chatId, reply.agent); return }
    }
    // Outbound webhooks: fire any text-triggered routes (fire-and-forget). A
    // `consume` route suppresses the Discord post; otherwise the text still ships.
    if (fireOutboundText(reply.text, reply.agent, reply.chatId)) return
    // Session governor: inspect this turn's context usage. May swallow the reply
    // (when it's a compaction handoff) or annotate it, and signals whether the
    // overseer should stand down (don't add a turn mid-compaction).
    const gov = await governor.observe(reply.agent, reply.chatId, reply.text, reply.usage)
    // Overseer: for opt-in agents, judge the turn against the goal and either
    // swallow it (a nudge was delivered → another turn coming) or ship it.
    if (!gov.suppressOverseer && agents[reply.agent]?.runtime.overseer?.enabled) {
      const v = await overseer.intercept(reply.agent, reply.chatId, reply.text)
      if (!v.forward) return
      if (v.footer) reply.text = `${reply.text}\n\n${v.footer}`
    }
    if (!gov.forward) return                 // governor swallowed it (handoff captured)
    if (gov.footer) reply.text = `${reply.text}\n\n${gov.footer}`
    messageCache.record(reply.chatId, {
      role: "agent", text: reply.text, ts: Date.now(), agent: reply.agent,
    })
    convActivity.set(reply.chatId, Date.now())
  }
  await gateway.sendReply(reply, agents[reply.agent])
}

// Monotonic job-id counter for spawn triggers (Math.random forbidden).
let jobCounter = 0
const nextJobId = (): string => `job-${++jobCounter}`

/** Interpolate $1,$2… (regex capture groups) and $jobId into a template. */
function interpolate(tmpl: string, groups: string[], jobId: string): string {
  return tmpl.replace(/\$(\d+|jobId)/g, (_, tok: string) => {
    if (tok === "jobId") return jobId
    return groups[Number(tok)] ?? ""
  })
}

/** Build the handoff CardSpec from a SpawnCardUpdate, interpolating $1,$2,$jobId. */
function buildSpawnCard(s: SpawnCardUpdate, groups: string[], jobId: string): CardSpec {
  return {
    title: interpolate(s.title, groups, jobId),
    body: interpolate(s.body, groups, jobId),
    buttons: s.buttons.map((b) => ({
      ...b,
      customId: interpolate(b.customId, groups, jobId),
      label: interpolate(b.label, groups, jobId),
    })),
  }
}

/** Tear down a spawned worker once its process has exited, then run teardownCommand. */
function scheduleTeardown(jobId: string, t: StreamJsonTransport, teardownCmd: () => string | undefined): void {
  const tick = setInterval(() => {
    if (!t.isAvailable()) {
      clearInterval(tick)
      void t.close()
      transports.delete(jobId)
      statusRegistry.removeEphemeral(jobId)
      const cmd = teardownCmd()
      if (cmd) void Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit" }).exited
    }
  }, 10_000)
  tick.unref()
}

/** Spawn an ephemeral agent (a full stream-json session) to run a task, optionally
 *  after a setup shell command, and clean up when it exits. */
async function runSpawnTrigger(trig: SpawnTrigger, groups: string[], chatId: string, parent: string): Promise<void> {
  const cfg = agents[trig.agent]
  if (!cfg) { process.stderr.write(`spawn-trigger: agent "${trig.agent}" not found\n`); return }
  const jobId = nextJobId()
  // Paint the card to its handoff state BEFORE the (slow) setupCommand so the
  // operator sees "working" immediately, not after the worktree checkout.
  const paintSpawnCard = (card: CardSpec): Promise<void> => {
    if (!trig.onSpawnCard) return Promise.resolve()
    const corr = interpolate(trig.onSpawnCard.correlationId, groups, jobId)
    return cardLifecycle.onUpdate(corr, chatId, card, jobId)
  }
  if (trig.onSpawnCard) await paintSpawnCard(buildSpawnCard(trig.onSpawnCard, groups, jobId))
  if (trig.setupCommand) {
    const code = await Bun.spawn(["sh", "-c", interpolate(trig.setupCommand, groups, jobId)],
      { stdout: "inherit", stderr: "inherit" }).exited
    if (code !== 0) {
      process.stderr.write(`spawn-trigger: setupCommand exited ${code}; aborting\n`)
      await paintSpawnCard({ title: "⚠️ Could not start", body: `Setup failed (job ${jobId}); see hub logs.`, buttons: [] })
      return
    }
  }
  const t = makeTransport(trig.agent, jobId, cfg)
  await t.start()
  t.deliver(jobId, {
    chatId, messageId: `spawn:${jobId}`, userId: "system", user: "hub",
    content: interpolate(trig.taskTemplate, groups, jobId), ts: new Date().toISOString(), isDM: false,
  })
  statusRegistry.setEphemeral({ jobId, agent: trig.agent, task: interpolate(trig.taskTemplate, groups, jobId), startedAt: Date.now() })
  if (!auditOptedOut(parent)) audit.record({
    kind: "spawn", actor: `agent:${parent}`, action: "spawn", target: trig.agent, chat: chatId, detail: { jobId },
  })
  // The matched trigger text is consumed (not shown); confirm the spawn to the channel.
  if (!trig.onSpawnCard) void gateway.sendPlain(chatId, `🔧 \`${trig.agent}\` agent dispatched (job ${jobId}).`)
  scheduleTeardown(jobId, t, () => (trig.teardownCommand ? interpolate(trig.teardownCommand, groups, jobId) : undefined))
}

// Persistent agents: spawn at boot; they receive webhook/schedule/command/interaction deliveries.
// A `pool` policy backs the agent with a ReplicaPool that scales out under load;
// without one it's a single transport exactly as before.
const dispatchTransports: AgentTransport[] = []
const pools = new Map<string, ReplicaPool>()
for (const [name, cfg] of Object.entries(agents)) {
  if (cfg.mode !== "persistent") continue
  const primary = makeTransport(name, name, cfg)
  await primary.start()
  const pol = cfg.runtime.pool
  if (pol) {
    const pool = new ReplicaPool(name, primary, {
      min: pol.min ?? 1, max: pol.max ?? 3,
      scaleUpQueue: pol.scaleUpQueue ?? 2, scaleUpSustainMs: pol.scaleUpSustainMs ?? 30_000,
      replicaIdleMs: pol.replicaIdleMs ?? 600_000,
      spawn: async (replicaKey) => { const t = makeTransport(name, replicaKey, cfg); await t.start(); return t },
    })
    pools.set(name, pool)
    dispatchTransports.push(pool)
  } else {
    dispatchTransports.push(primary)
  }
}
const dispatcher = new Dispatcher(dispatchTransports)
// Scaling monitor: each pool periodically checks load and scales replicas.
if (pools.size) {
  setInterval(() => { for (const p of pools.values()) void p.tick() }, 10_000).unref()
}
// Dispatcher's constructor re-binds each transport's onReply to its own aggregator,
// so route that aggregator back to onAgentReply. For persistent agents the routing
// key is the agent name (== reply.agent). (Ephemeral spawn transports are not in the
// Dispatcher and keep the onReply set in makeTransport, keyed by jobId.)
dispatcher.onReply((reply) => { void onAgentReply(reply, reply.agent) })

/** Clear a persistent agent's context: drop its session file + respawn fresh.
 *  `reason` distinguishes a manual reset from a governor auto-compaction. */
async function resetAgentSession(name: string, channelId: string, reason = "manual"): Promise<void> {
  const cfg = agents[name]
  if (!cfg) return
  try { unlinkSync(join(hub.stateDir, `${name}.session`)) } catch {}
  const old = transports.get(name)
  if (old) { await old.close(); transports.delete(name) }
  const fresh = makeTransport(name, name, cfg)   // resumable, but the session file is now gone → fresh session
  await fresh.start()
  dispatcher.replace(name, fresh)
  if (!auditOptedOut(name)) audit.record({
    kind: "session", actor: "hub", action: "reset", target: name, chat: channelId, detail: { reason },
  })
  void gateway.sendPlain(channelId, "🧹 context cleared — fresh session.")
}

/** Deliver a synthesised system inbound to an agent scoped to a channel. */
function deliverToAgent(agentName: string, channelId: string, idTag: string, content: string): void {
  const ok = dispatcher.dispatch(agentName, channelId, {
    chatId: channelId, messageId: idTag, userId: "system", user: "hub",
    content, ts: new Date().toISOString(), isDM: false,
  })
  if (!ok) process.stderr.write(`deliver: agent "${agentName}" unavailable; skipping\n`)
}

// Overseer: the "keep prodding until done" loop for opt-in agents. Nudges are
// delivered back to the agent as a synthesized system message (bypassing routing).
const overseer = new Overseer({
  run: makeRouterRunner(),
  defaultModel: hub.overseerModel ?? hub.routerModel,
  policyFor: (agent) => agents[agent]?.runtime.overseer,
  deliverNudge: (agent, convId, text) => deliverToAgent(agent, convId, "overseer:nudge", text),
  recentConversation: (convId) => messageCache.render(convId),
})

// Session governor: keep an opt-in agent's context bounded — nudge it to
// checkpoint to memory near the soft threshold, then auto-compact (handoff →
// resetAgentSession → reseed) near the hard one. Reuses the existing reset.
const governor = new SessionGovernor({
  policyFor: (agent) => agents[agent]?.runtime.sessionGovernor,
  windowFor: (agent) => contextWindow(agents[agent]?.runtime.model, hub.contextWindows),
  deliver: (agent, convId, text) => {
    if (!auditOptedOut(agent)) audit.record({ kind: "session", actor: "hub", action: "checkpoint", target: agent, chat: convId })
    deliverToAgent(agent, convId, "governor:checkpoint", text)
  },
  notify: (convId, text) => { void gateway.sendPlain(convId, text) },
  reset: (agent, convId) => resetAgentSession(agent, convId, "compact"),
  recordHandoff: (agent, convId, summary) =>
    messageCache.record(convId, { role: "agent", text: summary, ts: Date.now(), agent }),
})

// Live status board: one self-editing embed in `statusChannelId` showing every
// persistent agent (alive/busy/context%/queue/cost), what the overseer/governor
// is doing, the router's recent picks, and live ephemeral agents. Read-only.
const statusRegistry = new StatusRegistry()
const boardThrottle = new Throttle(5_000)   // ≤1 Discord edit per 5s
let boardMsgId: string | undefined
let boardSnapshotPending = false
async function flushBoard(): Promise<void> {
  if (!hub.statusChannelId) return
  const card = renderBoard(statusRegistry.snapshot(Date.now()))
  if (boardMsgId == null) boardMsgId = await gateway.sendCard(hub.statusChannelId, card)
  else await gateway.editCard(hub.statusChannelId, boardMsgId, card)
}
function requestBoardUpdate(): void {
  if (!hub.statusChannelId) return
  const { emit, scheduleInMs } = boardThrottle.request(Date.now())
  if (emit) void flushBoard()
  else if (scheduleInMs != null && !boardSnapshotPending) {
    boardSnapshotPending = true
    setTimeout(() => {
      boardSnapshotPending = false
      boardThrottle.fire(Date.now())
      void flushBoard()
    }, scheduleInMs).unref()
  }
}
function buildAgentRows(): AgentStatus[] {
  const rows: AgentStatus[] = []
  for (const [name, cfg] of Object.entries(agents)) {
    if (cfg.mode !== "persistent") continue
    const pool = pools.get(name)
    const src = pool ?? transports.get(name)   // pool aggregates across replicas
    rows.push({
      name, emoji: cfg.emoji, mode: "persistent",
      alive: src?.isAvailable() ?? false,
      busy: src?.isBusy() ?? false,
      queueDepth: src?.queueDepth() ?? 0,
      fillPct: src?.fillPct(hub.contextWindows) ?? 0,
      costUsd: src?.lastUsageInfo()?.costUsd,
      replicas: pool?.replicaCount(),
      lastActivityMs: src?.lastActivityMs() ?? 0,
    })
  }
  return rows
}
function buildOverseerRows(): OverseerStatus[] {
  const prodding = overseer.snapshot().map((o): OverseerStatus => ({
    agent: o.agent, goal: o.goal, round: o.iterations,
    max: agents[o.agent]?.runtime.overseer?.maxIterations ?? 4, state: "prodding",
  }))
  const compacting = governor.activeCompactions().map((c): OverseerStatus => ({
    agent: c.agent, goal: "", round: 0, max: 0, state: "compacting",
  }))
  return [...prodding, ...compacting]
}
if (hub.statusChannelId) {
  const refresh = hub.statusRefreshMs ?? 15_000
  setInterval(() => {
    statusRegistry.setAgents(buildAgentRows())
    statusRegistry.setOverseers(buildOverseerRows())
    requestBoardUpdate()
  }, refresh).unref()
  setTimeout(() => { statusRegistry.setAgents(buildAgentRows()); requestBoardUpdate() }, 2_000).unref()
}

const baseGate = new BaseGate(join(hub.stateDir, "access.json"))

// Only allowlisted users may press card buttons.
gateway.setPermissionAuthorizer((uid) => baseGate.listAllowed().includes(uid))

// A card button was clicked → gated actions run hub-side; others relay to the agent.
gateway.onNotifyButton((customId, userId) => {
  const ap = parseApprovalCustomId(customId)
  if (ap) { void resolveApproval(ap.id, ap.decision, userId); return }
  const action = matchGatedAction(customId, hub.gatedActions ?? [])
  if (action) { void cardLifecycle.runGated(action, customId); return }
  const key = notifyRouter.agentFor(customId)
  if (key) transports.get(key)?.sendInteraction(customId, userId)
})

gateway.onModalSubmit((customId, userId, fields) => {
  const key = notifyRouter.agentFor(customId)
  if (key) transports.get(key)?.sendInteraction(customId, userId, fields)
})

gateway.onReaction((emojiName, userId, channelId /* , messageId */) => {
  if (!baseGate.listAllowed().includes(userId)) return
  const agentName = clearReactionAgent(channelId, emojiName, hub.channelAgents ?? [])
  if (agentName) void resetAgentSession(agentName, channelId)
})

// Webhooks: one HTTP listener; each route HMAC-verifies and delivers "{prefix} {body}".
const webhookHandlers: WebhookHandler[] = (hub.webhooks ?? []).map((w) => ({
  path: w.path,
  secret: process.env[w.secretEnv] ?? "",
  onBody: (rawBody: string) => {
    const content = w.prefix ? `${w.prefix} ${rawBody}` : rawBody
    deliverToAgent(w.agent, w.channelId, `webhook:${w.path}`, content)
  },
}))
const listener = startWebhookListener(hub.webhookPort ?? 0, webhookHandlers)
void listener

// Schedules: 1-minute tick evaluating each entry's cron (timezone-aware,
// default Europe/London) or legacy daily hourUtc. Dedupe is persisted per job
// per UTC minute in cron-state.json (atomic write), so a restart within the
// same minute never double-fires.
const cronState = new CronState(join(hub.stateDir, "cron-state.json"))
const cronTick = startCron(hub.schedules ?? [], hub.timezone ?? "Europe/London", {
  deliver: (agent, channelId, idTag, message) => {
    deliverToAgent(agent, channelId, idTag, message)
    emitHubEvent("schedule.fired", { id: idTag, agent, channelId })
  },
  state: cronState,
  onInvalid: (id, expr) => process.stderr.write(`schedule "${id}": invalid cron "${expr}"\n`),
})
cronTick.unref()

// Idle backstop: close any ephemeral (spawned) transport with no activity for
// ephemeralTimeoutMs — guards against an agent that neither finishes nor is
// actioned. Persistent agents (keyed by name) are never reaped here.
setInterval(() => {
  const now = Date.now()
  for (const [key, t] of transports) {
    if (agents[t.name]?.mode === "ephemeral" && now - t.lastActivityMs() > hub.ephemeralTimeoutMs) {
      void t.close()
      transports.delete(key)
    }
  }
}, 60_000).unref()

// Background distiller: sweep for conversations idle past distillIdleMs and turn
// their recent cache into memory notes — once per idle period (until new activity).
const DISTILL_IDLE_MS = hub.distillIdleMs ?? 600_000
setInterval(() => {
  const now = Date.now()
  for (const [convId, ts] of convActivity) {
    if (now - ts < DISTILL_IDLE_MS) continue
    if ((distilledAt.get(convId) ?? 0) >= ts) continue   // already distilled this idle period
    distilledAt.set(convId, now)
    void runDistill(convId).catch((e) => process.stderr.write(`distill: ${e}\n`))
  }
}, 60_000).unref()

// Periodic vault gardener: whole-vault dedup, staleness flags, budgeted archival.
if (garden.enabled) {
  const gardener = new Gardener({
    store: memoryStore, index: vectorIndex, access: accessStore,
    dedupe: (note) => memoryRetriever.dedupe(note),
    staleAfterMs: garden.staleAfterMs, archiveAfterMs: garden.archiveAfterMs, scopeBudget: garden.scopeBudget,
  })
  const runGarden = () => gardener.run().then((r) => {
    if (r.merged.length || r.archived.length || r.stale.length || r.flaggedDups.length) {
      process.stderr.write(`gardener: merged=${r.merged.length} archived=${r.archived.length} stale=${r.stale.length} flagged=${r.flaggedDups.length}\n`)
    }
    for (const f of r.flaggedDups) {
      try { appendFileSync(join(memoryDir, ".dedup-review.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...f }) + "\n") } catch {}
    }
  }).catch((e) => process.stderr.write(`gardener: ${e}\n`))
  setInterval(() => void runGarden(), garden.intervalMs ?? 6 * 60 * 60_000).unref()
}

const orchestrator = new Orchestrator(hub, agents, {
  baseGate: (userId, chatId, isDM) => {
    const r = baseGate.gate(userId, chatId, isDM, Date.now())
    if (r.action === "drop") audit.record({
      kind: "access", actor: `user:${userId}`, action: "deny", chat: chatId, outcome: "deny", detail: { isDM },
    })
    return r
  },
  resolvePermission: () => false,   // tool permissions handled by --dangerously-skip-permissions
  resolveRoles: (id) => gateway.resolveRoles(id),
  route: (msg, permitted, current) =>
    routeFn({ message: msg, permitted, current }, routerRunner, hub.routerModel),
  dispatch: (agent, key, inbound) => dispatcher.dispatch(agent, key, inbound),
  isAvailable: (agent) => dispatcher.isAvailable(agent),
  sendPlain: (chatId, text) => gateway.sendPlain(chatId, text),
  prepareDispatch: async ({ agent, inbound, isSwitch }) => {
    const rt = agents[agent]?.runtime
    // A genuine user-initiated turn (re)sets the overseer goal for this agent.
    if (rt?.overseer?.enabled) overseer.begin(agent, inbound.chatId, inbound.content)
    // Record the routing decision for the status board (the Haiku resolver's pick).
    statusRegistry.recordRoute({ ts: Date.now(), conv: inbound.chatId, chosen: agent, switched: isSwitch })
    if (!auditOptedOut(agent)) audit.record({
      kind: "route", actor: `user:${inbound.userId}`, action: "route",
      target: agent, chat: inbound.chatId, detail: { switched: isSwitch },
    })
    // Render context from PRIOR turns, then record this inbound so it's available
    // next turn (and to the distiller) without duplicating it in this turn's block.
    const policy = rt?.injectContext ?? "onSwitch"
    const wantContext = policy === "always" || (policy === "onSwitch" && isSwitch)
    const context = wantContext ? messageCache.render(inbound.chatId) : ""
    // Fold any quote-reply target into the live message so the agent sees it.
    let live = foldQuote(inbound.content, inbound.quote)
    // If the governor just compacted this agent's session, seed the fresh one
    // with the handoff so the first post-reset turn keeps continuity.
    const seed = governor.takeSeed(agent, inbound.chatId)
    if (seed) live = `[handoff from your previous session]\n${seed}\n\n${live}`
    let memory = ""
    if (rt?.useMemory) {
      const scopes: Scope[] = [
        "global", `users/${inbound.userId}`, `agents/${agent}`, `channels/${inbound.chatId}`,
      ]
      try { memory = (await memoryRetriever.relevant(live, scopes)).render } catch {}
    }
    messageCache.record(inbound.chatId, {
      role: "user", text: live, ts: Date.parse(inbound.ts) || Date.now(),
      user: inbound.user, userId: inbound.userId,
    })
    convActivity.set(inbound.chatId, Date.now())
    if (!context && !memory && live === inbound.content) return inbound
    return { ...inbound, content: enrich(live, { memory, context }) }
  },
})

// Direct commands (Tier B): a keyword runs shell/HTTP and formats the result —
// no model in the loop, unless formatAgent routes the raw result to an agent.
const directExecutor: DirectExecutor = async (spec, args) => {
  if (spec.type === "shell") {
    const proc = Bun.spawn(["sh", "-c", interpolateArgs(spec.command, args)], { stdout: "pipe", stderr: "pipe" })
    const text = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    return { text, json: tryJson(text) }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = interpolateArgs(v, args)
  if (spec.secretEnv && process.env[spec.secretEnv]) headers["authorization"] = `Bearer ${process.env[spec.secretEnv]}`
  const res = await fetch(interpolateArgs(spec.url, args), {
    method: spec.method ?? "GET", headers,
    body: spec.bodyTemplate ? interpolateArgs(spec.bodyTemplate, args) : undefined,
  })
  const text = await res.text()
  return { text, json: tryJson(text) }
}
function tryJson(t: string): any { try { return JSON.parse(t) } catch { return undefined } }

async function runDirectCommand(cmd: DirectCommand, args: string, chatId: string, userId: string): Promise<void> {
  let status: "ok" | "error" = "ok"
  try {
    const outcome = await runDirect(cmd, args, directExecutor)
    if (outcome.kind === "agent") deliverToAgent(outcome.agent, chatId, `direct:${cmd.match}`, outcome.content)
    else if (outcome.kind === "card") await gateway.sendCard(chatId, outcome.card)
    else await gateway.sendPlain(chatId, outcome.text || "(no output)")
  } catch (e) {
    status = "error"
    process.stderr.write(`directCommand: "${cmd.match}" failed: ${e}\n`)
    await gateway.sendPlain(chatId, `⚠️ \`${cmd.match}\` failed; see hub logs.`)
  }
  audit.record({ kind: "exec", actor: `user:${userId}`, action: "direct", target: cmd.match, chat: chatId, outcome: status })
}

// Commands: an inbound whose trimmed content equals `match` delivers `message`
// to agent@channel (gated by the base-gate allowlist if allowlistOnly).
const commands = hub.commands ?? []
const directCommands = hub.directCommands ?? []
gateway.handleInbound((m) => {
  const trimmed = m.content.trim()
  // Audit ledger query (operator-only): list recent governed effects or a rollup.
  // Workflows: list configured missions (operator-only).
  if (/^!workflows\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!hub.workflow?.enabled) { void gateway.sendPlain(m.chatId, "🧩 workflows are off (set `hub.workflow.enabled`)."); return }
    const list = (hub.workflows ?? []).filter((w) => w.enabled !== false)
    if (!list.length) { void gateway.sendPlain(m.chatId, "no workflows configured."); return }
    const lines = list.map((w) => `• \`${w.id}\` — ${w.description ?? `${w.steps.length} step(s)`}  (${w.steps.map((s) => s.agent).join(" → ")})`)
    void gateway.sendPlain(m.chatId, ["**workflows** (run with `!run <id> [input]`):", ...lines].join("\n"))
    return
  }
  // Run a workflow as a mission (operator-only).
  if (/^!run\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!hub.workflow?.enabled) { void gateway.sendPlain(m.chatId, "🧩 workflows are off (set `hub.workflow.enabled`)."); return }
    const rest = trimmed.replace(/^!run\b/i, "").trim()
    const sp = rest.indexOf(" ")
    const id = sp === -1 ? rest : rest.slice(0, sp)
    const input = sp === -1 ? "" : rest.slice(sp + 1).trim()
    if (!id) { void gateway.sendPlain(m.chatId, "usage: `!run <workflow-id> [input]`"); return }
    void runWorkflow(id, input, m.chatId, `user:${m.userId}`)
    return
  }
  if (/^!audit\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!hub.audit?.enabled) { void gateway.sendPlain(m.chatId, "📜 audit logging is off (set `hub.audit.enabled`)."); return }
    const q = parseAuditCommand(trimmed.replace(/^!audit\b/i, ""))
    if (q.summary) void gateway.sendPlain(m.chatId, renderAuditSummary(audit.summary(q.filter)))
    else void gateway.sendPlain(m.chatId, renderAuditLines(
      audit.recent({ ...q.filter, limit: q.filter.limit ?? 25 }),
      (ts) => new Date(ts).toISOString().slice(11, 19),
    ))
    return
  }
  // Replay (operator-only): reconstruct a conversation's (or one corr action's)
  // effect-chain from the ledger as a corr-grouped timeline.
  if (/^!replay\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!hub.audit?.enabled) { void gateway.sendPlain(m.chatId, "🧵 replay needs audit logging on (set `hub.audit.enabled`)."); return }
    const rest = trimmed.replace(/^!replay\b/i, "").trim()
    const sp = rest.indexOf(" ")
    const id = sp === -1 ? rest : rest.slice(0, sp)
    if (!id) { void gateway.sendPlain(m.chatId, "usage: `!replay <chat-id|corr-id> [scan]`"); return }
    // `scan` = how many recent ledger rows to read. An unfiltered recent() reads
    // exactly this many raw rows BEFORE buildReplay selects by chat/corr, so it
    // must be wide enough that a busy ledger doesn't bury the conversation.
    const parsed = sp === -1 ? NaN : parseInt(rest.slice(sp + 1), 10)
    const scan = Number.isFinite(parsed) ? Math.max(200, Math.min(20_000, parsed)) : 2_000
    const timeline = buildReplay(audit.recent({ limit: scan }), id)
    const out = renderReplay(timeline, (ts) => new Date(ts).toISOString().slice(11, 19))
    for (const chunk of chunkLines(out, 1_900)) void gateway.sendPlain(m.chatId, chunk)
    return
  }
  // Health rollup (operator-only): the same data /health serves, in chat.
  if (/^!metrics\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    const { body } = renderHealth(collectMetrics())
    const head = `**health: ${body.status}** · up ${Math.floor(body.uptimeSec / 60)}m · routes/10m ${body.routeRate10m} · pending approvals ${body.pendingApprovals}`
    const rows = body.agents.map((a) =>
      `${a.alive ? "🟢" : "🔴"} \`${a.name}\` ${a.busy ? "busy" : "idle"} · q${a.queueDepth} · ctx ${Math.round(a.contextFill * 100)}%`)
    void gateway.sendPlain(m.chatId, [head, ...rows].join("\n"))
    return
  }
  // On-demand status snapshot (operator-only): renders the live board here & now.
  if (/^!(status|usage|health)\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    statusRegistry.setAgents(buildAgentRows())
    statusRegistry.setOverseers(buildOverseerRows())
    void gateway.sendCard(m.chatId, renderBoard(statusRegistry.snapshot(Date.now())))
    return
  }
  const cmd = commands.find((c) => c.match === trimmed)
  if (cmd) {
    if (cmd.allowlistOnly && !baseGate.listAllowed().includes(m.userId)) return
    deliverToAgent(cmd.agent, cmd.channelId, `command:${cmd.match}`, cmd.message)
    void gateway.sendPlain(m.chatId, `✅ Command \`${cmd.match}\` triggered.`)
    return
  }
  const direct = matchDirectCommand(m.content, directCommands)
  if (direct) {
    if (direct.cmd.allowlistOnly && !baseGate.listAllowed().includes(m.userId)) return
    void runDirectCommand(direct.cmd, direct.args, m.chatId, m.userId)
    return
  }
  void orchestrator.handleMessage(m)
})
await gateway.start(token)
console.error("switchboard hub: gateway connected")

setInterval(() => {
  for (const { chatId } of drainApprovals(hub.stateDir)) {
    void gateway.sendPlain(chatId, "✅ Paired! You can talk to the agents now. Try `!agents`.")
  }
}, 5000).unref()

// Metrics & health: project the live status snapshot + audit summary onto a
// Prometheus /metrics scrape and a /health probe (and the !metrics command).
// Off unless metricsPort is set. Serves only aggregated, non-secret numbers.
function collectMetrics(): MetricsInput {
  statusRegistry.setAgents(buildAgentRows())
  statusRegistry.setOverseers(buildOverseerRows())
  const now = Date.now()
  return {
    now, startedAt,
    status: statusRegistry.snapshot(now),
    audit: audit.summary({}),
    pendingApprovals: approvalRegistry.pendingCount(),
  }
}
const metricsServer = startMetricsServer(hub.metricsPort ?? 0, collectMetrics, hub.metricsHost)
if (metricsServer) console.error(`switchboard hub: metrics/health on ${hub.metricsHost ?? "127.0.0.1"}:${hub.metricsPort}`)

// Read-only web dashboard: the same data, plus a recent-activity feed, as a page
// on webPort. Off unless webPort is set. Serves only aggregated, non-secret data.
function collectWeb(): WebInput {
  return { ...collectMetrics(), recent: audit.recent({ limit: 30 }) }
}
const webServer = startWebServer(hub.webPort ?? 0, collectWeb, hub.webHost)
if (webServer) console.error(`switchboard hub: web dashboard on ${hub.webHost ?? "127.0.0.1"}:${hub.webPort}`)

// Auto-deny pending approvals past their TTL: edit the card to "Expired" and
// audit the lapse. The held effect never fires (fail-closed).
if (approvalsEnabled) {
  setInterval(() => {
    for (const e of approvalRegistry.sweepExpired()) {
      audit.record({ kind: "approval", actor: "hub", action: "expire", target: e.target, chat: e.chat, outcome: "deny", corr: e.id })
      const loc = approvalCards.get(e.id); approvalCards.delete(e.id)
      if (loc) void gateway.editCard(loc.chatId, loc.messageId, renderApprovalCard(e))
    }
  }, 60_000).unref()
}

// Time out consults whose target never answered: resolve the caller's tool call
// with a note and audit the lapse.
if (hub.consult?.enabled) {
  setInterval(() => {
    for (const e of consultRegistry.sweepExpired()) {
      e.resolve(`(agent "${e.target}" did not respond in time)`)
      audit.record({ kind: "consult", actor: "hub", action: "timeout", target: e.requester, outcome: "error", corr: e.id })
    }
  }, 10_000).unref()
}
