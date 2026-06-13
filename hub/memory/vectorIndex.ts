import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

export interface IndexEntry { path: string; scope: string; vector: number[]; version?: string }
export interface SearchHit { path: string; scope: string; score: number }

/** Cosine similarity; tolerant of length mismatch / zero vectors. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** In-memory vector store keyed by note path, with cosine recall filtered by
 *  scope. Small by design (a human-scale vault); persisted as JSON. The recall
 *  seam — swap for an external vector DB without touching the retriever. */
export class VectorIndex {
  private entries = new Map<string, IndexEntry>()
  constructor(private file?: string) { this.load() }

  set(path: string, scope: string, vector: number[], version?: string): void {
    this.entries.set(path, { path, scope, vector, version })
    this.persist()
  }
  remove(path: string): void {
    if (this.entries.delete(path)) this.persist()
  }
  has(path: string): boolean { return this.entries.has(path) }
  size(): number { return this.entries.size }

  /** Top-`limit` entries within `scopes`, ranked by cosine to `query`. When
   *  `version` is given, entries stamped with a different embedding version are
   *  excluded (they live in an incompatible vector space until re-embedded). */
  search(query: number[], scopes: string[], limit: number, version?: string): SearchHit[] {
    const wanted = new Set(scopes)
    return [...this.entries.values()]
      .filter((e) => wanted.has(e.scope) && (version === undefined || e.version === version))
      .map((e) => ({ path: e.path, scope: e.scope, score: cosine(query, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  private load(): void {
    if (!this.file) return
    try {
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, { scope: string; vector: number[]; version?: string }>
      for (const [path, v] of Object.entries(obj)) this.entries.set(path, { path, ...v })
    } catch {}
  }
  private persist(): void {
    if (!this.file) return
    const obj: Record<string, { scope: string; vector: number[]; version?: string }> = {}
    for (const e of this.entries.values()) obj[e.path] = { scope: e.scope, vector: e.vector, version: e.version }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(obj))
    renameSync(tmp, this.file)
  }
}
