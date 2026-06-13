import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Gardener } from "../hub/memory/gardener"
import { MemoryStore } from "../hub/memory/store"
import { VectorIndex } from "../hub/memory/vectorIndex"
import { AccessStore } from "../hub/memory/accessStore"
import type { DedupResult } from "../hub/memory/retriever"

const YEAR = 365 * 24 * 3600 * 1000
const NOW = Date.now() + YEAR   // an epoch well past the notes' real write timestamps

function setup() {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "sb-garden-")))
  const index = new VectorIndex()
  const access = new AccessStore(undefined, 1e15)   // effectively no decay in-test
  return { store, index, access }
}

test("prunes orphan stats and surfaces stale notes", async () => {
  const { store, index, access } = setup()
  const p = store.write("global", { title: "Old", body: "b", source: "distiller" })
  access.hit("/gone/orphan.md")   // stat for a note that doesn't exist
  const g = new Gardener({ store, index, access, dedupe: async () => emptyDedup(), now: () => NOW, staleAfterMs: 1000 })
  const res = await g.run()
  expect(res.stale).toContain(p)
  expect(access.count("/gone/orphan.md")).toBe(0)   // pruned
})

test("auto-merges distiller dups reported by dedupe", async () => {
  const { store, index, access } = setup()
  const p1 = store.write("global", { title: "A", body: "a", source: "distiller" })
  store.write("global", { title: "B", body: "b", source: "distiller" })
  // dedupe reports p1 removed when called on the first note
  const dedupe = async (n: { title: string }): Promise<DedupResult> =>
    n.title === "A" ? { removed: [p1], flagged: [] } : emptyDedup()
  const g = new Gardener({ store, index, access, dedupe, now: () => NOW, staleAfterMs: NOW * 10 })
  const res = await g.run()
  expect(res.merged).toContain(p1)
})

test("archives the coldest distiller note over budget; protects hot + agent notes", async () => {
  const { store, index, access } = setup()
  const cold = store.write("global", { title: "Cold", body: "c", source: "distiller" })
  const hot = store.write("global", { title: "Hot", body: "h", source: "distiller" })
  store.write("global", { title: "Hand", body: "h", source: "agent:help" })
  await index.set(cold, "global", [1, 0], undefined)
  for (let i = 0; i < 5; i++) access.hit(hot)   // hot stays
  const removedFromIndex: string[] = []
  const idx = { set: index.set.bind(index), search: index.search.bind(index), remove: async (p: string) => { removedFromIndex.push(p); await index.remove(p) } }
  const g = new Gardener({
    store, index: idx, access, dedupe: async () => emptyDedup(),
    now: () => NOW, scopeBudget: 2, archiveAfterMs: 1000, staleAfterMs: NOW * 10,
  })
  const res = await g.run()
  expect(res.archived).toEqual([cold])           // coldest distiller note, 3→2
  expect(removedFromIndex).toEqual([cold])        // vector dropped → excluded from recall
  expect(store.list(["global"]).map((n) => n.title).sort()).toEqual(["Hand", "Hot"])
})

function emptyDedup(): DedupResult { return { removed: [], flagged: [] } }
