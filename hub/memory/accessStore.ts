import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

interface AccessStat { count: number; lastAccessed: number; score: number; scoredAt: number }

const DAY = 24 * 3600 * 1000

/** Per-note usage stats with exponentially-decayed importance. Kept in a sidecar
 *  (not the note's front-matter) so reads never rewrite notes or bump their
 *  content `updated` date. A "hit" = a note was actually injected/recalled. */
export class AccessStore {
  private map = new Map<string, AccessStat>()
  constructor(private file?: string, private halfLifeMs = 14 * DAY) { this.load() }

  /** Lazy exponential decay of `score` up to `now`. */
  private decay(s: AccessStat, now: number): void {
    if (now <= s.scoredAt) return
    s.score *= Math.pow(0.5, (now - s.scoredAt) / this.halfLifeMs)
    s.scoredAt = now
  }

  hit(path: string, now = Date.now()): void {
    let s = this.map.get(path)
    if (!s) { s = { count: 0, lastAccessed: 0, score: 0, scoredAt: now }; this.map.set(path, s) }
    this.decay(s, now)
    s.count += 1
    s.score += 1
    s.lastAccessed = now
    this.persist()
  }

  /** Importance in [0,1): compounds frequency, decayed by recency. */
  importance(path: string, now = Date.now()): number {
    const s = this.map.get(path)
    if (!s) return 0
    this.decay(s, now)          // in-memory only; persisted on next hit
    return 1 - Math.pow(2, -s.score)
  }
  lastAccessed(path: string): number { return this.map.get(path)?.lastAccessed ?? 0 }
  count(path: string): number { return this.map.get(path)?.count ?? 0 }

  /** Drop stats for notes that no longer exist. */
  prune(existing: Set<string>): void {
    let changed = false
    for (const p of [...this.map.keys()]) if (!existing.has(p)) { this.map.delete(p); changed = true }
    if (changed) this.persist()
  }

  /** The `n` coldest of `paths` — lowest importance, oldest access first. */
  coldest(paths: string[], n: number, now = Date.now()): string[] {
    return paths
      .map((p) => ({ p, imp: this.importance(p, now), la: this.lastAccessed(p) }))
      .sort((a, b) => a.imp - b.imp || a.la - b.la)
      .slice(0, n)
      .map((x) => x.p)
  }

  private load(): void {
    if (!this.file) return
    try {
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, AccessStat>
      for (const [p, s] of Object.entries(obj)) this.map.set(p, s)
    } catch {}
  }
  private persist(): void {
    if (!this.file) return
    const obj: Record<string, AccessStat> = {}
    for (const [p, s] of this.map) obj[p] = s
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(obj))
    renameSync(tmp, this.file)
  }
}
