import { join } from "path"
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
import { shouldRunDailyAt, currentBucket } from "./scheduler"
import { drainApprovals } from "./approvals"
import { CardRegistry } from "./cardRegistry"
import { CardLifecycle } from "./cardLifecycle"
import { matchGatedAction, requiresApprover } from "./gatedActions"
import { isDeployAuthorized } from "./deployGate"
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
  const t = new StreamJsonTransport(name, cfg, {
    spawner,
    socket: new ShimSocketServer(socketPath),
    shimPath: SHIM_PATH,
    socketPath,
    mcpConfigPath: join(hub.stateDir, `${key}.mcp.json`),
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
  if (trig.setupCommand) {
    const code = await Bun.spawn(["sh", "-c", interpolate(trig.setupCommand, groups, jobId)],
      { stdout: "inherit", stderr: "inherit" }).exited
    if (code !== 0) { process.stderr.write(`spawn-trigger: setupCommand exited ${code}; aborting\n`); return }
  }
  const t = makeTransport(trig.agent, jobId, cfg)
  await t.start()
  if (trig.onSpawnCard) {
    const corr = interpolate(trig.onSpawnCard.correlationId, groups, jobId)
    await cardLifecycle.onUpdate(corr, chatId, buildSpawnCard(trig.onSpawnCard, groups, jobId), jobId)
  }
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

/** Deliver a synthesised system inbound to an agent scoped to a channel. */
function deliverToAgent(agentName: string, channelId: string, idTag: string, content: string): void {
  const ok = dispatcher.dispatch(agentName, channelId, {
    chatId: channelId, messageId: idTag, userId: "system", user: "hub",
    content, ts: new Date().toISOString(), isDM: false,
  })
  if (!ok) process.stderr.write(`deliver: agent "${agentName}" unavailable; skipping\n`)
}

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

// Schedules: fire daily at hourUtc (UTC), once per hour-bucket per id.
const scheduleBuckets = new Map<string, string | null>()
const schedules = hub.schedules ?? []
setInterval(() => {
  const now = new Date()
  for (const s of schedules) {
    const last = scheduleBuckets.get(s.id) ?? null
    if (shouldRunDailyAt(now, s.hourUtc, last)) {
      scheduleBuckets.set(s.id, currentBucket(now))
      deliverToAgent(s.agent, s.channelId, `schedule:${s.id}`, s.message)
    }
  }
}, 5 * 60 * 1000).unref()

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

const orchestrator = new Orchestrator(hub, agents, {
  baseGate: (userId, chatId, isDM) => baseGate.gate(userId, chatId, isDM, Date.now()),
  resolvePermission: () => false,   // tool permissions handled by --dangerously-skip-permissions
  resolveRoles: (id) => gateway.resolveRoles(id),
  route: (msg, permitted, current) =>
    routeFn({ message: msg, permitted, current }, routerRunner, hub.routerModel),
  dispatch: (agent, key, inbound) => dispatcher.dispatch(agent, key, inbound),
  isAvailable: (agent) => dispatcher.isAvailable(agent),
  sendPlain: (chatId, text) => gateway.sendPlain(chatId, text),
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
