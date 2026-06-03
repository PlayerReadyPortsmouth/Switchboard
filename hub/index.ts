import { join } from "path"
import { config as loadEnv } from "./env"   // see note below
import { loadConfigs } from "./config"
import { BaseGate } from "./baseGate"
import { Gateway } from "./gateway"
import { Dispatcher } from "./transports/index"
import { HeadlessTransport } from "./transports/headless"
import { ChannelShimTransport } from "./transports/channelShim"
import { makeHeadlessRunner, makeRouterRunner } from "./transports/spawnClaude"
import { route as routeFn } from "./router"
import { Orchestrator } from "./orchestrator"
import { PermissionRouter } from "./permissions"
import { drainApprovals } from "./approvals"
import { NotifyRouter } from "./notifyRouter"
import { startWebhookListener, type WebhookHandler } from "./webhookListener"
import { shouldRunDailyAt, currentBucket } from "./scheduler"

const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const { hub, agents } = loadConfigs(CONFIG_DIR)

loadEnv(join(hub.stateDir, ".env"))   // load DISCORD_BOT_TOKEN if present
const token = process.env[hub.botTokenEnv]
if (!token) { console.error(`missing ${hub.botTokenEnv}`); process.exit(1) }

const gateway = new Gateway(hub, agents)
// Set the deploy approver from config so the gateway gate is active at startup.
gateway.setDeployApprover(hub.deployApproverUserId ?? "")
const routerRunner = makeRouterRunner()
const headlessRunner = makeHeadlessRunner()

const transports = []
const shims: Record<string, ChannelShimTransport> = {}
for (const [name, cfg] of Object.entries(agents)) {
  if (cfg.mode === "ephemeral") {
    transports.push(new HeadlessTransport(name, cfg, headlessRunner, hub.ephemeralTimeoutMs))
  } else {
    const t = new ChannelShimTransport(name, join(hub.stateDir, `${name}.sock`))
    await t.listen()
    shims[name] = t
    transports.push(t)
  }
}
const dispatcher = new Dispatcher(transports)

// Monotonic job-id counter for spawn triggers (Date.now/Math.random forbidden).
let jobCounter = 0
const nextJobId = (): string => `job-${++jobCounter}`

/** Interpolate $1,$2… (regex capture groups) and $jobId into a template. */
function interpolate(tmpl: string, groups: string[], jobId: string): string {
  return tmpl.replace(/\$(\d+|jobId)/g, (_, tok: string) => {
    if (tok === "jobId") return jobId
    const idx = Number(tok)
    return groups[idx] ?? ""
  })
}

/** Spawn an ephemeral agent to run an interpolated task, optionally after a
 *  setup shell command. Used by spawnTriggers — e.g. a consumer can run a
 *  setupCommand that creates a worktree, then hand the agent a task in it.
 *
 * Note: the spawned agent runs as a one-shot HeadlessTransport, so it cannot
 * post interactive cards back (headless is text-result-only). It receives the
 * task context and its text reply is relayed to Discord. The deploy gate
 * (isDeployAuthorized) remains enforced in the gateway regardless. */
async function runSpawnTrigger(
  trig: import("./types").SpawnTrigger, groups: string[], chatId: string,
): Promise<void> {
  const cfg = agents[trig.agent]
  if (!cfg) {
    process.stderr.write(`spawn-trigger: agent "${trig.agent}" not found in registry\n`)
    return
  }
  const jobId = nextJobId()
  if (trig.setupCommand) {
    const cmd = interpolate(trig.setupCommand, groups, jobId)
    try {
      const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit" })
      const code = await proc.exited
      if (code !== 0) {
        process.stderr.write(`spawn-trigger: setupCommand exited ${code}; aborting spawn\n`)
        return
      }
    } catch (e) {
      process.stderr.write(`spawn-trigger: setupCommand failed: ${e}\n`)
      return
    }
  }
  const task = interpolate(trig.taskTemplate, groups, jobId)
  const transport = new HeadlessTransport(trig.agent, cfg, headlessRunner, hub.ephemeralTimeoutMs)
  transport.onReply(reply => { void gateway.sendReply(reply, cfg) })
  transport.deliver(jobId, {
    chatId,
    messageId: `spawn:${jobId}`,
    userId: "system", user: "hub",
    content: task,
    ts: new Date().toISOString(), isDM: false,
  })
}

const spawnTriggers = (hub.spawnTriggers ?? []).map(t => ({ ...t, re: new RegExp(t.pattern) }))

dispatcher.onReply(async reply => {
  // Config-driven spawn triggers: any agent's outbound text matching a pattern
  // fires the corresponding ephemeral spawn (and is NOT forwarded to Discord).
  if (reply.text) {
    for (const trig of spawnTriggers) {
      const m = trig.re.exec(reply.text)
      if (m) {
        await runSpawnTrigger(trig, m as unknown as string[], reply.chatId)
        return
      }
    }
  }
  await gateway.sendReply(reply, agents[reply.agent])
})

const baseGate = new BaseGate(join(hub.stateDir, "access.json"))

const permRouter = new PermissionRouter()

// Only allowlisted users may answer permission prompts.
gateway.setPermissionAuthorizer(uid => baseGate.listAllowed().includes(uid))

// A persistent agent's shim raised a tool-permission request → prompt the allowlist.
for (const [name, shim] of Object.entries(shims)) {
  shim.onPermissionRequest(req => {
    permRouter.register(req.requestId, name)
    void gateway.sendPermissionPrompt(baseGate.listAllowed(), req.requestId, req.toolName)
  })
}

// A button click → route the answer back to the originating agent's shim.
gateway.onPermissionButton((requestId, behavior) => {
  const agent = permRouter.resolve(requestId)
  if (agent) shims[agent]?.sendPermissionResult(requestId, behavior)
})

const notifyRouter = new NotifyRouter()

// Agent → hub: agent posts a card. Record its button ids → agent, then post it.
for (const [name, shim] of Object.entries(shims)) {
  shim.onNotify(({ chatId, card, correlationId }) => {
    notifyRouter.register(card.buttons.map((b) => b.customId), name)
    void gateway.sendCard(chatId, card)
  })
}

// Hub → agent: a card button was clicked → relay to the owning agent's shim.
gateway.onNotifyButton((customId, userId) => {
  const agent = notifyRouter.agentFor(customId)
  if (agent) shims[agent]?.sendInteractionResult(customId, userId)
})

/** Deliver a synthesised system inbound to a persistent agent scoped to a channel. */
function deliverToAgent(agentName: string, channelId: string, idTag: string, content: string): void {
  const shim = shims[agentName]
  if (!shim) {
    process.stderr.write(`deliver: agent "${agentName}" is not a connected persistent agent; skipping\n`)
    return
  }
  shim.deliver(channelId, {
    chatId: channelId,
    messageId: idTag,
    userId: "system", user: "hub",
    content,
    ts: new Date().toISOString(), isDM: false,
  })
}

// Webhooks: one HTTP listener on webhookPort; each route HMAC-verifies with its
// secretEnv and delivers "{prefix} {rawBody}" to its agent scoped to channelId.
const webhookHandlers: WebhookHandler[] = (hub.webhooks ?? []).map((w) => ({
  path: w.path,
  secret: process.env[w.secretEnv] ?? "",
  onBody: (rawBody: string) => {
    const content = w.prefix ? `${w.prefix} ${rawBody}` : rawBody
    deliverToAgent(w.agent, w.channelId, `webhook:${w.path}`, content)
  },
}))
const listener = startWebhookListener(hub.webhookPort ?? 0, webhookHandlers)
// on shutdown: listener?.stop()

// Schedules: each fires daily at hourUtc (UTC), delivering message to agent@channel.
// One run-bucket is tracked per schedule id so a schedule fires once per hour.
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

const orchestrator = new Orchestrator(hub, agents, {
  baseGate: (userId, chatId, isDM) => baseGate.gate(userId, chatId, isDM, Date.now()),
  resolvePermission: (code, behavior) => {
    const agent = permRouter.resolve(code)
    if (!agent) return false
    shims[agent]?.sendPermissionResult(code, behavior)
    return true
  },
  resolveRoles: id => gateway.resolveRoles(id),
  route: (msg, permitted, current) =>
    routeFn({ message: msg, permitted, current }, routerRunner, hub.routerModel),
  dispatch: (agent, key, inbound) => dispatcher.dispatch(agent, key, inbound),
  isAvailable: agent => dispatcher.isAvailable(agent),
  sendPlain: (chatId, text) => gateway.sendPlain(chatId, text),
})

// Commands: an inbound message whose trimmed content equals `match` delivers
// `message` to agent@channel (gated by the base-gate allowlist if allowlistOnly).
const commands = hub.commands ?? []
gateway.handleInbound(m => {
  const trimmed = m.content.trim()
  const cmd = commands.find(c => c.match === trimmed)
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
