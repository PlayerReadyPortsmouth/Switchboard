export interface SearchHit { path: string; scope: string; score: number }

/** Recall-index seam. Both the local in-process cosine store and a hosted vector
 *  DB (Qdrant) satisfy this. Methods are async so a network-backed store fits
 *  without changing the retriever. */
export interface MemoryIndex {
  set(path: string, scope: string, vector: number[], version?: string): Promise<void>
  remove(path: string): Promise<void>
  /** Top-`limit` hits within `scopes`, ranked by similarity; `version` filters to
   *  one embedding space when given. */
  search(query: number[], scopes: string[], limit: number, version?: string): Promise<SearchHit[]>
}

/** Minimal HTTP surface shared by the hosted backends; injectable for tests. */
export interface HttpResponse { ok: boolean; status: number; json(): Promise<any> }
export type HttpFetch = (
  url: string, init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>

export function defaultFetch(): HttpFetch {
  return (url, init) => (globalThis.fetch as unknown as HttpFetch)(url, init)
}
