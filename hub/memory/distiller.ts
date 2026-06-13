import type { ClaudeRunner } from "../router"

/** A note the distiller proposes writing. `scope` reuse of an existing title
 *  updates that note rather than creating a duplicate. */
export interface Upsert { scope: string; title: string; tags: string[]; body: string }

const SCOPE_RE = /^(global|users\/[^/]+|agents\/[^/]+|channels\/[^/]+)$/

export function isValidScope(scope: string): boolean { return SCOPE_RE.test(scope) }

export function buildDistillerPrompt(
  conversation: string, existing: { scope: string; title: string }[],
): { system: string; user: string } {
  const system =
    "You distill a conversation into durable MEMORY notes for future reference. " +
    "Capture only stable, reusable facts, preferences, decisions and learnings — " +
    "never transient chatter. Respond with ONLY JSON: " +
    '{"notes": [{"scope": "...", "title": "...", "tags": ["..."], "body": "..."}]}. ' +
    "Reuse a listed existing title (with its scope) to UPDATE that note instead of " +
    "duplicating. Valid scopes: global, users/<id>, agents/<name>, channels/<id>. " +
    'Return {"notes": []} if nothing is worth remembering.'
  const ex = existing.length
    ? existing.map((e) => `- [${e.scope}] ${e.title}`).join("\n")
    : "(none yet)"
  const user = `Existing notes (reuse titles to update):\n${ex}\n\nConversation:\n${conversation}`
  return { system, user }
}

/** Parse the distiller's JSON into validated upserts. Drops malformed notes and
 *  invalid scopes; dedupes by scope+title. Returns `null` if unparseable. */
export function parseDistillerOutput(raw: string): Upsert[] | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: { notes?: unknown }
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!Array.isArray(obj.notes)) return null
  const out: Upsert[] = []
  const seen = new Set<string>()
  for (const n of obj.notes as Record<string, unknown>[]) {
    const scope = String(n?.scope ?? "")
    const title = String(n?.title ?? "").trim()
    const body = String(n?.body ?? "").trim()
    if (!isValidScope(scope) || !title || !body) continue
    const key = `${scope}::${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const tags = Array.isArray(n?.tags) ? (n.tags as unknown[]).map(String) : []
    out.push({ scope, title, tags, body })
  }
  return out
}

/** Run the distiller over a conversation. Returns the upserts to apply (empty on
 *  any model/parse failure — distillation never blocks or throws). */
export async function distill(
  input: { conversation: string; existing: { scope: string; title: string }[] },
  run: ClaudeRunner, model: string,
): Promise<Upsert[]> {
  const { system, user } = buildDistillerPrompt(input.conversation, input.existing)
  try {
    const out = await run(
      ["-p", "--model", model, "--append-system-prompt", system, "--output-format", "text"],
      user,
    )
    return parseDistillerOutput(out) ?? []
  } catch {
    return []
  }
}
