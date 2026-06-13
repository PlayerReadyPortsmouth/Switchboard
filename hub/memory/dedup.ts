import type { ClaudeRunner } from "../router"

/** Agent-authored notes are sacred — never auto-merged or deleted, only flagged. */
export function isProtected(source: string): boolean { return source.startsWith("agent:") }

export type DedupAction = "merge" | "flag"
/** Given a CONFIRMED same-fact pair, decide the action. If either note is
 *  agent-authored we only flag (propose) the duplicate; auto-merge is reserved
 *  for distiller-generated notes. */
export function dedupAction(sourceA: string, sourceB: string): DedupAction {
  return isProtected(sourceA) || isProtected(sourceB) ? "flag" : "merge"
}

interface NoteLite { title: string; body: string }

export function buildEntityGatePrompt(a: NoteLite, b: NoteLite): { system: string; user: string } {
  const system =
    "You decide whether two memory notes record the SAME fact or DISTINCT facts. " +
    "Two notes describing the SAME kind of situation but about DIFFERENT people, entities, " +
    "projects, or with different outcomes are DISTINCT — NOT the same. " +
    'Respond with ONLY JSON: {"same": <bool>}.'
  const user = `Note A:\n# ${a.title}\n${a.body}\n\nNote B:\n# ${b.title}\n${b.body}`
  return { system, user }
}

/** Parse the entity gate's JSON; null when unparseable / missing `same`. */
export function parseEntityGate(raw: string): boolean | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: { same?: unknown }
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  return typeof obj.same === "boolean" ? obj.same : null
}

/** LLM entity gate. Fail-safe: any error/garble ⇒ "unknown" (treated as distinct
 *  by callers, so uncertainty never triggers a merge). */
export async function entityGate(
  a: NoteLite, b: NoteLite, run: ClaudeRunner, model: string,
): Promise<"same" | "distinct" | "unknown"> {
  const { system, user } = buildEntityGatePrompt(a, b)
  try {
    const out = await run(
      ["-p", "--model", model, "--append-system-prompt", system, "--output-format", "text"], user,
    )
    const v = parseEntityGate(out)
    return v === null ? "unknown" : v ? "same" : "distinct"
  } catch {
    return "unknown"
  }
}
