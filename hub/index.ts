import { join } from "path"
import { unlinkSync, appendFileSync, mkdirSync } from "fs"
import { config as loadEnv } from "./env"
import { loadConfigs } from "./config"
import { BaseGate } from "./baseGate"
import { Gateway } from "./gateway"
import { Dispatcher } from "./transports/index"
import { StreamJsonTransport, makeBunProcessSpawner } from "./transports/streamJson"
import { ShimSocketServer } from "./transports/shimSocket"
import { makeRouterRunner } from "./transports/spawnClaude"
import { route as routeFn } from "./router"
import { Orchestrator } from "./orchestrator"
import { NotifyRouter } from "./notifyRouter"
import { startWebhookListener, type WebhookHandler } from "./webhookListener"
import { cronMatches, minuteBucket, scheduleCron } from "./scheduler"
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
import type { AgentConfig, AgentReply, SpawnTrigger, SpawnCardUpdate, CardSpec } from "./types"

const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const { hub, agents } = loadConfigs(CONFIG_DIR)

loadEnv(join(hub.stateDir, ".env"))   // load DISCORD_BOT_TOKEN + agent env if present
const token = process.env[hub.botTokenEnv]
if (!token) { console.error(`missing ${hub.botTokenEnv}`); process.exit(1) }

const gateway = new Gateway(hub, agents)
const deployApprover = hub.deployApproverUserId ?? ""
gateway.setNotifyButtonGate((customId, userId) =>
  isDeployAuthorized(customId, userId, deployApprover) &&
  (requiresApprover(customId, hub.gatedActions ?? []) ? !!deployApprover && userId === deployApprover : true))
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
  const t = new StreamJsonTransport(name, cfg, {
    spawner,
    socket,
    shimPath: SHIM_PATH,
    socketPath,
    mcpConfigPath: join(hub.stateDir, `${key}.mcp.json`),
    resumable: cfg.runtime.resumable === true,
    sessionPath: join(hub.stateDir, `${key}.session`),
  })
  t.onReply((reply) => { void onAgentReply(reply, key) })
  transports.set(key, t)
  return t
}

// Spawn triggers: any agent's outbound text matching `pattern` fires an
// ephemeral spawn (and is NOT forwarded to Discord).
const spawnTriggers = (hub.spawnTriggers ?? []).map((t) => ({ ...t, re: new RegExp(t.pattern) }))

/** Handle one reply from a transport: cards → Discord card (+ register buttons);
 *  text → spawn-trigger match or a plain reply; react/edit → passthrough. */
async function onAgentReply(reply: AgentReply, key: string): Promise<void> {
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
      if (m) { await runSpawnTrigger(trig, m as unknown as string[], reply.chatId); return }
    }
    // Overseer: for opt-in agents, judge the turn against the goal and either
    // swallow it (a nudge was delivered → another turn coming) or ship it.
    if (agents[reply.agent]?.runtime.overseer?.enabled) {
      const v = await overseer.intercept(reply.agent, reply.chatId, reply.text)
      if (!v.forward) return
      if (v.footer) reply.text = `${reply.text}\n\n${v.footer}`
    }
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
      const cmd = teardownCmd()
      if (cmd) void Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit" }).exited
    }
  }, 10_000)
  tick.unref()
}

/** Spawn an ephemeral agent (a full stream-json session) to run a task, optionally
 *  after a setup shell command, and clean up when it exits. */
async function runSpawnTrigger(trig: SpawnTrigger, groups: string[], chatId: string): Promise<void> {
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
  // The matched trigger text is consumed (not shown); confirm the spawn to the channel.
  if (!trig.onSpawnCard) void gateway.sendPlain(chatId, `🔧 \`${trig.agent}\` agent dispatched (job ${jobId}).`)
  scheduleTeardown(jobId, t, () => (trig.teardownCommand ? interpolate(trig.teardownCommand, groups, jobId) : undefined))
}

// Persistent agents: spawn at boot; they receive webhook/schedule/command/interaction deliveries.
const dispatchTransports: StreamJsonTransport[] = []
for (const [name, cfg] of Object.entries(agents)) {
  if (cfg.mode === "persistent") {
    const t = makeTransport(name, name, cfg)
    await t.start()
    dispatchTransports.push(t)
  }
}
const dispatcher = new Dispatcher(dispatchTransports)
// Dispatcher's constructor re-binds each transport's onReply to its own aggregator,
// so route that aggregator back to onAgentReply. For persistent agents the routing
// key is the agent name (== reply.agent). (Ephemeral spawn transports are not in the
// Dispatcher and keep the onReply set in makeTransport, keyed by jobId.)
dispatcher.onReply((reply) => { void onAgentReply(reply, reply.agent) })

/** Clear a persistent agent's context: drop its session file + respawn fresh. */
async function resetAgentSession(name: string, channelId: string): Promise<void> {
  const cfg = agents[name]
  if (!cfg) return
  try { unlinkSync(join(hub.stateDir, `${name}.session`)) } catch {}
  const old = transports.get(name)
  if (old) { await old.close(); transports.delete(name) }
  const fresh = makeTransport(name, name, cfg)   // resumable, but the session file is now gone → fresh session
  await fresh.start()
  dispatcher.replace(name, fresh)
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

const baseGate = new BaseGate(join(hub.stateDir, "access.json"))

// Only allowlisted users may press card buttons.
gateway.setPermissionAuthorizer((uid) => baseGate.listAllowed().includes(uid))

// A card button was clicked → gated actions run hub-side; others relay to the agent.
gateway.onNotifyButton((customId, userId) => {
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

// Schedules: fire on a 5-field cron expression (UTC), once per minute-bucket per
// id. Checked every 30s; the per-id minute bucket prevents a double-fire.
const scheduleBuckets = new Map<string, string | null>()
const schedules = (hub.schedules ?? []).map((s) => ({ s, cron: scheduleCron(s) }))
setInterval(() => {
  const now = new Date()
  for (const { s, cron } of schedules) {
    if (!cron || !cronMatches(cron, now)) continue
    const bucket = minuteBucket(now)
    if (scheduleBuckets.get(s.id) === bucket) continue   // already fired this minute
    scheduleBuckets.set(s.id, bucket)
    deliverToAgent(s.agent, s.channelId, `schedule:${s.id}`, s.message)
  }
}, 30 * 1000).unref()

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
  baseGate: (userId, chatId, isDM) => baseGate.gate(userId, chatId, isDM, Date.now()),
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
    // Render context from PRIOR turns, then record this inbound so it's available
    // next turn (and to the distiller) without duplicating it in this turn's block.
    const policy = rt?.injectContext ?? "onSwitch"
    const wantContext = policy === "always" || (policy === "onSwitch" && isSwitch)
    const context = wantContext ? messageCache.render(inbound.chatId) : ""
    // Fold any quote-reply target into the live message so the agent sees it.
    const live = foldQuote(inbound.content, inbound.quote)
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

// Commands: an inbound whose trimmed content equals `match` delivers `message`
// to agent@channel (gated by the base-gate allowlist if allowlistOnly).
const commands = hub.commands ?? []
gateway.handleInbound((m) => {
  const trimmed = m.content.trim()
  const cmd = commands.find((c) => c.match === trimmed)
  if (cmd) {
    if (cmd.allowlistOnly && !baseGate.listAllowed().includes(m.userId)) return
    deliverToAgent(cmd.agent, cmd.channelId, `command:${cmd.match}`, cmd.message)
    void gateway.sendPlain(m.chatId, `✅ Command \`${cmd.match}\` triggered.`)
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
