import type { ClaudeRunner } from "../router"

/** A note offered to the librarian for relevance judgement. */
export interface Candidate { path: string; title: string; tags: string[]; summary: string }

export function buildLibrarianPrompt(query: string, candidates: Candidate[]): { system: string; user: string } {
  const system =
    "You are a memory librarian. From the numbered notes, choose ONLY those clearly " +
    "relevant to the user's message. Respond with ONLY a JSON object: " +
    '{"picks": [<indices>]}. Use [] if none are relevant. Never invent an index.'
  const list = candidates
    .map((c, i) => `[${i}] ${c.title}${c.tags.length ? ` (${c.tags.join(", ")})` : ""}\n    ${c.summary}`)
    .join("\n")
  const user = `User message:\n${query}\n\nNotes:\n${list}`
  return { system, user }
}

/** Parse the librarian's JSON into chosen candidate paths. Returns `null` when
 *  the output can't be parsed (signal to fall back to recall order); `[]` is a
 *  valid "nothing relevant" answer and is returned as such. */
export function parseLibrarianOutput(raw: string, candidates: Candidate[]): string[] | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: { picks?: unknown }
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (!Array.isArray(obj.picks)) return null
  const paths: string[] = []
  for (const p of obj.picks) {
    const i = Number(p)
    if (Number.isInteger(i) && candidates[i] && !paths.includes(candidates[i].path)) {
      paths.push(candidates[i].path)
    }
  }
  return paths
}

/** Ask the librarian which candidates are relevant. Returns chosen paths, or
 *  `null` if the model call failed/garbled (caller falls back to recall order). */
export async function selectNotes(
  query: string, candidates: Candidate[], run: ClaudeRunner, model: string,
): Promise<string[] | null> {
  if (!candidates.length) return []
  const { system, user } = buildLibrarianPrompt(query, candidates)
  try {
    const out = await run(
      ["-p", "--model", model, "--append-system-prompt", system, "--output-format", "text"],
      user,
    )
    return parseLibrarianOutput(out, candidates)
  } catch {
    return null
  }
}
