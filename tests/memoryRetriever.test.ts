import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryStore } from "../hub/memory/store"
import { VectorIndex } from "../hub/memory/vectorIndex"
import { MemoryRetriever, renderMemory } from "../hub/memory/retriever"
import { buildLibrarianPrompt, parseLibrarianOutput, type Candidate } from "../hub/memory/librarian"
import type { Embedder } from "../hub/memory/embedder"

const cand = (path: string): Candidate => ({ path, title: path, tags: [], summary: "" })

// --- librarian unit ---
test("librarian prompt numbers candidates and includes the query", () => {
  const { user, system } = buildLibrarianPrompt("deploy fails", [cand("/a"), cand("/b")])
  expect(user).toContain("deploy fails")
  expect(user).toContain("[0]")
  expect(user).toContain("[1]")
  expect(system).toContain("picks")
})

test("librarian parse maps indices to paths, dedupes, rejects bad indices", () => {
  const cs = [cand("/a"), cand("/b"), cand("/c")]
  expect(parseLibrarianOutput('{"picks":[0,2,2,9]}', cs)).toEqual(["/a", "/c"])
  expect(parseLibrarianOutput('{"picks":[]}', cs)).toEqual([])
  expect(parseLibrarianOutput("no json", cs)).toBeNull()
  expect(parseLibrarianOutput('{"nope":1}', cs)).toBeNull()
})

test("renderMemory builds a labelled block, empty when none", () => {
  expect(renderMemory([])).toBe("")
  const block = renderMemory([
    { path: "/a", scope: "global", title: "T1", tags: [], body: "B1", source: "x", created: "", updated: "" },
  ])
  expect(block).toContain("Relevant memory:")
  expect(block).toContain("## T1")
  expect(block).toContain("B1")
})

// --- retriever integration with fakes ---
// A deterministic fake embedder: vector = [matches "alpha", matches "beta"].
const fakeEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => [/alpha/i.test(t) ? 1 : 0, /beta/i.test(t) ? 1 : 0])
  },
}

function setup() {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "sb-ret-")))
  store.write("global", { title: "Alpha note", body: "all about alpha", source: "x" })
  store.write("global", { title: "Beta note", body: "all about beta", source: "x" })
  const index = new VectorIndex()
  return { store, index }
}

test("reindexAll embeds and recall returns the scope-matching note", async () => {
  const { store, index } = setup()
  const run = async () => '{"picks":[0]}'   // librarian keeps the top candidate
  const r = new MemoryRetriever({ store, index, embedder: fakeEmbedder, run, librarianModel: "m" })
  await r.reindexAll()
  expect(index.size()).toBe(2)
  const { notes, render } = await r.relevant("tell me about alpha", ["global"])
  expect(notes.length).toBe(1)
  expect(notes[0].title).toBe("Alpha note")
  expect(render).toContain("## Alpha note")
})

test("librarian garbled output falls back to recall order", async () => {
  const { store, index } = setup()
  const run = async () => "totally not json"
  const r = new MemoryRetriever({ store, index, embedder: fakeEmbedder, run, librarianModel: "m", finalLimit: 1 })
  await r.reindexAll()
  const { notes } = await r.relevant("alpha please", ["global"])
  expect(notes.length).toBe(1)
  expect(notes[0].title).toBe("Alpha note")   // top recall hit, librarian ignored
})

test("librarian explicit [] yields no notes even with recall hits", async () => {
  const { store, index } = setup()
  const run = async () => '{"picks":[]}'
  const r = new MemoryRetriever({ store, index, embedder: fakeEmbedder, run, librarianModel: "m" })
  await r.reindexAll()
  const { notes } = await r.relevant("alpha", ["global"])
  expect(notes.length).toBe(0)
})

test("no recall hits in scope ⇒ empty, librarian not consulted", async () => {
  const { store, index } = setup()
  let called = false
  const run = async () => { called = true; return '{"picks":[0]}' }
  const r = new MemoryRetriever({ store, index, embedder: fakeEmbedder, run, librarianModel: "m" })
  await r.reindexAll()
  const { notes } = await r.relevant("alpha", ["users/999"])  // empty scope
  expect(notes.length).toBe(0)
  expect(called).toBe(false)
})
