import { createHash } from "crypto"
import type { MemoryIndex, SearchHit, HttpFetch } from "./memoryIndex"
import { defaultFetch } from "./memoryIndex"

/** Stable Qdrant point id (UUID) derived from a note path — Qdrant ids must be a
 *  uint or UUID, so we hash the path deterministically. */
export function pointId(path: string): string {
  const h = createHash("sha1").update(path).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export interface QdrantOpts {
  url: string                // e.g. http://localhost:6333 or a Qdrant Cloud URL
  apiKey?: string
  collection?: string        // default "switchboard_memory"
  fetch?: HttpFetch
}

/** Hosted recall backend over Qdrant's REST API. Implements the same MemoryIndex
 *  seam as the local store; the collection is created lazily on first upsert
 *  (vector size taken from the first vector, cosine distance). Scope + embedding
 *  version are stored in each point's payload and used as search filters. */
export class QdrantIndex implements MemoryIndex {
  private collection: string
  private ensured = false
  constructor(private o: QdrantOpts) { this.collection = o.collection ?? "switchboard_memory" }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const f = this.o.fetch ?? defaultFetch()
    const res = await f(`${this.o.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { "api-key": this.o.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`qdrant http ${res.status}`)
    return res.json()
  }

  private async ensure(dim: number): Promise<void> {
    if (this.ensured) return
    // Idempotent enough: creating an existing collection is tolerated.
    try { await this.req("PUT", `/collections/${this.collection}`, { vectors: { size: dim, distance: "Cosine" } }) } catch {}
    this.ensured = true
  }

  async set(path: string, scope: string, vector: number[], version?: string): Promise<void> {
    await this.ensure(vector.length)
    await this.req("PUT", `/collections/${this.collection}/points`, {
      points: [{ id: pointId(path), vector, payload: { path, scope, version: version ?? null } }],
    })
  }

  async remove(path: string): Promise<void> {
    await this.req("POST", `/collections/${this.collection}/points/delete`, { points: [pointId(path)] })
  }

  async search(query: number[], scopes: string[], limit: number, version?: string): Promise<SearchHit[]> {
    const must: unknown[] = [{ key: "scope", match: { any: scopes } }]
    if (version !== undefined) must.push({ key: "version", match: { value: version } })
    const res = await this.req("POST", `/collections/${this.collection}/points/search`, {
      vector: query, limit, with_payload: true, filter: { must },
    })
    const result = (res?.result ?? []) as { score: number; payload: { path: string; scope: string } }[]
    return result.map((r) => ({ path: r.payload.path, scope: r.payload.scope, score: r.score }))
  }
}
