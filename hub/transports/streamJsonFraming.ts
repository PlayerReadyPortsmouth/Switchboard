import { parseUsage } from "../usage"
import type { TurnUsage } from "../types"

/** A parsed stdout stream-json event we care about. */
export type StreamEvent =
  | { kind: "result"; text: string; usage?: TurnUsage }
  | { kind: "assistant" }
  | { kind: "init"; sessionId: string }

/** Parse one newline-delimited stream-json stdout line. Returns null for noise. */
export function parseStreamEvent(line: string): StreamEvent | null {
  const s = line.trim()
  if (!s) return null
  let ev: any
  try { ev = JSON.parse(s) } catch { return null }
  if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string")
    return { kind: "init", sessionId: ev.session_id }
  if (ev.type === "result" && typeof ev.result === "string") {
    const usage = parseUsage(ev)
    return usage ? { kind: "result", text: ev.result, usage } : { kind: "result", text: ev.result }
  }
  if (ev.type === "assistant") return { kind: "assistant" }
  return null
}

/** A stream-json user message line (newline-terminated) for the agent's stdin. */
export function userMessageFrame(text: string): string {
  return JSON.stringify({
    type: "user", message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n"
}

/** A button click (and optional modal fields) delivered to the agent as a
 *  tagged user message. */
export function interactionFrame(
  customId: string, userId: string, fields?: Record<string, string>,
): string {
  const base = `[interaction] custom_id=${customId} user_id=${userId}`
  const suffix = fields && Object.keys(fields).length ? ` fields=${JSON.stringify(fields)}` : ""
  return userMessageFrame(base + suffix)
}

export interface ClaudeArgvOpts {
  mcpConfigPath: string
  model?: string
  appendSystemPrompt?: string
  claudeArgs?: string[]
  resumeSessionId?: string
}

/** Build the argv for a stream-json agent process. */
export function buildClaudeArgv(o: ClaudeArgvOpts): string[] {
  const argv = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", o.mcpConfigPath, "--strict-mcp-config",
    "--dangerously-skip-permissions",
  ]
  if (o.resumeSessionId) argv.push("--resume", o.resumeSessionId)
  if (o.model) argv.push("--model", o.model)
  if (o.appendSystemPrompt) argv.push("--append-system-prompt", o.appendSystemPrompt)
  if (o.claudeArgs?.length) argv.push(...o.claudeArgs)
  return argv
}

/** The --mcp-config object registering the shim as a normal MCP server.
 *  `consultEnabled` sets CONSULT=1 so the shim exposes the ask_agent tool. */
export function buildShimMcpConfig(shimPath: string, socketPath: string, agentName: string, consultEnabled = false) {
  return {
    mcpServers: {
      "switchboard-shim": {
        command: "bun", args: ["run", shimPath],
        env: { HUB_SOCKET: socketPath, AGENT_NAME: agentName, ...(consultEnabled ? { CONSULT: "1" } : {}) },
      },
    },
  }
}
