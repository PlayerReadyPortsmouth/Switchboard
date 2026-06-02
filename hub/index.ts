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

const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const { hub, agents } = loadConfigs(CONFIG_DIR)

loadEnv(join(hub.stateDir, ".env"))   // load DISCORD_BOT_TOKEN if present
const token = process.env[hub.botTokenEnv]
if (!token) { console.error(`missing ${hub.botTokenEnv}`); process.exit(1) }

const gateway = new Gateway(hub, agents)
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

dispatcher.onReply(async reply => {
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

gateway.handleInbound(m => { void orchestrator.handleMessage(m) })
await gateway.start(token)
console.error("switchboard hub: gateway connected")

setInterval(() => {
  for (const { chatId } of drainApprovals(hub.stateDir)) {
    void gateway.sendPlain(chatId, "✅ Paired! You can talk to the agents now. Try `!agents`.")
  }
}, 5000).unref()
