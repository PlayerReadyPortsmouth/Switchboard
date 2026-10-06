import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryStore } from "./store"
import { VectorIndex } from "./vectorIndex"
import { MemoryRetriever, embedHash } from "./retriever"
import type { Embedder } from "./embedder"

/** Fake embedder that records every call's batch size. */
function countingEmbedder(version = "fake-v1") {
  const calls: number[] = []
  const e: Embedder = {
    version,
    async embed(texts) {
      calls.push(texts.length)
      return texts.map((t) => [t.length % 7, /alpha/i.test(t) ? 1 : 0, 1])
    },
  }
  return { e, calls }
}

function vault(n: number) {
  const dir = mkdtempSync(join(tmpdir(), "sb-reindex-"))
  const store = new MemoryStore(join(dir, "vault"))
  for (let i = 0; i < n; i++) store.write("global", { title: `Note ${i}`, body: `body ${i}`, source: "x" })
  return { dir, store, file: join(dir, ".index", "vectors.json") }
}

const run = async () => '{"picks":[]}'

test("reindexAll embeds in bounded batches and writes the index file in bulk, not per note", async () => {
  const { store, file } = vault(37)
  const index = new VectorIndex(file)
  const { e, calls } = countingEmbedder()
  const r = new MemoryRetriever({ store, index, embedder: e, run, librarianModel: "m",
    reindexBatchSize: 8, reindexPersistEvery: 2, reindexYieldMs: 0 })
  const s = await r.reindexAll()
  expect(calls).toEqual([8, 8, 8, 8, 5])          // never one giant batch
  expect(Math.max(...calls)).toBeLessThanOrEqual(8)
  expect(s).toMatchObject({ total: 37, embedded: 37, skipped: 0, batches: 5 })
  // flushes after batch 2, batch 4 and the tail: 3 file writes for 37 notes
  expect(index.writes).toBe(3)
  expect(s.writes).toBe(3)
  expect(index.size()).toBe(37)
})

test("with the default persist interval a full vault is written once", async () => {
  const { store, file } = vault(20)
  const index = new VectorIndex(file)
  const { e } = countingEmbedder()
  const r = new MemoryRetriever({ store, index, embedder: e, run, librarianModel: "m", reindexYieldMs: 0 })
  await r.reindexAll()
  expect(index.writes).toBe(1)
})

test("unchanged notes are skipped on the next boot; changed ones are re-embedded", async () => {
  const { store, file } = vault(10)
  const first = countingEmbedder()
  await new MemoryRetriever({ store, index: new VectorIndex(file), embedder: first.e, run, librarianModel: "m", reindexYieldMs: 0 }).reindexAll()

  // Hashes are persisted with the vectors.
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, { hash?: string }>
  expect(Object.values(onDisk).every((v) => typeof v.hash === "string" && v.hash.length === 64)).toBe(true)

  // "Reboot": fresh index loaded from disk, one note edited.
  const edited = store.allNotes()[3]
  store.write("global", { title: edited.title, body: "changed body", source: "x" })
  const index2 = new VectorIndex(file)
  const second = countingEmbedder()
  const s = await new MemoryRetriever({ store, index: index2, embedder: second.e, run, librarianModel: "m", reindexYieldMs: 0 }).reindexAll()
  expect(s).toMatchObject({ total: 10, embedded: 1, skipped: 9, batches: 1, writes: 1 })
  expect(second.calls).toEqual([1])
  expect(index2.writes).toBe(1)

  // Nothing changed: no embedding and no write at all.
  const index3 = new VectorIndex(file)
  const third = countingEmbedder()
  const s3 = await new MemoryRetriever({ store, index: index3, embedder: third.e, run, librarianModel: "m", reindexYieldMs: 0 }).reindexAll()
  expect(s3).toMatchObject({ embedded: 0, skipped: 10, batches: 0, writes: 0 })
  expect(third.calls).toEqual([])
  expect(index3.writes).toBe(0)
})

test("entries without a hash (pre-upgrade index) or from another model are re-embedded", async () => {
  const { store, file } = vault(3)
  const legacy = new VectorIndex(file)
  for (const n of store.allNotes()) await legacy.set(n.path, n.scope, [1, 0, 0], "fake-v1")   // no hash
  const { e, calls } = countingEmbedder()
  const s = await new MemoryRetriever({ store, index: new VectorIndex(file), embedder: e, run, librarianModel: "m", reindexYieldMs: 0 }).reindexAll()
  expect(s.embedded).toBe(3)
  expect(calls).toEqual([3])

  const swapped = countingEmbedder("fake-v2")
  const s2 = await new MemoryRetriever({ store, index: new VectorIndex(file), embedder: swapped.e, run, librarianModel: "m", reindexYieldMs: 0 }).reindexAll()
  expect(s2.embedded).toBe(3)
})

test("indexNote stores the content hash so the note is skipped at the next boot", async () => {
  const { store, file } = vault(0)
  const path = store.write("global", { title: "Live", body: "written at runtime", source: "x" })
  const index = new VectorIndex(file)
  const { e } = countingEmbedder()
  const r = new MemoryRetriever({ store, index, embedder: e, run, librarianModel: "m", reindexYieldMs: 0 })
  await r.indexNote(store.read(path))
  expect(index.meta(path)?.hash).toMatch(/^[0-9a-f]{64}$/)
  const s = await r.reindexAll()
  expect(s).toMatchObject({ embedded: 0, skipped: 1 })
})

test("a live write during the reindex is not overwritten by the older reindex vector", async () => {
  const { store, file } = vault(2)
  const index = new VectorIndex(file)
  const target = store.allNotes()[0].path
  let fired = false
  const e: Embedder = {
    version: "fake-v1",
    async embed(texts) {
      if (!fired) {   // simulate indexNote landing mid-reindex
        fired = true
        await index.set(target, "global", [9, 9, 9], "fake-v1", embedHash("newer"))
      }
      return texts.map(() => [1, 1, 1])
    },
  }
  await new MemoryRetriever({ store, index, embedder: e, run, librarianModel: "m", reindexYieldMs: 0 }).reindexAll()
  expect(index.meta(target)?.hash).toBe(embedHash("newer"))
})

test("an index without bulk or meta support still works (falls back to per-entry set)", async () => {
  const { store } = vault(5)
  const sets: string[] = []
  const index = {
    async set(path: string) { sets.push(path) },
    async remove() {},
    async search() { return [] },
  }
  const { e, calls } = countingEmbedder()
  const s = await new MemoryRetriever({ store, index, embedder: e, run, librarianModel: "m", reindexBatchSize: 2, reindexYieldMs: 0 }).reindexAll()
  expect(calls).toEqual([2, 2, 1])
  expect(sets.length).toBe(5)
  expect(s.embedded).toBe(5)
})
