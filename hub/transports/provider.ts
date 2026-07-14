import { join } from "path"
import type { AgentProvider, AgentRuntime } from "../types"

export function agentProvider(runtime: AgentRuntime): AgentProvider {
  return runtime.provider ?? "claude"
}

export function sessionPathFor(stateDir: string, key: string, provider: AgentProvider): string {
  return join(stateDir, provider === "codex" ? `${key}.codex-thread` : `${key}.session`)
}
