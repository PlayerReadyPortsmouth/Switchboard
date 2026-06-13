import type { ClaudeRunner } from "../router"
import type { Embedder } from "./embedder"
import type { MemoryStore, Note, Scope } from "./store"
import type { VectorIndex } from "./vectorIndex"
import { selectNotes, type Candidate } from "./librarian"
import { entityGate, dedupAction } from "./dedup"

export interface RetrieverOpts {
  store: MemoryStore
  index: VectorIndex
  embedder: Embedder
  run: ClaudeRunner          // librarian model runner (injected; like the router)
  librarianModel: string
  recallLimit?: number       // candidates pulled by vector recall (default 20)
  finalLimit?: number        // notes injected after the librarian pass (default 5)
  dedupThreshold?: number    // cosine ≥ this triggers an entity-gate check (default 0.86)
  dedupModel?: string        // entity-gate model (default librarianModel)
}

/** Outcome of a background dedup pass over one just-written note. */
export interface DedupResult {
  removed: string[]                                   // distiller dups auto-merged away
  flagged: { note: string; duplicate: string }[]      // protected dups for human review
}

function firstLines(body: string, max = 200): string {
  return body.replace(/\s+/g, " ").trim().slice(0, max)
}
function embedText(n: { title: string; tags: string[]; body: string }): string {
  return `${n.title}\n${n.tags.join(" ")}\n${n.body}`
}

/** Render chosen notes into a prompt-injectable block; "" when none. Each note
 *  carries an "as of" date so the agent knows how fresh the fact is and can
 *  re-verify stale specifics (file paths, flags) rather than trusting them. */
export function renderMemory(notes: Note[]): string {
  if (!notes.length) return ""
  const blocks = notes.map((n) => `## ${n.title} _(as of ${(n.updated || "").slice(0, 10) || "unknown"})_\n${n.body.trim()}`)
  return `Relevant memory (verify anything time-sensitive before relying on it):\n${blocks.join("\n\n")}`
}

/** Two-stage memory retrieval: local vector recall → Claude librarian precision. */
export class MemoryRetriever {
  constructor(private o: RetrieverOpts) {}

  /** Embed a note and (re)place it in the recall index, stamped with the current
   *  embedding version. */
  async indexNote(note: Note): Promise<void> {
    const [vec] = await this.o.embedder.embed([embedText(note)])
    if (vec) this.o.index.set(note.path, note.scope, vec, this.o.embedder.version)
  }

  /** Embed every note currently in the vault (boot / rebuild). */
  async reindexAll(): Promise<void> {
    const notes = this.o.store.allNotes()
    if (!notes.length) return
    const vecs = await this.o.embedder.embed(notes.map(embedText))
    const version = this.o.embedder.version
    notes.forEach((n, i) => { if (vecs[i]) this.o.index.set(n.path, n.scope, vecs[i], version) })
  }

  /** Background dedup for a just-written note. Finds same-scope near-neighbours,
   *  gates each on an LLM "same fact vs distinct entities?" check (cosine alone
   *  never merges), then: auto-merges distiller dups (drops the staler note),
   *  and only FLAGS dups when a protected (agent-authored) note is involved. */
  async dedupe(note: Note): Promise<DedupResult> {
    const threshold = this.o.dedupThreshold ?? 0.86
    const model = this.o.dedupModel ?? this.o.librarianModel
    const removed: string[] = []
    const flagged: { note: string; duplicate: string }[] = []
    const [vec] = await this.o.embedder.embed([embedText(note)])
    if (!vec) return { removed, flagged }
    const hits = this.o.index
      .search(vec, [note.scope], 10, this.o.embedder.version)
      .filter((h) => h.path !== note.path && h.score >= threshold)
    for (const h of hits) {
      let other: Note
      try { other = this.o.store.read(h.path) } catch { continue }
      if ((await entityGate(note, other, this.o.run, model)) !== "same") continue
      if (dedupAction(note.source, other.source) === "flag") {
        flagged.push({ note: note.path, duplicate: other.path })   // never mutate protected notes
        continue
      }
      // Both distiller-generated → keep the most-recently-updated, drop the staler.
      const drop = (note.updated || "") >= (other.updated || "") ? other : note
      this.o.store.remove(drop.path)
      this.o.index.remove(drop.path)
      removed.push(drop.path)
      if (drop.path === note.path) break   // the note we were deduping is gone
    }
    return { removed, flagged }
  }

  /** Notes relevant to `query` within `scopes`, plus a rendered injection block. */
  async relevant(query: string, scopes: Scope[]): Promise<{ notes: Note[]; render: string }> {
    const recallLimit = this.o.recallLimit ?? 20
    const finalLimit = this.o.finalLimit ?? 5
    const [qv] = await this.o.embedder.embed([query])
    if (!qv) return { notes: [], render: "" }
    const hits = this.o.index.search(qv, scopes, recallLimit, this.o.embedder.version)
    if (!hits.length) return { notes: [], render: "" }

    const candidates: Candidate[] = []
    for (const h of hits) {
      try {
        const n = this.o.store.read(h.path)
        candidates.push({ path: n.path, title: n.title, tags: n.tags, summary: firstLines(n.body) })
      } catch {}
    }
    const picked = await selectNotes(query, candidates, this.o.run, this.o.librarianModel)
    // librarian failed/garbled (null) ⇒ fall back to top recall order; explicit
    // [] ⇒ respect "nothing relevant".
    const chosenPaths = (picked ?? candidates.slice(0, finalLimit).map((c) => c.path)).slice(0, finalLimit)
    const notes: Note[] = []
    for (const p of chosenPaths) { try { notes.push(this.o.store.read(p)) } catch {} }
    return { notes, render: renderMemory(notes) }
  }
}
