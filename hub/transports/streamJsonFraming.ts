import { parseUsage, parseUsageObj } from "../usage"
import type { TurnUsage } from "../types"

/** A parsed stdout stream-json event we care about. */
export type StreamEvent =
  | { kind: "result"; text: string; usage?: TurnUsage }
  | { kind: "assistant"; usage?: TurnUsage; tools?: { id: string; name: string }[] }
  | { kind: "tool_result"; results: { id: string; isError: boolean }[] }
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
  if (ev.type === "assistant") {
    // The assistant message's own usage is this single call's prompt size ≈ the
    // live context fill (bounded by the window), unlike the cumulative result usage.
    const usage = parseUsageObj(ev.message?.usage)
    const content = Array.isArray(ev.message?.content) ? ev.message.content : []
    const tools = content
      .filter((b: any) => b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
      .map((b: any) => ({ id: b.id as string, name: b.name as string }))
    const out: Extract<StreamEvent, { kind: "assistant" }> = { kind: "assistant" }
    if (usage) out.usage = usage
    if (tools.length) out.tools = tools
    return out
  }
  if (ev.type === "user") {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : []
    const results = content
      .filter((b: any) => b?.type === "tool_result" && typeof b.tool_use_id === "string")
      .map((b: any) => ({ id: b.tool_use_id as string, isError: !!b.is_error }))
    return results.length ? { kind: "tool_result", results } : null
  }
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

/** Guidance appended to every interactive (card-posting) agent's system prompt,
 *  steering them to collect structured answers from the user via Discord modals
 *  (popup forms) instead of prose, and to handle Discord's hard 5-field-per-modal
 *  cap by splitting larger question sets across multiple buttons. Shipped in code
 *  so it applies to all stream-json agents without per-agent config. */
export const INTERACTION_GUIDANCE = [
  "## Asking the user questions",
  "When you need specific answers from the user, prefer a Discord modal (a popup form) over asking in prose — especially when you have several questions at once. Post a card with `post_card` whose button carries a `modal`: give the modal a `title` and up to 5 `inputs`, each with an `id`, a `label`, and a `style` of \"short\" or \"paragraph\" (mark the essential ones `required`, add a `placeholder` to hint the expected answer). The user clicks the button, fills the form, and you receive their answers as one message of the form `[interaction] custom_id=<id> user_id=<id> fields={...}`, where the `fields` object is keyed by your input `id`s.",
  "A modal can only open from a button click, so always present it behind a button — you cannot pop one unprompted, and a modal cannot be opened in response to another modal's submission.",
  "Discord caps a modal at 5 fields. If you need more than 5 answers, do NOT cram them into one modal (the extra fields are silently dropped). Instead put several buttons on the one card, each opening its own modal of ≤5 related fields (e.g. buttons labelled \"Scope\", \"Deployment\", \"Risks\"). Each button's answers arrive as a separate interaction message that you correlate by its `custom_id`.",
].join("\n\n")

/** Build the argv for a stream-json agent process. The interaction guidance is
 *  always appended (before any per-agent prompt) so every card-posting agent
 *  knows to use modals. */
export function buildClaudeArgv(o: ClaudeArgvOpts): string[] {
  const argv = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", o.mcpConfigPath, "--strict-mcp-config",
    "--dangerously-skip-permissions",
  ]
  if (o.resumeSessionId) argv.push("--resume", o.resumeSessionId)
  if (o.model) argv.push("--model", o.model)
  const system = o.appendSystemPrompt
    ? `${INTERACTION_GUIDANCE}\n\n${o.appendSystemPrompt}`
    : INTERACTION_GUIDANCE
  argv.push("--append-system-prompt", system)
  if (o.claudeArgs?.length) argv.push(...o.claudeArgs)
  return argv
}

/** The --mcp-config object registering the shim as a normal MCP server. The shim
 *  is launched by Claude as an MCP server and sees ONLY this `env` block (not the
 *  hub's process.env), so per-feature tool gates must be injected here.
 *  `consultEnabled` sets CONSULT=1 (exposes ask_agent); `attachEnabled` sets
 *  ATTACH_FILES=1 (exposes attach_file). */
export function buildShimMcpConfig(shimPath: string, socketPath: string, agentName: string, consultEnabled = false, attachEnabled = false, publishEnabled = false) {
  return {
    mcpServers: {
      "switchboard-shim": {
        command: "bun", args: ["run", shimPath],
        env: {
          HUB_SOCKET: socketPath, AGENT_NAME: agentName,
          ...(consultEnabled ? { CONSULT: "1" } : {}),
          ...(attachEnabled ? { ATTACH_FILES: "1" } : {}),
          ...(publishEnabled ? { PUBLISH_LINK: "1" } : {}),
        },
      },
    },
  }
}
