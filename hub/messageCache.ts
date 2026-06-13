import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { join } from "path"

/** One cached turn — a user message or an agent reply. */
export interface CachedMsg {
  role: "user" | "agent"
  text: string
  ts: number
  user?: string       // username (user turns)
  userId?: string     // snowflake (user turns) — used to scope per-user memory
  agent?: string      // agent name (agent turns)
}

function oneLine(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}
function slug(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, "_") }

/** Per-conversation ring buffer of recent messages (both directions). Keyed by
 *  Discord channel id — the natural conversation unit, present on both inbound
 *  messages and agent replies. Optionally persisted as JSONL so it survives a
 *  restart and feeds the background distiller. */
export class MessageCache {
  private mem = new Map<string, CachedMsg[]>()
  constructor(private cap: number, private dir?: string) {}

  record(convId: string, m: CachedMsg): void {
    const arr = this.get(convId)
    arr.push(m)
    while (arr.length > this.cap) arr.shift()
    this.mem.set(convId, arr)
    if (this.dir) this.persist(convId, arr)
  }

  recent(convId: string, n = this.cap): CachedMsg[] {
    return this.get(convId).slice(-n)
  }

  /** Compact, human-readable block for prompt injection; "" when no history. */
  render(convId: string, n = this.cap): string {
    const arr = this.recent(convId, n)
    if (!arr.length) return ""
    const lines = arr.map((m) => {
      const who = m.role === "agent" ? (m.agent ?? "agent") : (m.user ?? "user")
      return `- [${who}] ${oneLine(m.text)}`
    })
    return `Recent conversation:\n${lines.join("\n")}`
  }

  private get(convId: string): CachedMsg[] {
    let arr = this.mem.get(convId)
    if (!arr) { arr = this.load(convId); this.mem.set(convId, arr) }
    return arr
  }
  private file(convId: string): string { return join(this.dir!, `${slug(convId)}.jsonl`) }
  private load(convId: string): CachedMsg[] {
    if (!this.dir) return []
    try {
      const raw = readFileSync(this.file(convId), "utf8").trim()
      if (!raw) return []
      return raw.split("\n").map((l) => JSON.parse(l) as CachedMsg).slice(-this.cap)
    } catch { return [] }
  }
  private persist(convId: string, arr: CachedMsg[]): void {
    mkdirSync(this.dir!, { recursive: true })
    const tmp = this.file(convId) + ".tmp"
    writeFileSync(tmp, arr.map((m) => JSON.stringify(m)).join("\n") + "\n")
    renameSync(tmp, this.file(convId))
  }
}
