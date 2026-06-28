import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { HubConfig, AgentRegistry } from "./types"

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
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

  hub.socketPath = expandHome(hub.socketPath)
  hub.stateDir = expandHome(hub.stateDir)
  if (hub.outboundAttachments?.outboxDir)
    hub.outboundAttachments.outboxDir = expandHome(hub.outboundAttachments.outboxDir)
  if (hub.shareLinks?.artifactsDir) hub.shareLinks.artifactsDir = expandHome(hub.shareLinks.artifactsDir)
  for (const a of Object.values(agents)) a.runtime.cwd = expandHome(a.runtime.cwd)

  if (!agents[hub.defaultAgent]) {
    throw new Error(`config: defaultAgent "${hub.defaultAgent}" is not in the agent registry`)
  }
  for (const [name, cfg] of Object.entries(agents)) {
    if (cfg.mode !== "persistent" && cfg.mode !== "ephemeral") {
      throw new Error(`config: agent "${name}" has invalid mode "${cfg.mode}"`)
    }
  }
  return { hub, agents }
}
