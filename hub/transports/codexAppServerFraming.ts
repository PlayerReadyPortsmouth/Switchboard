import type { TurnUsage } from "../types"
import { INTERACTION_GUIDANCE } from "./streamJsonFraming"

export type CodexMessage =
  | { kind: "response"; id: number; result?: unknown; error?: { code?: number; message: string } }
  | { kind: "request"; id: number; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }

export interface CodexAppServerArgvOpts {
  shimPath: string
  socketPath: string
  agentName: string
  appendSystemPrompt?: string
  codexArgs?: string[]
  consultEnabled?: boolean
  attachEnabled?: boolean
  publishEnabled?: boolean
  peeringEnabled?: boolean
  receiptsEnabled?: boolean
}

export function rpcRequest(id: number, method: string, params: unknown): string {
  return JSON.stringify({ id, method, params }) + "\n"
}

export function rpcNotification(method: string, params: unknown): string {
  return JSON.stringify({ method, params }) + "\n"
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

export function parseCodexMessage(line: string): CodexMessage | null {
  const text = line.trim()
  if (!text) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!record(value)) return null

  if (typeof value.id === "number") {
    if (typeof value.method === "string") {
      const out: Extract<CodexMessage, { kind: "request" }> = { kind: "request", id: value.id, method: value.method }
      if ("params" in value) out.params = value.params
      return out
    }
    if ("result" in value || "error" in value) {
      const out: Extract<CodexMessage, { kind: "response" }> = { kind: "response", id: value.id }
      if ("result" in value) out.result = value.result
      if (record(value.error) && typeof value.error.message === "string") {
        out.error = {
          ...(typeof value.error.code === "number" ? { code: value.error.code } : {}),
          message: value.error.message,
        }
      }
      return out
    }
  }

  if (typeof value.method === "string") {
    const out: Extract<CodexMessage, { kind: "notification" }> = { kind: "notification", method: value.method }
    if ("params" in value) out.params = value.params
    return out
  }
  return null
}

function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0 }

function findUsage(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!record(value) || depth > 5) return undefined
  const keys = ["inputTokens", "input_tokens", "cachedInputTokens", "cached_input_tokens", "outputTokens", "output_tokens"]
  if (keys.some(key => key in value)) return value
  for (const child of Object.values(value)) {
    const found = findUsage(child, depth + 1)
    if (found) return found
  }
  return undefined
}

/** Map app-server's current or cumulative token object into Switchboard usage. */
export function codexUsage(value: unknown): TurnUsage | undefined {
  const usage = findUsage(value)
  if (!usage) return undefined
  return {
    inputTokens: finite(usage.inputTokens ?? usage.input_tokens),
    cacheReadTokens: finite(usage.cachedInputTokens ?? usage.cached_input_tokens),
    cacheCreationTokens: 0,
    outputTokens: finite(usage.outputTokens ?? usage.output_tokens),
  }
}

const toml = (value: string | string[]): string => JSON.stringify(value)

/** Build global Codex config overrides followed by the stdio app-server command. */
export function buildCodexAppServerArgv(o: CodexAppServerArgvOpts): string[] {
  const argv = [
    "-c", `mcp_servers.switchboard-shim.command=${toml("bun")}`,
    "-c", `mcp_servers.switchboard-shim.args=${toml(["run", o.shimPath])}`,
    "-c", "mcp_servers.switchboard-shim.required=true",
    "-c", `mcp_servers.switchboard-shim.env.HUB_SOCKET=${toml(o.socketPath)}`,
    "-c", `mcp_servers.switchboard-shim.env.AGENT_NAME=${toml(o.agentName)}`,
  ]
  const gates: Array<[boolean | undefined, string]> = [
    [o.consultEnabled, "CONSULT"],
    [o.attachEnabled, "ATTACH_FILES"],
    [o.publishEnabled, "PUBLISH_LINK"],
    [o.peeringEnabled, "PEERING"],
    [o.receiptsEnabled, "RECEIPTS"],
  ]
  for (const [enabled, name] of gates) {
    if (enabled) argv.push("-c", `mcp_servers.switchboard-shim.env.${name}=${toml("1")}`)
  }
  const guidance = o.appendSystemPrompt
    ? `${INTERACTION_GUIDANCE}\n\n${o.appendSystemPrompt}`
    : INTERACTION_GUIDANCE
  argv.push("-c", `developer_instructions=${toml(guidance)}`)
  if (o.codexArgs?.length) argv.push(...o.codexArgs)
  argv.push("app-server", "--listen", "stdio://")
  return argv
}
