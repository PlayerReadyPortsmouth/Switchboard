import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { HubConfig, AgentRegistry } from "./types"

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
}

export function loadConfigs(dir: string): { hub: HubConfig; agents: AgentRegistry } {
  const hub = JSON.parse(readFileSync(join(dir, "hub.config.json"), "utf8")) as HubConfig
  const agents = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")) as AgentRegistry

  hub.socketPath = expandHome(hub.socketPath)
  hub.stateDir = expandHome(hub.stateDir)
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
