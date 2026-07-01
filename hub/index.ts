import { join, dirname } from "path"
import { unlinkSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync, readdirSync, rmSync } from "fs"
import { config as loadEnv } from "./env"
import { loadConfigs } from "./config"
import { escalatedRuntime, countErrors, RateCap } from "./escalation"
import { planReload } from "./configReload"
import { classifyAgentChange, invalidAgentConfigShape, type AgentChangeClassification } from "./agentConfigDraft"
import { AgentConfigPreviewRegistry } from "./agentConfigPreview"
import { BaseGate } from "./baseGate"
import { Gateway, parseNotifyCustomId } from "./gateway"
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
import { enrich, foldQuote, foldAttachments, foldForward } from "./enrich"
import { materializeAttachments } from "./attachments"
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "fs/promises"
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
import { ToolUsageRegistry } from "./toolUsageRegistry"
import { renderToolBoard } from "./toolBoard"
import { matchDirectCommand, runDirect, interpolateArgs, type DirectExecutor } from "./directCommands"
import { OutboundDelivery } from "./outboundDelivery"
import { matchOutbound, renderBody } from "./outbound"
import { AuditLog } from "./auditLog"
import { parseJsonlTail, shouldRotate, rotationsToPrune } from "./audit"
import { TurnTrace, parseTraceTail, renderTrace, type TraceFilter, type TraceRecord } from "./turnTrace"
import { sweepTrace } from "./traceSweep"
import { runDoctor, renderDoctor, type DoctorFacts } from "./doctor"
import { buildReplay, renderReplay, chunkLines } from "./replay"
import { ApprovalRegistry, renderApprovalCard, parseApprovalCustomId, type ApprovalRequest, type ApprovalDecision, type ApprovalFire } from "./approval"
import { startMetricsServer } from "./metricsServer"
import { renderHealth, type MetricsInput } from "./metrics"
import { startWebServer } from "./webServer"
import { type WebInput } from "./web"
import { ChannelStream, type ChannelEvent } from "./channelStream"
import { pendingApprovalsToJson, buildWebInboundMessage, formatMirrorLine } from "./webActions"
import { buildAuditText, buildToolsText } from "./commandActions"
import type { WebDeps, ChannelInfo } from "./webServer"
import { ConsultRegistry, mayConsult, consultAnswerFromReply } from "./consult"
import { MissionRegistry, findWorkflow, renderStepPrompt, renderMissionCard, type MissionRun } from "./workflow"
import type { AgentConfig, AgentReply, InboundMessage, SpawnTrigger, SpawnCardUpdate, CardSpec, DirectCommand, OutboundRoute, HubConfig, AgentRegistry, SendOutcome } from "./types"
import { resolveOutboxFile } from "./outboxAttach"
import { makeAttachHandler } from "./attachHandler"
import { publishArtifact } from "./publishLink"
import { selectExpired } from "./publishCleanup"
import { randomBytes, randomUUID } from "crypto"
import { MemoryBrowse } from "./memoryBrowse"
import { BrowseSessions } from "./memoryBrowseSessions"
import { renderListCard, renderDetailCard, renderConfirmCard, parseMemArg, type NoteSummary } from "./memoryCard"
import { parseTarget, resolvePeer, peerSecret, PeerDedupe, PeerRateLimiter, type PeerEnvelope } from "./peering"
import { postPeer } from "./peerClient"
import { PeerSpool, type SpoolItem } from "./peerSpool"
import { LiaisonLog } from "./liaisonLog"
import { handlePeerRequest, type PeerRouteDeps } from "./peerRoutes"

const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const AGENTS_JSON_PATH = join(CONFIG_DIR, "agents.json")
const { hub, agents } = loadConfigs(CONFIG_DIR)

/** Read config/agents.json fresh, in its raw on-disk shape — NOT loadConfigs
 *  (which also reads hub.config.json, validates the whole registry, and expands
 *  `~` in every cwd). Phase 3 works with the raw shape end to end so an edit
 *  round-trips exactly: GET returns what's on disk, POST writes back what was
 *  typed, no expansion mismatch ever appears in a diff. */
function readAgentsJson(): AgentRegistry {
  return JSON.parse(readFileSync(AGENTS_JSON_PATH, "utf8")) as AgentRegistry
}

/** Atomically write the full agent registry back to config/agents.json
 *  (temp-file-then-rename, matching the pattern already used for trace.jsonl's
 *  sweep rewrite). */
function writeAgentsJson(registry: AgentRegistry): void {
  const tmp = `${AGENTS_JSON_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(registry, null, 2))
  renameSync(tmp, AGENTS_JSON_PATH)
}

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

const memBrowseOn = hub.memoryBrowse?.enabled === true
const memOperators = (hub.memoryBrowse?.operatorIds?.length ? hub.memoryBrowse.operatorIds
  : (hub.deployApproverUserId ? [hub.deployApproverUserId] : []))
const isMemOperator = (uid: string) => memOperators.includes(uid)
const toSummary = (n: { path: string; scope: string; title: string; tags: string[]; source: string; updated: string }): NoteSummary =>
  ({ path: n.path, scope: n.scope, title: n.title, tags: n.tags, source: n.source, updated: n.updated })
const memSessions = new BrowseSessions()
const PAGE = 5
const memBrowse = new MemoryBrowse({
  list: (scopes) => memoryStore.list(scopes as any).map(toSummary),
  readBody: (path) => { try { return memoryStore.read(path).body } catch { return "" } },
  exists: (path) => { try { memoryStore.read(path); return true } catch { return false } },
  archive: (path) => { try { memoryStore.archive(path); return true } catch (e) { process.stderr.write(`memory-browse archive: ${e}\n`); return false } },
  remove: (path) => memoryStore.remove(path),
  deindex: (path) => { void Promise.resolve(vectorIndex.remove(path)).catch(() => {}) },
  audit: (action, actor, detail) => audit.record({ kind: "event", actor: `user:${actor}`, action, outcome: "ok", detail }),
})

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

// Virtual consult channels currently in the retry loop — their overflow events are
// suppressed so the retry loop owns the settle lifecycle.
const retryingConsults = new Set<string>()

/** Retry consult delivery every 15 s for up to 2 min.
 *  After 60 s, posts a "waiting" notice to the requester's Discord channel.
 *  After 2 min, spawns an ephemeral one-shot clone of the target to answer.  */
async function runConsultRetry(
  targetName: string,
  virtualChannel: string,
  inbound: InboundMessage,
  discordCh: string,
  settle: (answer: string) => void,
  isSettled: () => boolean,
): Promise<void> {
  const RETRY_MS = 15_000
  const NOTIFY_AFTER_MS = 60_000
  const CLONE_AFTER_MS = 120_000
  const started = Date.now()
  let notified = false
  try {
    while (!isSettled()) {
      await Bun.sleep(RETRY_MS)
      if (isSettled()) break
      const elapsed = Date.now() - started
      // After 60 s, post a one-time notice so the user isn't left wondering.
      if (!notified && elapsed >= NOTIFY_AFTER_MS && discordCh) {
        notified = true
        const emoji = agents[targetName]?.emoji ?? ""
        void gateway.sendPlain(
          discordCh,
          `${emoji} Waiting for **${targetName}** to finish its current turn — I'll continue once it responds.`,
        )
      }
      // After 2 min, spin up a one-shot clone that answers from scratch.
      if (elapsed >= CLONE_AFTER_MS) {
        const answer = await spawnConsultClone(targetName, inbound.content)
        settle(answer)
        break
      }
      // Try delivery again; if the target is still busy the overflow handler is
      // suppressed (retryingConsults), so we just loop and try again next tick.
      dispatcher.dispatch(targetName, virtualChannel, inbound)
    }
  } finally {
    retryingConsults.delete(virtualChannel)
  }
}

/** Spawn a one-shot ephemeral clone of `targetName` to handle a single consult
 *  question. The clone starts with a fresh session (no --resume, no memory
 *  injection) and exits after the first reply. */
async function spawnConsultClone(targetName: string, question: string): Promise<string> {
  const cfg = agents[targetName]
  if (!cfg) return `(agent "${targetName}" not found for clone)`
  const cloneKey = `consult-clone-${targetName}-${Date.now()}`
  const cloneCfg: AgentConfig = {
    ...cfg,
    mode: "ephemeral" as const,
    runtime: { ...cfg.runtime, resumable: false, useMemory: false, injectContext: undefined },
  }
  const t = makeTransport(targetName, cloneKey, cloneCfg)
  return new Promise<string>((resolve) => {
    let done = false
    const finish = (answer: string) => {
      if (done) return
      done = true
      void t.close()
      transports.delete(cloneKey)
      resolve(answer)
    }
    // Override the onReply set by makeTransport so the reply doesn't reach Discord.
    t.onReply((reply) => {
      if (reply.kind === "reply") finish(reply.text ?? "(no response from clone)")
      else if (reply.kind === "card") finish(reply.card?.body ?? "(card response from clone)")
    })
    setTimeout(() => finish(`(${targetName} clone timed out)`), 90_000).unref()
    void t.start().then(() => {
      t.deliver(cloneKey, {
        chatId: cloneKey, messageId: "clone-0", userId: "system", user: "hub",
        content: question, ts: new Date().toISOString(), isDM: false,
      })
    })
  })
}

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
    // Exact-title fallback: find notes whose title matches the query string directly,
    // without needing the embedder. Runs when vector search returns nothing or fails —
    // critical on first boot before the embedding model has been indexed.
    function byTitle(): { title: string; body: string }[] {
      try {
        return memoryStore.list(sc)
          .filter((n) => n.title.toLowerCase() === query.toLowerCase())
          .flatMap((n) => {
            try {
              const path = memoryStore.notePath(n.scope as Scope, n.title)
              const note = memoryStore.read(path)
              return [{ title: note.title, body: note.body }]
            } catch { return [] }
          })
      } catch { return [] }
    }
    try {
      const result = await memoryRetriever.relevant(query, sc)
      const notes = result.notes.map((n) => ({ title: n.title, body: n.body }))
      return notes.length > 0 ? notes : byTitle()
    }
    catch { return byTitle() }
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
    // Wrap resolveAnswer so the retry loop can tell when the consult has been settled
    // by external means (e.g. the target finished its current turn and answered).
    let consultSettled = false
    const settle = (answer: string) => {
      if (consultSettled) return
      consultSettled = true
      resolveAnswer(answer)
    }
    const e = consultRegistry.open(requester, targetName, settle)
    audit.record({ kind: "consult", actor: `agent:${requester}`, action: "ask", target: targetName, chat: e.channel, outcome: "ok", corr: e.id })
    const inbound: InboundMessage = { chatId: e.channel, messageId: `consult:${requester}`, userId: "system", user: "hub",
      content: message, ts: new Date().toISOString(), isDM: false }
    // Try immediate delivery if target is free; otherwise start the retry loop.
    const target = pools.get(targetName) ?? transports.get(targetName)
    if (!target?.isAvailable()) {
      // Agent is completely down — no point retrying; settle immediately.
      settle(`(agent "${targetName}" is unavailable)`)
      return
    }
    if (!target.isBusy()) {
      // Agent is free — deliver directly (no retry needed).
      dispatcher.dispatch(targetName, e.channel, inbound)
      return
    }
    // Agent is alive but busy — start the retry loop.
    // Retrieve the requester's active Discord channel now — safe because this
    // handler only fires mid-turn, so the transport is live and lastChatId is set.
    const discordCh = transports.get(key)?.getLastChatId() ?? ""
    retryingConsults.add(e.channel)
    void runConsultRetry(targetName, e.channel, inbound, discordCh, settle, () => consultSettled)
  }))
  // Outbound peer notify: queue + spool. Fire-and-forget from the agent's view.
  socket.onNotifyPeer(({ target, text }) => {
    if (!peeringOn || !peering) return
    const parsed = parseTarget(target)
    if (!parsed || !resolvePeer(peering, parsed.peer)) {
      audit.record({ kind: "liaison", actor: `agent:${name}`, action: "notify", target, outcome: "deny" })
      return
    }
    const body: PeerEnvelope = { from: peering.selfName, to: target, corrId: randomUUID(), kind: "notify", text, ts: Date.now() }
    audit.record({ kind: "liaison", actor: `agent:${name}`, action: "notify", target, outcome: "ok", corr: body.corrId, detail: { dir: "out", bytes: Buffer.byteLength(text) } })
    liaison.write({ dir: "out", kind: "notify", corrId: body.corrId, peer: parsed.peer, localAgent: name, remoteAgent: parsed.agent, text, ok: true })
    liaisonMirror(`↗ ${name} → ${target}: notify`)
    peerSpool.enqueue(target, body)
    persistSpool()
  })
  // Outbound peer ask: open a pending entry, POST /peer/ask, await /peer/reply.
  socket.onAskPeer(({ target, message }) => new Promise<string>((resolveAnswer) => {
    if (!peeringOn || !peering) { resolveAnswer("(peering disabled)"); return }
    const parsed = parseTarget(target)
    const def = parsed ? resolvePeer(peering, parsed.peer) : undefined
    const secret = parsed ? secretForPeer(parsed.peer) : undefined
    if (!parsed || !def || !secret) { resolveAnswer(`(unknown peer in "${target}")`); return }
    const corrId = randomUUID()
    const e = peerAskRegistry.open(name, target, resolveAnswer)
    peerAskByCorr.set(corrId, e.channel)
    audit.record({ kind: "liaison", actor: `agent:${name}`, action: "ask", target, outcome: "pending", corr: corrId, detail: { dir: "out", bytes: Buffer.byteLength(message) } })
    liaison.write({ dir: "out", kind: "ask", corrId, peer: parsed.peer, localAgent: name, remoteAgent: parsed.agent, text: message, ok: true })
    liaisonMirror(`↗ ${name} → ${target}: ask`)
    const body: PeerEnvelope = { from: peering.selfName, to: target, corrId, kind: "ask", text: message, ts: Date.now(), replyTo: `${peering.selfBaseUrl}${peering.listenPath ?? "/peer"}/reply` }
    void postPeer(peering.selfName, def, secret, `${peering.listenPath ?? "/peer"}/ask`, body, realFetch).then((r) => {
      if (!r.ok) { peerAskByCorr.delete(corrId); peerAskRegistry.settle(e.channel, `(peer unreachable: ${r.status})`) }
    })
  }))
  // Agent-initiated outbound file attachment. Disabled ⇒ handler ignores the
  // frame (double-gate alongside the tool not being listed). The agent identity
  // is this transport's `name`, never taken from the frame.
  const oa = hub.outboundAttachments
  socket.onAttach(makeAttachHandler({
    enabled: !!oa?.enabled,
    resolve: (relPath) => resolveOutboxFile(relPath, {
      outboxBase: oa?.outboxDir ?? join(hub.stateDir, "outbox"),
      agent: name,
      maxBytes: oa?.maxBytes ?? 8_388_608,
      allowedExtensions: (oa?.allowedExtensions ?? []).map((e) => e.toLowerCase()),
    }),
    sendFiles: (chatId, attachments, caption) => gateway.sendFiles(chatId, attachments, caption),
    note: (chatId, text) => void gateway.sendPlain(chatId, text),
    audit: (ok, chatId, detail) => {
      if (!auditOptedOut(name)) audit.record({
        kind: "event", actor: `agent:${name}`, action: "attach",
        chat: chatId, outcome: ok ? "ok" : "deny", detail,
      })
    },
  }))
  if (shareLinksOn) {
    socket.onPublish(async (a) => {
      const io = {
        mkdir: (d: string) => mkdirSync(d, { recursive: true }),
        writeFile: (p: string, data: Buffer | string) => writeFileSync(p, data),
        rename: (f: string, t: string) => renameSync(f, t),
      }
      const r = publishArtifact(a, {
        artifactsDir: shareArtifactsDir, raHost: hub.shareLinks?.raHost ?? "readyapp.player-ready.co.uk",
        agent: name, outboxBase: shareOutboxBase, maxBytes: hub.shareLinks?.maxBytes ?? 26_214_400,
        defaultTtlDays: hub.shareLinks?.defaultTtlDays ?? 30, now: new Date(), randomToken: () => base62(randomBytes(16)),
      }, io)
      if (!auditOptedOut(name)) audit.record({ kind: "event", actor: `agent:${name}`, action: "publish_link", outcome: r.ok ? "ok" : "deny", detail: r.ok ? { token: r.token } : { reason: r.reason } })
      return r.ok ? { url: r.url } : { error: r.reason }
    })
  }
  const t = new StreamJsonTransport(name, cfg, {
    spawner,
    socket,
    shimPath: SHIM_PATH,
    socketPath,
    mcpConfigPath: join(hub.stateDir, `${key}.mcp.json`),
    resumable: cfg.runtime.resumable === true,
    sessionPath: join(hub.stateDir, `${key}.session`),
    consultEnabled: !!hub.consult?.enabled,
    attachEnabled: !!hub.outboundAttachments?.enabled,
    publishEnabled: shareLinksOn,
    peeringEnabled: peeringOn,
    receiptsEnabled: !!hub.receipts?.enabled,
    onOverflow: (inbound) => {
      // Consults in the retry loop own their own retry/settle lifecycle — don't
      // short-circuit them here, just drop the overflow silently.
      if (consultRegistry.isConsultChannel(inbound.chatId)) {
        if (!retryingConsults.has(inbound.chatId))
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
  t.onReply((reply) => onAgentReply(reply, key))
  t.onToolUse((tools) => {
    const chat = lastChatByAgent.get(name) ?? ""
    trace.record({ agent: name, chat, kind: "tool_use", tools })
    if (chat) channelStream.publish(chat, { kind: "tool_use", ts: Date.now(), agent: name, tools })
    if (toolObs) toolUsage.recordToolUse(name, tools)
  })
  t.onToolResult((results) => {
    const chat = lastChatByAgent.get(name) ?? ""
    trace.record({ agent: name, chat, kind: "tool_result", results })
    if (chat) channelStream.publish(chat, { kind: "tool_result", ts: Date.now(), agent: name, results })
    // Auto-escalation signal: tally this turn's tool errors (per transport key so a
    // consult/escalation clone can't pollute the real agent's count).
    if (escalationOn && escCfg?.auto) turnErrors.set(key, (turnErrors.get(key) ?? 0) + countErrors(results))
    if (toolObs) toolUsage.recordToolResult(results)
  })
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

// Full-fidelity per-turn trace (message bodies), separate from the metadata-only
// AuditLog. Default off; when on, appends JSONL to <stateDir>/trace.jsonl. A no-op
// (never throws, nothing written) when disabled. Records the last chat per agent so
// tool_use/tool_result hooks — which lack a chat id — can be attributed to a channel.
const traceFile = hub.trace?.file ?? join(hub.stateDir, "trace.jsonl")
const trace = new TurnTrace({
  append: (l) => { try { appendFileSync(traceFile, l) } catch {} },
  readTail: (n) => { try { return parseTraceTail(readFileSync(traceFile, "utf8"), n) } catch { return [] } },
  now: () => Date.now(),
  enabled: hub.trace?.enabled === true,
})
const lastChatByAgent = new Map<string, string>()

// Periodic trace sweep: drop records older than retentionDays, keeping trace.jsonl
// bounded (readTail/full-read reads the whole file, so an unbounded file gets
// slower forever). Mirrors the gardener's enabled+intervalMs+setInterval shape.
if (hub.trace?.enabled) {
  const retentionMs = (hub.trace.retentionDays ?? 14) * 24 * 60 * 60_000
  const runTraceSweep = () => {
    try {
      // parseTraceTail's `n` is a slice(-n) count; Infinity clamps to slice(0) — the
      // whole file — since a sweep must inspect every record, not just a tail window.
      const all = parseTraceTail(readFileSync(traceFile, "utf8"), Infinity)
      const kept = sweepTrace(all, Date.now(), retentionMs)
      if (kept.length === all.length) return
      const tmp = `${traceFile}.tmp-${process.pid}`
      writeFileSync(tmp, kept.map((r) => JSON.stringify(r) + "\n").join(""))
      renameSync(tmp, traceFile)
    } catch (err) { process.stderr.write(`trace sweep failed: ${err}\n`) }
  }
  runTraceSweep()
  setInterval(runTraceSweep, hub.trace.sweepIntervalMs ?? 6 * 60 * 60_000).unref()
}

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
let agentPreviewCounter = 0
const agentConfigPreviews = new AgentConfigPreviewRegistry(
  () => Date.now(),
  () => `agentprev-${++agentPreviewCounter}`,
  5 * 60_000,   // 5 minute TTL — a stale preview must be re-generated, not silently confirmed
)
const approvalCards = new Map<string, { chatId: string; messageId: string }>()
const channelActivity = new Map<string, { agent: string; lastActive: number }>()
const channelStream = new ChannelStream()
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

// Cross-VPS peering: agents on this hub can notify/ask agents on a remote hub
// (and vice versa) over an HMAC-signed HTTP channel. All inert when peering is
// absent or disabled. Singletons declared here so the makeTransport callbacks and
// the inbound route handlers (both later in this file) close over them.
const peering = hub.peering
const peeringOn = !!peering?.enabled
const liaisonLogPath = join(hub.stateDir, "liaison.log.jsonl")
const liaison = new LiaisonLog({ append: (l) => { try { appendFileSync(liaisonLogPath, l) } catch {} }, now: Date.now })
const peerDedupe = new PeerDedupe(Date.now, peering?.dedupeWindowMs ?? 600_000)
const peerRate = new PeerRateLimiter(Date.now, peering?.ratePerPeerPerMin ?? 0)
// Outbound asks awaiting a /peer/reply, keyed by corrId. Reuse ConsultRegistry's
// open/settle/sweepExpired shape (virtual "channel" = the consult id).
let peerAskSeq = 0
const peerAskRegistry = new ConsultRegistry(Date.now, () => `pk${++peerAskSeq}`, peering?.askTimeoutMs ?? 300_000)
// corrId -> the peerAskRegistry channel for the outbound ask awaiting that reply.
const peerAskByCorr = new Map<string, string>()

// Outbound poster + spool. A real fetch adapter; the spool retries notify
// deliveries with exponential backoff and dead-letters after maxAttempts.
const realFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const res = await fetch(url, init); return { status: res.status }
}
function secretForPeer(peerName: string): string | undefined {
  if (!peering) return undefined
  const def = resolvePeer(peering, peerName)
  return def ? peerSecret(process.env, def) : undefined
}
const peerSpool = new PeerSpool({
  now: Date.now,
  maxAttempts: peering?.notifyRetry?.maxAttempts ?? 5,
  baseDelayMs: peering?.notifyRetry?.baseDelayMs ?? 2000,
  send: async (item: SpoolItem) => {
    const parsed = parseTarget(item.target)
    if (!parsed) return true   // unparseable target → drop (don't spin forever)
    const def = peering ? resolvePeer(peering, parsed.peer) : undefined
    const secret = secretForPeer(parsed.peer)
    if (!def || !secret) return true   // unresolvable → drop
    const r = await postPeer(peering!.selfName, def, secret, `${peering!.listenPath ?? "/peer"}/notify`, item.body, realFetch)
    return r.ok
  },
  onDeadLetter: (item) => {
    const { peer, agent } = parseTarget(item.target) ?? { peer: "?", agent: "?" }
    audit.record({ kind: "liaison", actor: "hub", action: "deadletter", target: item.target, outcome: "error", corr: item.body.corrId })
    liaison.write({ dir: "out", kind: "deadletter", corrId: item.body.corrId, peer, remoteAgent: agent, text: item.body.text, ok: false, error: "max attempts" })
    persistSpool()
  },
})
// Durable notify spool: persist snapshot to disk so queued/retrying notifies
// survive a hub restart. Inert when peering is off. Atomic write via tmp+rename
// (mirrors cron-state.json / bindings.json); restore runs before any enqueue so
// the spool's seq is correct. Corrupt/missing file → start empty, never throw.
const peerSpoolPath = join(hub.stateDir, "peer-spool.json")
function persistSpool(): void {
  if (!peeringOn) return
  try {
    const tmp = peerSpoolPath + ".tmp"
    writeFileSync(tmp, JSON.stringify(peerSpool.snapshot()))
    renameSync(tmp, peerSpoolPath)
  } catch {}
}
if (peeringOn) {
  try {
    if (existsSync(peerSpoolPath)) peerSpool.restore(JSON.parse(readFileSync(peerSpoolPath, "utf8")))
  } catch {}
}
// Drain the spool on a timer (only when peering is on).
if (peeringOn) {
  const drain = setInterval(() => { void peerSpool.drainOnce().then(persistSpool) }, 2000)
  ;(drain as { unref?: () => void }).unref?.()
}

// Mirror peer traffic to a Discord channel (read-only transcript) when configured.
function liaisonMirror(line: string): void {
  const ch = peering?.mirrorChannelId
  if (ch) void gateway.sendPlain(ch, line)
}

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

/** Flatten a card to its trace body: title + body joined for full-fidelity capture. */
function cardTraceText(card: CardSpec): string {
  return [card.title, card.body].filter(Boolean).join("\n")
}

/** Handle one reply from a transport: cards → Discord card (+ register buttons);
 *  text → spawn-trigger match or a plain reply; react/edit → passthrough. */
async function onAgentReply(reply: AgentReply, key: string): Promise<void | SendOutcome> {
  if (toolObs) toolUsage.endTurn(reply.agent)
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
  // Inbound peer ask: a reply on a peerAskRegistry consult channel (opened by
  // deliverPeerAsk for a remote caller) is the local agent's answer — settle it so
  // sendBack POSTs the answer to the caller's replyTo, and never run the normal
  // Discord pipeline. peerAskRegistry also holds OUTBOUND pending-asks, but those
  // channels never receive a local agent reply (they settle via the route onReply /
  // peerAskByCorr), so this branch only ever matches inbound local-consults.
  if (peerAskRegistry.isConsultChannel(reply.chatId)) {
    const answer = consultAnswerFromReply(reply)
    if (answer !== undefined) peerAskRegistry.settle(reply.chatId, answer)
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
    trace.record({ agent: reply.agent, chat: reply.chatId, kind: "card", text: cardTraceText(reply.card) })
    return await cardLifecycle.onCard(reply, key)
  }
  if (reply.kind === "update" && reply.card && reply.correlationId) {
    trace.record({ agent: reply.agent, chat: reply.chatId, kind: "update", text: cardTraceText(reply.card) })
    return await cardLifecycle.onUpdate(reply.correlationId, reply.chatId, reply.card, key)
  }
  if (reply.kind === "reply" && reply.text) {
    trace.record({ agent: reply.agent, chat: reply.chatId, kind: "reply", text: reply.text })
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
    channelActivity.set(reply.chatId, { agent: reply.agent, lastActive: Date.now() })
    channelStream.publish(reply.chatId, { kind: "chat", ts: Date.now(), author: reply.agent, content: reply.text, origin: "agent" })
  }
  await gateway.sendReply(reply, agents[reply.agent])
  // F3 auto-escalation: if this real persistent-agent turn logged tool errors, re-run
  // it once at higher effort (rate-capped). `key === reply.agent` only for a live
  // persistent agent — clones use distinct keys, so an escalation never re-triggers.
  if (escalationOn && escCfg?.auto && reply.kind === "reply" && key === reply.agent && agents[reply.agent]) {
    const errs = turnErrors.get(key) ?? 0
    turnErrors.set(key, 0)
    if (errs > 0 && !escalatingChats.has(reply.chatId) && autoRateCap.tryTake())
      void escalateTurn(reply.chatId, "auto")
  }
}

// Monotonic job-id counter for spawn triggers (Math.random forbidden).
let jobCounter = 0
const nextJobId = (): string => `job-${++jobCounter}`
let webMsgCounter = 0

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
    return cardLifecycle.onUpdate(corr, chatId, card, jobId).then(() => {})
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
const toolObs = hub.toolObservability?.enabled === true
const toolUsage = new ToolUsageRegistry()
const shareLinksOn = hub.shareLinks?.enabled === true
const shareArtifactsDir = hub.shareLinks?.artifactsDir ?? join(hub.stateDir, "share-artifacts")
const shareOutboxBase = hub.outboundAttachments?.outboxDir ?? join(hub.stateDir, "outbox")
const base62 = (b: Buffer) => { const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"; let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ""; while (n > 0n) { s = A[Number(n % 62n)] + s; n /= 62n } return s.padStart(22, "0") }

// F3 effort escalation: re-run a chat's last turn on a short-lived, higher-effort
// ephemeral clone. Manual via `!hard`, auto when a turn's tool results carried error
// signals (bounded by `autoRateCap`). Off unless `hub.escalation.enabled`.
const escCfg = hub.escalation
const escalationOn = escCfg?.enabled === true
const lastTurns = new Map<string, { agent: string; content: string }>()   // by chatId: what to re-run
const turnErrors = new Map<string, number>()                               // by transport key: this turn's tool errors
const autoRateCap = new RateCap(Date.now, escCfg?.autoMaxPerHour ?? 4)
const escalatingChats = new Set<string>()                                  // chats with an escalation in flight

/** Re-run `chatId`'s last turn on a stronger ephemeral clone and post the result to
 *  the same channel. `reason` is "manual" (!hard) or "auto" (tool-error-triggered).
 *  The clone runs clean (fresh session, no memory/context) at the escalation model +
 *  args; its reply is captured here rather than posted under the clone's own key. */
async function escalateTurn(chatId: string, reason: "manual" | "auto"): Promise<void> {
  const last = lastTurns.get(chatId)
  if (!last) { if (reason === "manual") void gateway.sendPlain(chatId, "🥊 nothing to escalate yet — no prior turn on this channel."); return }
  if (escalatingChats.has(chatId)) { if (reason === "manual") void gateway.sendPlain(chatId, "🥊 an escalation is already running for this channel."); return }
  const cfg = agents[last.agent]
  if (!cfg) return
  escalatingChats.add(chatId)
  const cloneKey = `escalate-${last.agent}-${Date.now()}`
  const cloneCfg: AgentConfig = {
    ...cfg,
    mode: "ephemeral" as const,
    runtime: escalatedRuntime(cfg.runtime, { model: escCfg?.model, claudeArgs: escCfg?.claudeArgs }),
  }
  const t = makeTransport(last.agent, cloneKey, cloneCfg)
  void gateway.sendPlain(chatId, `🥊 escalating${escCfg?.model ? ` (${escCfg.model})` : ""} — re-running the last turn at higher effort…`)
  if (!auditOptedOut(last.agent)) audit.record({
    kind: "session", actor: reason === "manual" ? "user" : "hub", action: "escalate",
    target: last.agent, chat: chatId, detail: { reason },
  })
  let done = false
  const finish = async (reply: AgentReply | null) => {
    if (done) return
    done = true
    void t.close()
    transports.delete(cloneKey)
    turnErrors.delete(cloneKey)
    escalatingChats.delete(chatId)
    // Post to the REAL channel; buttons on a card bind to the live persistent agent.
    if (reply?.kind === "card" && reply.card) await cardLifecycle.onCard({ ...reply, chatId }, last.agent)
    else if (reply?.kind === "reply") void gateway.sendPlain(chatId, reply.text ?? "(no response from escalation)")
    else void gateway.sendPlain(chatId, "🥊 escalation produced no response.")
  }
  // Override makeTransport's onReply so the clone's answer is captured, not posted
  // under the clone key. (Same pattern as spawnConsultClone.)
  t.onReply((reply) => { if (reply.kind === "reply" || reply.kind === "card") void finish(reply) })
  setTimeout(() => void finish(null), 180_000).unref()
  void t.start().then(() => {
    t.deliver(cloneKey, {
      chatId: cloneKey, messageId: "escalate-0", userId: "system", user: "hub",
      content: last.content, ts: new Date().toISOString(), isDM: false,
    })
  })
}

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
dispatcher.onReply((reply) => onAgentReply(reply, reply.agent))

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

/** Hot-swap the one field !reload's safe tier ever applies live: per-agent
 *  access. Shared by the Discord !reload loop (called once per agent) and the
 *  web confirm endpoint (called once for the single agent being edited) so
 *  there's exactly one place this hot-swap logic lives. */
function applySafeAgentFields(name: string, next: AgentConfig): void {
  if (agents[name]) agents[name]!.access = next.access
}

/** Respawn a persistent agent's process from its CURRENT registry config so a
 *  hard `!reload` picks up new spawn args (model / claudeArgs / cwd). Unlike
 *  resetAgentSession this KEEPS the session file, so a resumable agent resumes
 *  its context under the new process. Pooled agents are skipped (they run behind
 *  an AgentPool the reload path can't hot-swap). */
async function respawnAgent(name: string): Promise<void> {
  const cfg = agents[name]
  if (!cfg || cfg.mode !== "persistent" || cfg.runtime?.pool) return
  const old = transports.get(name)
  if (old) { await old.close(); transports.delete(name) }
  const fresh = makeTransport(name, name, cfg)
  await fresh.start()
  dispatcher.replace(name, fresh)
  if (!auditOptedOut(name)) audit.record({
    kind: "session", actor: "hub", action: "respawn", target: name, detail: { reason: "reload" },
  })
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
const boardMsgPath = join(expandHome(hub.stateDir), "status-board-msg.txt")
let boardMsgId: string | undefined = (() => {
  try { const s = readFileSync(boardMsgPath, "utf8").trim(); return s || undefined } catch { return undefined }
})()
let boardSnapshotPending = false
async function flushBoard(): Promise<void> {
  if (!hub.statusChannelId) return
  const card = renderBoard(statusRegistry.snapshot(Date.now()))
  if (boardMsgId == null) {
    boardMsgId = await gateway.sendCard(hub.statusChannelId, card)
    try { if (boardMsgId) writeFileSync(boardMsgPath, boardMsgId) } catch {}
  } else {
    // If the message was deleted in Discord the edit will throw — fall back to a fresh post.
    try { await gateway.editCard(hub.statusChannelId, boardMsgId, card) }
    catch {
      boardMsgId = await gateway.sendCard(hub.statusChannelId, card)
      try { if (boardMsgId) writeFileSync(boardMsgPath, boardMsgId) } catch {}
    }
  }
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
      ...(toolObs ? { currentTool: toolUsage.liveFor(name).current, lastTool: toolUsage.liveFor(name).last } : {}),
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

const toolBoardChannel = hub.toolObservability?.channelId ?? hub.statusChannelId
const toolBoardMsgPath = join(expandHome(hub.stateDir), "tool-board-msg.txt")
let toolBoardMsgId: string | undefined = (() => {
  try { const s = readFileSync(toolBoardMsgPath, "utf8").trim(); return s || undefined } catch { return undefined }
})()
async function flushToolBoard(): Promise<void> {
  if (!toolObs || !toolBoardChannel) return
  const card = renderToolBoard(toolUsage.snapshot())
  if (toolBoardMsgId == null) {
    toolBoardMsgId = await gateway.sendCard(toolBoardChannel, card)
    try { writeFileSync(toolBoardMsgPath, toolBoardMsgId ?? "") } catch {}
  } else {
    try { await gateway.editCard(toolBoardChannel, toolBoardMsgId, card) }
    catch {
      toolBoardMsgId = await gateway.sendCard(toolBoardChannel, card)
      try { writeFileSync(toolBoardMsgPath, toolBoardMsgId ?? "") } catch {}
    }
  }
}
if (toolObs && toolBoardChannel) {
  const refresh = hub.statusRefreshMs ?? 15_000
  setInterval(() => void flushToolBoard(), refresh).unref()
  setTimeout(() => void flushToolBoard(), 3_000).unref()
}

if (shareLinksOn) {
  const sweep = () => {
    let names: string[] = []
    try { names = readdirSync(shareArtifactsDir) } catch { return }
    const now = new Date()
    const entries = names.filter((n) => !n.endsWith(".tmp")).map((token) => {
      try { const m = JSON.parse(readFileSync(join(shareArtifactsDir, token, "meta.sbmd"), "utf8")); return { token, expiresAt: m.expiresAt as string } }
      catch { let ageMs = 0; try { ageMs = now.getTime() - statSync(join(shareArtifactsDir, token)).mtimeMs } catch {}; return { token, ageMs } }
    })
    // also reap abandoned *.tmp dirs older than the grace period
    for (const n of names.filter((x) => x.endsWith(".tmp"))) {
      try { if (now.getTime() - statSync(join(shareArtifactsDir, n)).mtimeMs > 3_600_000) rmSync(join(shareArtifactsDir, n), { recursive: true, force: true }) } catch {}
    }
    for (const token of selectExpired(entries, now, 3_600_000)) {
      try { rmSync(join(shareArtifactsDir, token), { recursive: true, force: true }) } catch {}
    }
  }
  setInterval(sweep, hub.shareLinks?.cleanupIntervalMs ?? 86_400_000).unref()
  setTimeout(sweep, 30_000).unref()
}

const baseGate = new BaseGate(join(hub.stateDir, "access.json"))

// Only allowlisted users may press card buttons.
gateway.setPermissionAuthorizer((uid) => baseGate.listAllowed().includes(uid))

async function handleMemButton(action: string, arg: { corrId: string; idx?: number }, userId: string): Promise<void> {
  const s = memSessions.get(arg.corrId)
  if (!s) return
  const chatId = s.chatId
  const pageCount = Math.max(1, Math.ceil(s.notes.length / PAGE))
  const shown = () => s.notes.slice(s.page * PAGE, s.page * PAGE + PAGE)
  const noteAt = (i?: number) => (i === undefined ? undefined : s.notes[i])
  if (action === "next" || action === "prev") {
    memSessions.setPage(arg.corrId, Math.max(0, Math.min(pageCount - 1, s.page + (action === "next" ? 1 : -1))))
    await gateway.sendCard(chatId, renderListCard(shown(), arg.corrId, s.page, pageCount, s.label, PAGE)); return
  }
  if (action === "view") {
    const n = noteAt(arg.idx); if (!n) return
    await gateway.sendCard(chatId, renderDetailCard({ ...n, body: memBrowse.body(n.path) }, arg.corrId, arg.idx!)); return
  }
  if (action === "forget" || action === "del") {
    const n = noteAt(arg.idx); if (!n) return
    await gateway.sendCard(chatId, renderConfirmCard(action === "del" ? "del" : "forget", n.title, arg.corrId, arg.idx!)); return
  }
  if (action === "cancel") { await gateway.sendPlain(chatId, "Cancelled."); return }
  if (action === "confirm" || action === "confirmdel") {
    const n = noteAt(arg.idx); if (!n) return
    // The kind is explicit in the customId: confirm → archive, confirmdel → permanent delete.
    const r = action === "confirmdel"
      ? memBrowse.remove({ path: n.path, title: n.title, scope: n.scope }, userId)
      : memBrowse.forget({ path: n.path, title: n.title, scope: n.scope }, userId)
    const verb = action === "confirmdel" ? "🗑 Deleted" : "🗄 Archived"
    if (!r.ok) {
      const msg = r.reason === "archive_failed"
        ? `⚠️ Could not archive **${n.title}** (already archived?).`
        : `⚠️ "${n.title}" no longer exists.`
      await gateway.sendPlain(chatId, msg); return
    }
    await gateway.sendPlain(chatId, `${verb} **${n.title}**.`)
    return
  }
}

// A card button was clicked → gated actions run hub-side; others relay to the agent.
gateway.onNotifyButton((customId, userId) => {
  const ap = parseApprovalCustomId(customId)
  if (ap) { void resolveApproval(ap.id, ap.decision, userId); return }
  const action = matchGatedAction(customId, hub.gatedActions ?? [])
  if (action) { void cardLifecycle.runGated(action, customId); return }
  const mem = parseNotifyCustomId(customId)
  if (memBrowseOn && mem?.ns === "mem") {
    if (!isMemOperator(userId)) {
      audit.record({ kind: "event", actor: `user:${userId}`, action: "memory_deny", outcome: "deny", detail: { via: "button" } })
      return
    }
    void handleMemButton(mem.action, parseMemArg(mem.arg), userId)
    return
  }
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
// Inbound peer ask: run a LOCAL consult against the addressed agent, then POST
// the answer back to the caller's replyTo. The local agent is the `agent` half of
// the envelope's `to` ("<thisHubsPeerName>:<localAgent>").
function deliverPeerAsk(e: PeerEnvelope): void {
  const parsed = parseTarget(e.to)
  const agentName = parsed ? parsed.agent : e.to
  const cfg = agents[agentName]
  const callerPeer = e.from
  const allowed = !!cfg && !!(cfg.access.peerableBy?.includes("*") || cfg.access.peerableBy?.includes(callerPeer))
  const replyTo = e.replyTo
  const def = peering ? resolvePeer(peering, callerPeer) : undefined
  const secret = secretForPeer(callerPeer)
  const sendBack = (answer: string, ok: boolean, errKind: "reply" | "timeout" = "reply") => {
    liaison.write({ dir: "out", kind: errKind, corrId: e.corrId, peer: callerPeer, localAgent: agentName, remoteAgent: undefined, text: answer, ok })
    audit.record({ kind: "liaison", actor: `agent:${agentName}`, action: errKind, target: callerPeer, outcome: ok ? "ok" : "error", corr: e.corrId })
    if (replyTo && def && secret && peering) {
      const body: PeerEnvelope = { from: peering.selfName, to: callerPeer, corrId: e.corrId, kind: "reply", text: answer, ts: Date.now() }
      // replyTo comes from the remote envelope but is only reached after HMAC
      // verification against the configured peer's shared secret, so only an
      // operator-trusted peer can set it.
      // POST straight to the absolute replyTo URL (not baseUrl + path).
      void postPeer(peering.selfName, { ...def, baseUrl: "" }, secret, replyTo, body, realFetch)
    }
  }
  if (!allowed) { sendBack(`(agent "${agentName}" is not peer-reachable from "${callerPeer}")`, false); return }
  liaison.write({ dir: "in", kind: "ask", corrId: e.corrId, peer: callerPeer, localAgent: agentName, text: e.text, ok: true })
  audit.record({ kind: "liaison", actor: `peer:${callerPeer}`, action: "ask", target: agentName, outcome: "ok", corr: e.corrId })
  liaisonMirror(`↘ ${callerPeer} → ${agentName}: ask`)
  const consult = peerAskRegistry.open(`peer:${callerPeer}`, agentName, (answer) => sendBack(answer, true))
  const inbound: InboundMessage = { chatId: consult.channel, messageId: `peerask:${e.corrId}`, userId: "system", user: "hub", content: e.text, ts: new Date().toISOString(), isDM: false }
  const target = pools.get(agentName) ?? transports.get(agentName)
  if (!target?.isAvailable()) { peerAskRegistry.settle(consult.channel, `(agent "${agentName}" is unavailable)`); return }
  dispatcher.dispatch(agentName, consult.channel, inbound)
}

const peerRouteDeps: PeerRouteDeps | null = peeringOn && peering ? {
  cfg: peering,
  secretFor: secretForPeer,
  dedupe: peerDedupe,
  now: Date.now,
  rateOk: (p) => peerRate.ok(p),
  onNotify: (e) => {
    const parsed = parseTarget(e.to); const agentName = parsed ? parsed.agent : e.to
    const cfg = agents[agentName]
    const allowed = !!cfg && !!(cfg.access.peerableBy?.includes("*") || cfg.access.peerableBy?.includes(e.from))
    liaison.write({ dir: "in", kind: "notify", corrId: e.corrId, peer: e.from, localAgent: agentName, text: e.text, ok: allowed })
    audit.record({ kind: "liaison", actor: `peer:${e.from}`, action: "notify", target: agentName, outcome: allowed ? "ok" : "deny", corr: e.corrId })
    if (allowed) { liaisonMirror(`↘ ${e.from} → ${agentName}: notify`); deliverToAgent(agentName, "", `peer:${e.from}`, e.text) }
  },
  onAsk: deliverPeerAsk,
  onReply: (e) => {
    const channel = peerAskByCorr.get(e.corrId)
    if (channel) { peerAskByCorr.delete(e.corrId); peerAskRegistry.settle(channel, e.text) }
    liaison.write({ dir: "in", kind: "reply", corrId: e.corrId, peer: e.from, text: e.text, ok: true })
    audit.record({ kind: "liaison", actor: `peer:${e.from}`, action: "reply", target: e.from, outcome: "ok", corr: e.corrId })
  },
  onRejected: (peerName, reason) => {
    audit.record({ kind: "liaison", actor: `peer:${peerName}`, action: "rejected", outcome: "deny", detail: { reason } })
    liaison.write({ dir: "in", kind: "rejected", corrId: "-", peer: peerName, ok: false, error: reason })
  },
} : null

const extraHandler = peerRouteDeps
  ? (req: Request) => {
      const base = peering!.listenPath ?? "/peer"
      return new URL(req.url).pathname.startsWith(base) ? handlePeerRequest(req, peerRouteDeps) : Promise.resolve(null)
    }
  : undefined

const listener = startWebhookListener(hub.webhookPort ?? 0, webhookHandlers, extraHandler)
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
    // Record inbound in the trace + remember this agent's live chat so its
    // tool_use/tool_result records (which carry no chat id) can be attributed.
    lastChatByAgent.set(agent, inbound.chatId)
    trace.record({ agent, chat: inbound.chatId, kind: "inbound", text: inbound.content })
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
    // Fold any quote-reply target and forwarded message(s) into the live message
    // so the agent sees them (Discord delivers neither in the typed content).
    let live = foldForward(foldQuote(inbound.content, inbound.quote), inbound.forwards)
    // Pass user-uploaded files through: download them locally and tell the agent
    // where to Read them. Off unless attachments.enabled (then byte-identical).
    if (hub.attachments?.enabled && inbound.attachments?.length) {
      try {
        const files = await materializeAttachments(
          inbound.attachments,
          {
            dir: hub.attachments.dir ? expandHome(hub.attachments.dir) : join(hub.stateDir, "attachments"),
            maxBytes: hub.attachments.maxBytes ?? 10_485_760,
          },
          { fetch: (u) => fetch(u), writeFile: (p, d) => writeFileAsync(p, d), mkdir: (d) => mkdirAsync(d, { recursive: true }).then(() => undefined) },
        )
        live = foldAttachments(live, files)
      } catch (e) { process.stderr.write(`hub: attachment passthrough failed: ${e}\n`) }
    }
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
    // F3: remember what to re-run for this channel, and start a fresh error tally
    // for the turn about to begin (per agent key; persistent key === agent name).
    lastTurns.set(inbound.chatId, { agent, content: live })
    turnErrors.set(agent, 0)
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
// Mutable so a safe `!reload` can hot-swap them without dropping agent procs.
let commands = hub.commands ?? []
let directCommands = hub.directCommands ?? []

/** Gather the facts `!doctor` and the web panel's Doctor button both render via
 *  runDoctor/renderDoctor — extracted so both call sites stay byte-identical. */
function gatherDoctorFacts(): DoctorFacts {
  let stateDirWritable = true
  try { const probe = join(hub.stateDir, `.doctor-${process.pid}`); writeFileSync(probe, ""); unlinkSync(probe) } catch { stateDirWritable = false }
  const doctorAgents = Object.entries(agents)
    .filter(([, cfg]) => cfg.mode === "persistent")
    .map(([name]) => ({ name, alive: (pools.get(name) ?? transports.get(name))?.isAvailable() ?? false, registered: true }))
  return {
    agents: doctorAgents,
    stateDirWritable,
    pendingApprovals: approvalRegistry.pendingCount(),
    auditEnabled: hub.audit?.enabled === true,
    traceEnabled: hub.trace?.enabled === true,
    routerModel: hub.routerModel,
  }
}
gateway.handleInbound((m) => {
  channelStream.publish(m.chatId, { kind: "chat", ts: Date.now(), author: m.user, content: m.content, origin: "discord" })
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
  // Manual escalation (operator-only): re-run this channel's last turn at higher effort.
  if (/^!hard\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!escalationOn) { void gateway.sendPlain(m.chatId, "🥊 `!hard` is off (set `hub.escalation.enabled`)."); return }
    void escalateTurn(m.chatId, "manual")
    return
  }
  if (/^!audit\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!hub.audit?.enabled) { void gateway.sendPlain(m.chatId, "📜 audit logging is off (set `hub.audit.enabled`)."); return }
    void gateway.sendPlain(m.chatId, buildAuditText(trimmed.replace(/^!audit\b/i, ""), audit, (ts) => new Date(ts).toISOString().slice(11, 19)))
    return
  }
  // Two-tier config reload (operator-only). `!reload` re-reads the config file and
  // hot-swaps the SAFE subset (router/fallback models, contextWindows, commands,
  // directCommands, per-agent access) with NO agent-process churn. `!reload hard`
  // additionally respawns persistent agents whose spawn config (model/args/cwd)
  // changed. Some changes need a full hub restart — those are reported, never applied.
  if (/^!reload\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (hub.reload?.enabled !== true) { void gateway.sendPlain(m.chatId, "🔧 `!reload` is off (set `hub.reload.enabled`)."); return }
    const hard = /^!reload\s+hard\b/i.test(trimmed)
    let next: { hub: HubConfig; agents: AgentRegistry }
    try { next = loadConfigs(CONFIG_DIR) }
    catch (e) { void gateway.sendPlain(m.chatId, `❌ reload aborted — config did not load: ${e instanceof Error ? e.message : e}`); return }
    const plan = planReload({ hub, agents }, next)
    // Apply the safe subset in place so call-time readers pick it up without a restart.
    hub.routerModel = next.hub.routerModel
    hub.librarianModel = next.hub.librarianModel
    hub.distillerModel = next.hub.distillerModel
    hub.overseerModel = next.hub.overseerModel
    hub.contextWindows = next.hub.contextWindows
    hub.commands = next.hub.commands
    hub.directCommands = next.hub.directCommands
    commands = next.hub.commands ?? []
    directCommands = next.hub.directCommands ?? []
    for (const [name, cfg] of Object.entries(next.agents)) applySafeAgentFields(name, cfg)
    audit.record({ kind: "event", actor: `user:${m.userId}`, action: hard ? "reload_hard" : "reload_safe", chat: m.chatId, outcome: "ok", detail: { restartAgents: plan.restartAgents, fullRestart: plan.fullRestart } })
    const lines = [`🔧 **reload (${hard ? "hard" : "safe"})** — config re-read, safe subset hot-swapped.`]
    void (async () => {
      if (hard && plan.restartAgents.length) {
        for (const name of plan.restartAgents) { if (next.agents[name]) agents[name] = next.agents[name]! }
        for (const name of plan.restartAgents) { try { await respawnAgent(name) } catch (e) { lines.push(`❌ respawn ${name} failed: ${e instanceof Error ? e.message : e}`) } }
        lines.push(`♻️ restarted ${plan.restartAgents.length} agent(s): ${plan.restartAgents.join(", ")}`)
      } else if (plan.restartAgents.length) {
        lines.push(`ℹ️ ${plan.restartAgents.length} agent(s) changed spawn config (model/args/cwd) — run \`!reload hard\` to apply: ${plan.restartAgents.join(", ")}`)
      }
      if (plan.fullRestart.length) lines.push(`⚠️ needs a full hub restart (not applied): ${plan.fullRestart.join(", ")}`)
      void gateway.sendPlain(m.chatId, lines.join("\n"))
    })()
    return
  }
  // Turn trace query (operator-only): full-fidelity per-turn records (message
  // bodies). Off unless hub.trace.enabled. Filters: agent= chat= kind= limit=.
  if (/^!trace\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (hub.trace?.enabled !== true) { void gateway.sendPlain(m.chatId, "🔎 turn trace is off (set `hub.trace.enabled`)."); return }
    const filter: TraceFilter = {}
    for (const tok of trimmed.replace(/^!trace\b/i, "").trim().split(/\s+/).filter(Boolean)) {
      const eq = tok.indexOf("=")
      if (eq === -1) continue
      const k = tok.slice(0, eq); const v = tok.slice(eq + 1)
      if (k === "agent") filter.agent = v
      else if (k === "chat") filter.chat = v
      else if (k === "kind" && ["inbound", "tool_use", "tool_result", "reply", "card", "update"].includes(v)) filter.kind = v as TraceFilter["kind"]
      else if (k === "limit") { const n = parseInt(v, 10); if (Number.isFinite(n)) filter.limit = Math.max(1, Math.min(200, n)) }
    }
    const out = renderTrace(trace.recent({ ...filter, limit: filter.limit ?? 25 }), (ts) => new Date(ts).toISOString().slice(11, 19))
    for (const chunk of chunkLines(out, 1_900)) void gateway.sendPlain(m.chatId, chunk)
    return
  }
  // Hub self-check (operator-only): agent liveness, state-dir writability, router
  // config, pending approvals, and the logging switches → a pass/warn/fail report.
  if (/^!doctor\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    void gateway.sendPlain(m.chatId, renderDoctor(runDoctor(gatherDoctorFacts())))
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
  if (toolObs && /^!tools\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    void gateway.sendPlain(m.chatId, buildToolsText(trimmed.replace(/^!tools\b/i, "").trim(), toolUsage))
    return
  }
  if (memBrowseOn && /^!memory\b/i.test(trimmed)) {
    if (!isMemOperator(m.userId)) {
      audit.record({ kind: "event", actor: `user:${m.userId}`, action: "memory_deny", outcome: "deny", detail: { via: "command" } })
      void gateway.sendPlain(m.chatId, "🔒 `!memory` is operator-only."); return
    }
    const rest = trimmed.replace(/^!memory\b/i, "").trim()
    void (async () => {
      let notes: NoteSummary[]; let label: string
      const searchM = /^search\s+(.+)$/i.exec(rest)
      if (searchM) {
        label = `search "${searchM[1]}"`
        const scopes = ["global", "agents", "users", "channels"] as any  // all top-level scopes
        try { notes = (await memoryRetriever.relevant(searchM[1]!, scopes)).notes.map(toSummary) } catch { notes = [] }
      } else {
        const scope = (rest || "global")
        label = scope
        notes = memBrowse.list([scope])
      }
      const corrId = memSessions.create({ chatId: m.chatId, scopes: [label], label, notes, pageSize: PAGE })
      const pageCount = Math.max(1, Math.ceil(notes.length / PAGE))
      await gateway.sendCard(m.chatId, renderListCard(notes.slice(0, PAGE), corrId, 0, pageCount, label, PAGE))
    })()
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
  return { ...collectMetrics(), recent: audit.recent({ limit: 30 }), pendingApprovalList: approvalRegistry.list() }
}
const webDeps: WebDeps = {
  collect: collectWeb,
  requireUser: (req) => req.headers.get("x-switchboard-user"),

  resolveApproval: async (id, decision, actor) => {
    // Deliberately NOT calling the existing resolveApproval(id, decision, userId) —
    // it hardcodes `actor: \`user:${userId}\`` for the audit row, which would
    // double-prefix a web actor as "user:web:<email>". Inline the same steps
    // (registry resolve → audit → card edit → fire) with a clean "web:<email>" actor.
    const e = approvalRegistry.resolve(id, decision)
    if (!e) return "not_found"
    audit.record({
      kind: "approval", actor: `web:${actor}`, action: decision === "grant" ? "grant" : "deny",
      target: e.target, chat: e.chat, outcome: decision === "grant" ? "ok" : "deny", corr: e.id,
    })
    const loc = approvalCards.get(e.id); approvalCards.delete(e.id)
    if (loc) await gateway.editCard(loc.chatId, loc.messageId, renderApprovalCard(e))
    if (decision === "grant") {
      try { await e.fire(e.id) } catch (err) { process.stderr.write(`approval ${e.id} fire failed: ${err}\n`) }
    }
    return decision === "grant" ? "granted" : "denied"
  },

  listChannels: (): ChannelInfo[] => {
    const now = Date.now()
    return [...channelActivity.entries()]
      .filter(([, v]) => now - v.lastActive < 24 * 60 * 60 * 1000)   // last 24h
      .sort((a, b) => b[1].lastActive - a[1].lastActive)
      .map(([channelId, v]) => ({ channelId, agent: v.agent }))
  },

  fetchChannelHistory: async (channelId): Promise<ChannelEvent[]> => {
    try {
      const ch = await gateway.client.channels.fetch(channelId)
      if (!ch || !("messages" in ch)) return []
      const msgs = await (ch as any).messages.fetch({ limit: 50 })
      return [...msgs.values()].reverse().map((msg: any) => ({
        kind: "chat",
        ts: msg.createdTimestamp,
        author: msg.author.username,
        content: msg.content,
        origin: msg.author.bot ? "agent" : "discord",
      }))
    } catch { return [] }
  },

  fetchChannelTimeline: async (channelId): Promise<TraceRecord[]> => {
    if (!hub.trace?.enabled) return []
    return trace.recent({ chat: channelId, limit: 50 })
  },

  subscribeChannel: (channelId, cb) => channelStream.subscribe(channelId, cb),

  sendChannelMessage: async (channelId, email, text) => {
    await gateway.sendPlain(channelId, formatMirrorLine(email, text))
    channelStream.publish(channelId, { kind: "chat", ts: Date.now(), author: email, content: text, origin: "web" })
    const inbound = buildWebInboundMessage(channelId, email, text, Date.now(), () => `web-${++webMsgCounter}`)
    void orchestrator.handleMessage(inbound)
  },

  // `channelId` is accepted to match the WebDeps interface shape but is currently
  // unused — a future phase may also post the result back to the Discord channel.
  runCommand: async (name, channelId): Promise<string | null> => {
    if (name === "audit") {
      if (!hub.audit?.enabled) return "📜 audit logging is off (set `hub.audit.enabled`)."
      return buildAuditText("", audit, (ts) => new Date(ts).toISOString().slice(11, 19))
    }
    if (name === "tools" && toolObs) {
      return buildToolsText("", toolUsage)
    }
    if (name === "doctor") {
      return renderDoctor(runDoctor(gatherDoctorFacts()))
    }
    return null
  },

  listAgents: async (): Promise<Record<string, AgentConfig>> => {
    return readAgentsJson()
  },

  previewAgentChange: async (name, config) => {
    if (config) {
      const shapeError = invalidAgentConfigShape(config)
      if (shapeError) return { error: shapeError }
    }
    const current = readAgentsJson()
    const before = current[name] ?? null
    const classification = classifyAgentChange(name, before, config, hub)
    const preview = agentConfigPreviews.create(name, before, config, classification)
    return { id: preview.id, before: preview.before, after: preview.after, classification: preview.classification }
  },

  confirmAgentChange: async (name, id, hard, actor) => {
    const preview = agentConfigPreviews.consume(id)
    if (!preview || preview.agentName !== name) return { state: "not_found", restarted: [], fullRestart: [] }

    // Drift check: re-read disk fresh and compare against what the preview
    // captured as `before` — if someone else already changed this agent since
    // the preview was generated, refuse rather than silently clobber it.
    const current = readAgentsJson()
    const liveBefore = current[name] ?? null
    if (JSON.stringify(liveBefore) !== JSON.stringify(preview.before)) {
      return { state: "conflict", restarted: [], fullRestart: [] }
    }

    // Write to disk: add/replace/remove this one agent's entry.
    const next = { ...current }
    if (preview.after) next[name] = preview.after
    else delete next[name]
    writeAgentsJson(next)

    const restarted: string[] = []
    const fullRestart = [...preview.classification.fullRestart]
    if (preview.after) {
      // access is always safe to hot-swap regardless of this edit's overall tier.
      applySafeAgentFields(name, preview.after)
      if (hard && preview.classification.tier === "hard") {
        try {
          // The live `agents` registry always holds EXPANDED cwds (loadConfigs
          // expands `~` for every agent at boot) — but `preview.after` came from
          // readAgentsJson's raw on-disk shape (cwd still literally "~" when
          // that's what's on disk), by design, so the web editor's diff never
          // sees an expansion mismatch. Expand here, for the in-memory object
          // only, before it's used to respawn a live process — Bun.spawn does
          // NOT expand `~`, so passing the raw value through would spawn with a
          // nonexistent cwd (ENOENT) after the old process is already closed,
          // leaving the agent dead. Disk (already written above via
          // writeAgentsJson) correctly keeps the raw `~` form.
          agents[name] = { ...preview.after, runtime: { ...preview.after.runtime, cwd: expandHome(preview.after.runtime.cwd) } }
          await respawnAgent(name)
          restarted.push(name)
        } catch (e) {
          process.stderr.write(`agent config confirm: respawn ${name} failed: ${e}\n`)
          fullRestart.push(`respawn-failed:${name}`)
        }
      }
    }

    audit.record({
      kind: "event", actor: `web:${actor}`, action: "agent_config_change", target: name, outcome: "ok",
      detail: { before: preview.before, after: preview.after, classification: preview.classification },
    })

    return { state: "applied", restarted, fullRestart }
  },
}
const webServer = startWebServer(hub.webPort ?? 0, webDeps, hub.webHost)
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

// Sweep expired agent-config previews (5min TTL) so a stale preview id can
// never be silently confirmed after the operator's edit window has lapsed.
setInterval(() => { agentConfigPreviews.sweepExpired() }, 60_000).unref()

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

// Time out outbound peer asks (and inbound local-consults) whose answer never
// arrived. sweepExpired removes each entry and returns it; resolve once more.
if (peeringOn) {
  const sweep = setInterval(() => {
    for (const e of peerAskRegistry.sweepExpired()) {
      e.resolve("(peer ask timed out)")
      // Drop any peerAskByCorr side-index entry pointing at this swept channel so
      // the map can't grow under sustained outbound-ask timeouts.
      for (const [corr, ch] of peerAskByCorr) if (ch === e.channel) peerAskByCorr.delete(corr)
      audit.record({ kind: "liaison", actor: "hub", action: "timeout", target: e.target, outcome: "error", corr: e.id })
    }
  }, 5000)
  ;(sweep as { unref?: () => void }).unref?.()
}
