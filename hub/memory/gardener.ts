import type { MemoryStore, Note } from "./store"
import type { MemoryIndex } from "./memoryIndex"
import type { AccessStore } from "./accessStore"
import type { DedupResult } from "./retriever"
import { isProtected } from "./dedup"

const DAY = 24 * 3600 * 1000

export interface GardenerDeps {
  store: MemoryStore
  index: MemoryIndex
  access: AccessStore
  dedupe: (note: Note) => Promise<DedupResult>   // usually retriever.dedupe.bind(retriever)
  now?: () => number
  staleAfterMs?: number    // default 30d → stale flag
  archiveAfterMs?: number  // default 90d cold → archive candidate
  scopeBudget?: number     // default 200 notes/scope before archival
}

export interface GardenerResult {
  merged: string[]                                   // distiller dups auto-merged away
  flaggedDups: { note: string; duplicate: string }[] // protected dups for review
  stale: string[]                                    // notes past staleAfterMs
  archived: string[]                                 // cold distiller notes moved to archive/
}

/** Periodic, background, whole-vault hygiene. Never destructive to agent-authored
 *  notes (they're only ever flagged). Reversible archival. */
export class Gardener {
  constructor(private d: GardenerDeps) {}
  private now(): number { return this.d.now?.() ?? Date.now() }

  async run(): Promise<GardenerResult> {
    const now = this.now()
    const result: GardenerResult = { merged: [], flaggedDups: [], stale: [], archived: [] }

    // 1) Prune orphaned access stats.
    let notes = this.d.store.allNotes()
    this.d.access.prune(new Set(notes.map((n) => n.path)))

    // 2) Whole-vault dedup (reuses the per-write entity-gated dedup).
    const removed = new Set<string>()
    for (const n of notes) {
      if (removed.has(n.path)) continue
      let fresh: Note
      try { fresh = this.d.store.read(n.path) } catch { continue }   // already gone
      const res = await this.d.dedupe(fresh)
      for (const r of res.removed) { removed.add(r); result.merged.push(r) }
      result.flaggedDups.push(...res.flagged)
    }
    notes = notes.filter((n) => !removed.has(n.path))

    // 3) Staleness flags (non-destructive — logged for review; the as-of date warns at read time).
    const staleAfter = this.d.staleAfterMs ?? 30 * DAY
    for (const n of notes) {
      const updated = Date.parse(n.updated)
      if (updated && now - updated > staleAfter) result.stale.push(n.path)
    }

    // 4) Archival under a per-scope size budget — coldest distiller notes only.
    const budget = this.d.scopeBudget ?? 200
    const archiveAfter = this.d.archiveAfterMs ?? 90 * DAY
    const byScope = new Map<string, Note[]>()
    for (const n of notes) (byScope.get(n.scope) ?? byScope.set(n.scope, []).get(n.scope)!).push(n)
    for (const group of byScope.values()) {
      if (group.length <= budget) continue
      const cold = group.filter((n) => {
        if (isProtected(n.source)) return false                       // sacred
        const last = this.d.access.lastAccessed(n.path) || Date.parse(n.created) || 0
        return now - last > archiveAfter
      })
      const toArchive = this.d.access.coldest(cold.map((n) => n.path), group.length - budget, now)
      for (const p of toArchive) {
        try {
          this.d.store.archive(p)
          await this.d.index.remove(p)   // drop its vector → excluded from recall
          result.archived.push(p)
        } catch {}
      }
    }
    return result
  }
}
