export interface RouteInput {
  message: string
  permitted: { name: string; description: string }[]
  current: string | null
}
export interface RouteDecision {
  agent: string; confidence: number; switch: boolean
  /** The router's guess that answering well will take a while (multi-part, research,
   *  several specialists). Drives the hub's holding reply; never affects routing. */
  big?: boolean
}

export function buildRouterPrompt(input: RouteInput): { system: string; user: string } {
  const system =
    "You are a router. Choose exactly one agent to handle the user's message from the " +
    "provided list. Respond with ONLY a JSON object: " +
    '{"agent": "<name>", "confidence": <0..1>, "switch": <bool>, "big": <bool>}. ' +
    "confidence is how sure you are. switch is true only if the topic clearly changed " +
    "from the current agent. Prefer staying with the current agent when the message is a " +
    "follow-up. Never invent an agent name outside the list. big is true only if a good " +
    "answer will probably take more than about a minute of work: several distinct parts, " +
    "research or analysis, a long document, or input from more than one specialist. A " +
    "quick question, a greeting or a short follow-up is not big."
  const list = input.permitted.map(a => `- ${a.name}: ${a.description}`).join("\n")
  const user =
    `Current agent: ${input.current ?? "(none)"}\n\n` +
    `Available agents:\n${list}\n\n` +
    `User message:\n${input.message}`
  return { system, user }
}

/** The agent a message is plainly addressed to by name at its start: "Hey Bill, …",
 *  "Bill: …", "@bill can you…". Returns that agent only if the caller is permitted it.
 *
 *  Why this is not left to the model: stickiness. The router is told to prefer the
 *  current agent, and a switch needs its confidence to clear `switchThreshold`, so
 *  "Hey Bill, …" sent while bound to Ted was answered by Ted. A name at the front of a
 *  message is an instruction from the person, not a topic to be weighed.
 *
 *  Only the START of the message counts, so "Bill, ask Susie about X" addresses Bill and
 *  a passing "…as Bill said" addresses nobody. The longest matching name wins, so an
 *  agent called "Bill" never shadows one called "Billing". */
export function addressedAgent(message: string, permitted: string[]): string | null {
  const m = /^\s*(?:(?:hey|hi|hiya|hello|ok|okay|yo|morning|thanks|cheers|right|so)[\s,!]+)?@?([\p{L}\p{N}_.-]+)/iu.exec(message)
  if (!m) return null
  const word = m[1].toLowerCase()
  const rest = message.slice(m[0].length)
  // The name must end there: followed by punctuation, whitespace or the end.
  if (rest.length && !/^[\s,:;!?.\u2014-]/.test(rest)) return null
  const hits = permitted.filter(n => n.toLowerCase() === word)
  return hits.sort((a, b) => b.length - a.length)[0] ?? null
}

export function parseRouterOutput(raw: string, permitted: string[]): RouteDecision | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: any
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (typeof obj?.agent !== "string" || !permitted.includes(obj.agent)) return null
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0))
  return { agent: obj.agent, confidence, switch: Boolean(obj.switch), ...(obj.big === true ? { big: true } : {}) }
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
