import type { ClaudeRunner } from "../router"
import type { Embedder } from "./embedder"
import type { MemoryStore, Note, Scope } from "./store"
import type { VectorIndex } from "./vectorIndex"
import { selectNotes, type Candidate } from "./librarian"

export interface RetrieverOpts {
  store: MemoryStore
  index: VectorIndex
  embedder: Embedder
  run: ClaudeRunner          // librarian model runner (injected; like the router)
  librarianModel: string
  recallLimit?: number       // candidates pulled by vector recall (default 20)
  finalLimit?: number        // notes injected after the librarian pass (default 5)
}

function firstLines(body: string, max = 200): string {
  return body.replace(/\s+/g, " ").trim().slice(0, max)
}
function embedText(n: { title: string; tags: string[]; body: string }): string {
  return `${n.title}\n${n.tags.join(" ")}\n${n.body}`
}

/** Render chosen notes into a prompt-injectable block; "" when none. */
export function renderMemory(notes: Note[]): string {
  if (!notes.length) return ""
  const blocks = notes.map((n) => `## ${n.title}\n${n.body.trim()}`)
  return `Relevant memory:\n${blocks.join("\n\n")}`
}

/** Two-stage memory retrieval: local vector recall → Claude librarian precision. */
export class MemoryRetriever {
  constructor(private o: RetrieverOpts) {}

  /** Embed a note and (re)place it in the recall index. */
  async indexNote(note: Note): Promise<void> {
    const [vec] = await this.o.embedder.embed([embedText(note)])
    if (vec) this.o.index.set(note.path, note.scope, vec)
  }

  /** Embed every note currently in the vault (boot / rebuild). */
  async reindexAll(): Promise<void> {
    const notes = this.o.store.allNotes()
    if (!notes.length) return
    const vecs = await this.o.embedder.embed(notes.map(embedText))
    notes.forEach((n, i) => { if (vecs[i]) this.o.index.set(n.path, n.scope, vecs[i]) })
  }

  /** Notes relevant to `query` within `scopes`, plus a rendered injection block. */
  async relevant(query: string, scopes: Scope[]): Promise<{ notes: Note[]; render: string }> {
    const recallLimit = this.o.recallLimit ?? 20
    const finalLimit = this.o.finalLimit ?? 5
    const [qv] = await this.o.embedder.embed([query])
    if (!qv) return { notes: [], render: "" }
    const hits = this.o.index.search(qv, scopes, recallLimit)
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
