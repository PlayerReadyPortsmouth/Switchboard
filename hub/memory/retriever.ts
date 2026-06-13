import type { ClaudeRunner } from "../router"
import type { Embedder } from "./embedder"
import type { MemoryStore, Note, Scope } from "./store"
import type { MemoryIndex } from "./memoryIndex"
import type { AccessStore } from "./accessStore"
import { selectNotes, type Candidate } from "./librarian"
import { entityGate, dedupAction } from "./dedup"

export interface RetrieverOpts {
  store: MemoryStore
  index: MemoryIndex
  embedder: Embedder
  run: ClaudeRunner          // librarian model runner (injected; like the router)
  librarianModel: string
  recallLimit?: number       // candidates pulled by vector recall (default 20)
  finalLimit?: number        // notes injected after the librarian pass (default 5)
  dedupThreshold?: number    // cosine ≥ this triggers an entity-gate check (default 0.86)
  dedupModel?: string        // entity-gate model (default librarianModel)
  access?: AccessStore       // usage stats: records hits, weights recall, drives the hot set
  importanceWeight?: number  // boost recall rank by usage importance (default 0 → pure cosine)
  hotSetSize?: number        // notes injected proactively by importance (default 0 → off)
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
    if (vec) await this.o.index.set(note.path, note.scope, vec, this.o.embedder.version)
  }

  /** Embed every note currently in the vault (boot / rebuild). */
  async reindexAll(): Promise<void> {
    const notes = this.o.store.allNotes()
    if (!notes.length) return
    const vecs = await this.o.embedder.embed(notes.map(embedText))
    const version = this.o.embedder.version
    for (let i = 0; i < notes.length; i++) {
      if (vecs[i]) await this.o.index.set(notes[i].path, notes[i].scope, vecs[i], version)
    }
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
    const hits = (await this.o.index.search(vec, [note.scope], 10, this.o.embedder.version))
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
      await this.o.index.remove(drop.path)
      removed.push(drop.path)
      if (drop.path === note.path) break   // the note we were deduping is gone
    }
    return { removed, flagged }
  }

  /** The proactively-injected "hot set": top-importance notes in `scopes`,
   *  surfaced without an explicit recall. Empty unless access + hotSetSize set. */
  private hotSet(scopes: Scope[], exclude: Set<string>): string[] {
    const access = this.o.access
    const n = this.o.hotSetSize ?? 0
    if (!access || n <= 0) return []
    return this.o.store.list(scopes)
      .map((note) => note.path)
      .filter((p) => !exclude.has(p))
      .map((p) => ({ p, imp: access.importance(p) }))
      .filter((x) => x.imp > 0)
      .sort((a, b) => b.imp - a.imp)
      .slice(0, n)
      .map((x) => x.p)
  }

  /** Notes relevant to `query` within `scopes`, plus a rendered injection block.
   *  Semantic recall (optionally importance-weighted) + a proactive hot set;
   *  every injected note records an access hit. */
  async relevant(query: string, scopes: Scope[]): Promise<{ notes: Note[]; render: string }> {
    const recallLimit = this.o.recallLimit ?? 20
    const finalLimit = this.o.finalLimit ?? 5
    const weight = this.o.importanceWeight ?? 0
    const access = this.o.access

    // 1) Semantic recall, optionally re-ranked by usage importance.
    let selected: string[] = []
    const [qv] = await this.o.embedder.embed([query])
    if (qv) {
      let hits = await this.o.index.search(qv, scopes, recallLimit, this.o.embedder.version)
      if (access && weight > 0) {
        hits = hits
          .map((h) => ({ ...h, score: h.score + weight * access.importance(h.path) }))
          .sort((a, b) => b.score - a.score)
      }
      const candidates: Candidate[] = []
      for (const h of hits) {
        try {
          const n = this.o.store.read(h.path)
          candidates.push({ path: n.path, title: n.title, tags: n.tags, summary: firstLines(n.body) })
        } catch {}
      }
      if (candidates.length) {
        const picked = await selectNotes(query, candidates, this.o.run, this.o.librarianModel)
        // librarian failed/garbled (null) ⇒ top recall order; explicit [] ⇒ nothing relevant.
        selected = picked ?? candidates.slice(0, finalLimit).map((c) => c.path)
      }
    }

    // 2) Proactive hot set first, then semantic picks, capped at finalLimit.
    const hot = this.hotSet(scopes, new Set(selected))
    const chosenPaths = [...hot, ...selected].slice(0, finalLimit)

    const notes: Note[] = []
    for (const p of chosenPaths) {
      try { notes.push(this.o.store.read(p)); access?.hit(p) } catch {}
    }
    return { notes, render: renderMemory(notes) }
  }
}
