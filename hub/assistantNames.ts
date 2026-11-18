/** A person's own name for an agent ("Jeeves" for the Assistant).
 *
 *  Only agents marked `access.nameable` can be named, and a name belongs to one person:
 *  Aurora's Assistant can be "Jeeves" while Stephen's is "Alfred". The name is how that
 *  person addresses it, what the router is told they call it, and what their replies are
 *  tagged with. It grants nothing: who may use the agent is decided exactly as before.
 *
 *  Names are set by a hub command (`!name Jeeves`), never by the model, so an agent
 *  cannot be talked into renaming itself as a colleague. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"

/** Words that open ordinary sentences; a name that is one of these would hijack them. */
const RESERVED = new Set([
  "hey", "hi", "hiya", "hello", "ok", "okay", "yo", "morning", "thanks", "cheers", "right", "so",
  "the", "a", "an", "i", "you", "we", "it", "can", "could", "please", "what", "who", "why", "how",
  "when", "where", "is", "are", "do", "does", "yes", "no", "everyone", "all", "here", "hub",
])

/** Why a name cannot be used, or null if it can. `taken` is every agent name on the hub:
 *  nobody may call their assistant "Bill" while a Bill exists. */
export function nameProblem(name: string, taken: string[]): string | null {
  const n = name.trim()
  if (!/^[\p{L}\p{N}_.-]{2,24}$/u.test(n)) return "A name is one word, 2 to 24 letters or digits (a dash, dot or underscore is fine)."
  if (RESERVED.has(n.toLowerCase())) return `"${n}" is too common a word to use as a name; it would catch ordinary sentences.`
  if (taken.some(t => t.toLowerCase() === n.toLowerCase())) return `"${n}" is already the name of an agent here.`
  return null
}

export class AssistantNames {
  /** userId → agent → name */
  private names: Record<string, Record<string, string>> = {}
  constructor(private readonly path: string) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8"))
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [u, m] of Object.entries(raw)) {
            if (!m || typeof m !== "object") continue
            const clean: Record<string, string> = {}
            for (const [a, n] of Object.entries(m as Record<string, unknown>)) if (typeof n === "string") clean[a] = n
            if (Object.keys(clean).length) this.names[u] = clean
          }
        }
      }
    } catch { this.names = {} }
  }

  get(userId: string, agent: string): string | undefined { return this.names[userId]?.[agent] }

  /** This person's names, agent → name. */
  forUser(userId: string): Record<string, string> { return { ...(this.names[userId] ?? {}) } }

  set(userId: string, agent: string, name: string): void {
    ;(this.names[userId] ??= {})[agent] = name.trim()
    this.save()
  }

  clear(userId: string, agent: string): boolean {
    if (!this.names[userId]?.[agent]) return false
    delete this.names[userId]![agent]
    if (Object.keys(this.names[userId]!).length === 0) delete this.names[userId]
    this.save()
    return true
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(this.names, null, 2) + "\n", { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (e) { process.stderr.write(`assistant names: save failed: ${e}\n`) }
  }
}

/** `!name`, `!name Jeeves`, `!name clear`. Null when the text is not this command. */
export function parseNameCommand(text: string): { name?: string; clear?: boolean } | null {
  const m = /^!name(?:\s+(.+))?$/i.exec(text.trim())
  if (!m) return null
  const arg = m[1]?.trim()
  if (!arg) return {}
  if (/^(clear|reset|none)$/i.test(arg)) return { clear: true }
  return { name: arg }
}

/** The name this person's reply should be tagged with: "Jeeves (Assistant)", or just the
 *  agent's own name when they have not named it. */
export function displayName(agent: string, personal: string | undefined): string {
  return personal ? `${personal} (${agent})` : agent
}
