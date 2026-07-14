import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { HubConfig, AgentRegistry } from "./types"

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
}

export function resolveDiscordStartup(
  config: Pick<HubConfig, "discord" | "botTokenEnv">,
  env: Record<string, string | undefined>,
): { enabled: false } | { enabled: true; token: string } {
  if (config.discord?.enabled === false) return { enabled: false }
  const name = config.botTokenEnv ?? "DISCORD_BOT_TOKEN"
  const token = env[name]
  if (!token) throw new Error(`missing ${name}`)
  return { enabled: true, token }
}

export function createDiscordRuntime<T>(
  startup: { enabled: false } | { enabled: true; token: string },
  create: (token: string) => T,
): T | undefined {
  return startup.enabled ? create(startup.token) : undefined
}

function validateWorkspaceAccess(hub: HubConfig): void {
  for (const [name, value] of [["viewers", hub.workspace?.viewers], ["operators", hub.workspace?.operators]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry))) {
      throw new Error(`config: workspace.${name} must be a non-empty string array`)
    }
  }
}

function readConfigFile(dir: string, file: string, hint: string): string {
  try {
    return readFileSync(join(dir, file), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`config: config/${file} not found — ${hint}`)
    }
    throw err
  }
}

export function loadConfigs(dir: string): { hub: HubConfig; agents: AgentRegistry } {
  const hub = JSON.parse(
    readConfigFile(dir, "hub.config.json", "copy config/hub.config.json into place and set guildIds"),
  ) as HubConfig
  const agents = JSON.parse(
    readConfigFile(dir, "agents.json", "copy config/agents.example.json to config/agents.json"),
  ) as AgentRegistry

  hub.discord = { ...hub.discord, enabled: hub.discord?.enabled !== false }
  hub.webIdentityHeader = hub.webIdentityHeader?.trim() || "X-Switchboard-User"
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(hub.webIdentityHeader)) {
    throw new Error("config: webIdentityHeader must be a valid HTTP header name")
  }
  validateWorkspaceAccess(hub)

  hub.socketPath = expandHome(hub.socketPath)
  hub.stateDir = expandHome(hub.stateDir)
  if (hub.conversationDbFile) hub.conversationDbFile = expandHome(hub.conversationDbFile)
  if (hub.outboundAttachments?.outboxDir)
    hub.outboundAttachments.outboxDir = expandHome(hub.outboundAttachments.outboxDir)
  if (hub.shareLinks?.artifactsDir) hub.shareLinks.artifactsDir = expandHome(hub.shareLinks.artifactsDir)
  for (const a of Object.values(agents)) a.runtime.cwd = expandHome(a.runtime.cwd)

  if (!agents[hub.defaultAgent]) {
    throw new Error(`config: defaultAgent "${hub.defaultAgent}" is not in the agent registry`)
  }
  if (agents[hub.defaultAgent].mode !== "persistent") {
    throw new Error(`config: defaultAgent "${hub.defaultAgent}" must name a persistent agent`)
  }
  for (const [name, cfg] of Object.entries(agents)) {
    if (cfg.mode !== "persistent" && cfg.mode !== "ephemeral") {
      throw new Error(`config: agent "${name}" has invalid mode "${cfg.mode}"`)
    }
  }
  if (hub.federation?.enabled) {
    const f = hub.federation
    if (!f.name) throw new Error("config: federation.name is required when federation.enabled")
    if (!f.listenAddr || !f.listenAddr.includes(":")) {
      throw new Error(`config: federation.listenAddr must be "host:port" (got "${f.listenAddr}")`)
    }
    for (const [peer, p] of Object.entries(f.peers ?? {})) {
      if (!p.addr || !p.addr.includes(":")) {
        throw new Error(`config: federation.peers.${peer}.addr must be "host:port"`)
      }
      if (!p.authKeyEnv) {
        throw new Error(`config: federation.peers.${peer}.authKeyEnv is required`)
      }
    }
  }
  return { hub, agents }
}
