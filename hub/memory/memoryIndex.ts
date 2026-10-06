export interface SearchHit { path: string; scope: string; score: number }

/** What the index knows about one stored entry, without its vector. `hash` is the
 *  content hash of the text that was embedded (absent on entries written before
 *  hashes were stored). */
export interface EntryMeta { scope: string; version?: string; hash?: string }

/** One entry for a bulk write. */
export interface IndexWrite { path: string; scope: string; vector: number[]; version?: string; hash?: string }

/** Recall-index seam. Both the local in-process cosine store and a hosted vector
 *  DB (Qdrant) satisfy this. Methods are async so a network-backed store fits
 *  without changing the retriever. */
export interface MemoryIndex {
  set(path: string, scope: string, vector: number[], version?: string, hash?: string): Promise<void>
  /** Optional bulk write that persists once for the whole batch. Callers fall
   *  back to per-entry `set` when an index does not provide it. */
  setMany?(entries: IndexWrite[]): Promise<void>
  /** Optional local metadata lookup, used by the boot reindex to skip notes whose
   *  stored vector already matches their content. Absent ⇒ every note is embedded. */
  meta?(path: string): EntryMeta | undefined
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
