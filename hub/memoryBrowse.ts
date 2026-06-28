// hub/memoryBrowse.ts
import type { NoteSummary } from "./memoryCard"

export interface MemoryBrowseDeps {
  list: (scopes: string[]) => NoteSummary[]
  readBody: (path: string) => string
  exists: (path: string) => boolean
  archive: (path: string) => boolean
  remove: (path: string) => void
  deindex: (path: string) => void
  audit: (action: "memory_forget" | "memory_delete", actor: string, detail: Record<string, unknown>) => void
}

export class MemoryBrowse {
  constructor(private d: MemoryBrowseDeps) {}

  list(scopes: string[]): NoteSummary[] { return this.d.list(scopes) }
  body(path: string): string { return this.d.readBody(path) }

  forget(note: { path: string; title: string; scope: string }, actor: string): { ok: boolean; reason?: "missing" | "archive_failed" } {
    if (!this.d.exists(note.path)) return { ok: false, reason: "missing" }
    if (!this.d.archive(note.path)) return { ok: false, reason: "archive_failed" }
    this.safeDeindex(note.path)
    this.d.audit("memory_forget", actor, { title: note.title, scope: note.scope })
    return { ok: true }
  }

  remove(note: { path: string; title: string; scope: string }, actor: string): { ok: boolean; reason?: "missing" | "archive_failed" } {
    if (!this.d.exists(note.path)) return { ok: false, reason: "missing" }
    this.d.remove(note.path)
    this.safeDeindex(note.path)
    this.d.audit("memory_delete", actor, { title: note.title, scope: note.scope })
    return { ok: true }
  }

  private safeDeindex(path: string): void {
    try { this.d.deindex(path) } catch (e) { process.stderr.write(`memory-browse: de-index ${path} failed: ${e}\n`) }
  }
}
