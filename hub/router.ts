export interface RouteInput {
  message: string
  permitted: { name: string; description: string }[]
  current: string | null
}
export interface RouteDecision { agent: string; confidence: number; switch: boolean }

export function buildRouterPrompt(input: RouteInput): { system: string; user: string } {
  const system =
    "You are a router. Choose exactly one agent to handle the user's message from the " +
    "provided list. Respond with ONLY a JSON object: " +
    '{"agent": "<name>", "confidence": <0..1>, "switch": <bool>}. ' +
    "confidence is how sure you are. switch is true only if the topic clearly changed " +
    "from the current agent. Prefer staying with the current agent when the message is a " +
    "follow-up. Never invent an agent name outside the list."
  const list = input.permitted.map(a => `- ${a.name}: ${a.description}`).join("\n")
  const user =
    `Current agent: ${input.current ?? "(none)"}\n\n` +
    `Available agents:\n${list}\n\n` +
    `User message:\n${input.message}`
  return { system, user }
}

export function parseRouterOutput(raw: string, permitted: string[]): RouteDecision | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: any
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (typeof obj?.agent !== "string" || !permitted.includes(obj.agent)) return null
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0))
  return { agent: obj.agent, confidence, switch: Boolean(obj.switch) }
}

/** Runner contract: given claude args + stdin, resolve stdout. Injected for testability. */
export type ClaudeRunner = (args: string[], stdin: string) => Promise<string>

export async function route(
  input: RouteInput,
  run: ClaudeRunner,
  model: string,
): Promise<RouteDecision | null> {
  const { system, user } = buildRouterPrompt(input)
  try {
    const out = await run(
      ["-p", "--model", model, "--append-system-prompt", system, "--output-format", "text"],
      user,
    )
    return parseRouterOutput(out, input.permitted.map(a => a.name))
  } catch {
    return null
  }
}
