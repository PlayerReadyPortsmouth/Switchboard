import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isProtected, dedupAction, buildEntityGatePrompt, parseEntityGate, entityGate } from "../hub/memory/dedup"
import { MemoryStore } from "../hub/memory/store"
import { VectorIndex } from "../hub/memory/vectorIndex"
import { MemoryRetriever } from "../hub/memory/retriever"
import type { Embedder } from "../hub/memory/embedder"

test("isProtected / dedupAction honour agent-authored sanctity", () => {
  expect(isProtected("agent:help")).toBe(true)
  expect(isProtected("distiller")).toBe(false)
  expect(dedupAction("distiller", "distiller")).toBe("merge")
  expect(dedupAction("agent:help", "distiller")).toBe("flag")
  expect(dedupAction("distiller", "agent:x")).toBe("flag")
})

test("entity gate prompt warns that different entities are distinct", () => {
  const { system, user } = buildEntityGatePrompt({ title: "A", body: "ba" }, { title: "B", body: "bb" })
  expect(system).toContain("DISTINCT")
  expect(user).toContain("# A")
  expect(user).toContain("# B")
})

test("parseEntityGate reads same, null on garbage", () => {
  expect(parseEntityGate('{"same":true}')).toBe(true)
  expect(parseEntityGate('{"same":false}')).toBe(false)
  expect(parseEntityGate("nope")).toBeNull()
})

test("entityGate fails safe to 'unknown' on a thrown runner", async () => {
  const v = await entityGate({ title: "a", body: "a" }, { title: "b", body: "b" }, async () => { throw new Error("x") }, "m")
  expect(v).toBe("unknown")
})

// fake embedder: identical text → identical vector (cosine 1)
const fakeEmbedder: Embedder = {
  version: "v1",
  async embed(texts) { return texts.map((t) => [/alpha/i.test(t) ? 1 : 0, /beta/i.test(t) ? 1 : 0]) },
}
function setup(run: () => Promise<string>) {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "sb-dedup-")))
  const index = new VectorIndex()
  const r = new MemoryRetriever({ store, index, embedder: fakeEmbedder, run, librarianModel: "m" })
  return { store, index, r }
}

test("two distiller notes, same fact ⇒ stale one auto-merged away", async () => {
  const { store, index, r } = setup(async () => '{"same":true}')
  const p1 = store.write("global", { title: "Old alpha", body: "alpha fact", source: "distiller" })
  const p2 = store.write("global", { title: "New alpha", body: "alpha fact restated", source: "distiller" })
  await r.indexNote(store.read(p1))
  await r.indexNote(store.read(p2))
  const res = await r.dedupe(store.read(p2))   // p2 is newest → p1 removed
  expect(res.removed).toEqual([p1])
  expect(res.flagged).toEqual([])
  expect(index.has(p1)).toBe(false)
})

test("agent-authored note involved ⇒ flagged, never removed", async () => {
  const { store, index, r } = setup(async () => '{"same":true}')
  const p1 = store.write("global", { title: "Hand note", body: "alpha by hand", source: "agent:help" })
  const p2 = store.write("global", { title: "Auto note", body: "alpha auto", source: "distiller" })
  await r.indexNote(store.read(p1))
  await r.indexNote(store.read(p2))
  const res = await r.dedupe(store.read(p2))
  expect(res.removed).toEqual([])
  expect(res.flagged).toEqual([{ note: p2, duplicate: p1 }])
  expect(index.has(p1)).toBe(true)            // protected note untouched
})

test("distinct entities (gate says false) ⇒ nothing merged or flagged", async () => {
  const { store, r } = setup(async () => '{"same":false}')
  const p1 = store.write("global", { title: "Laura blocked", body: "alpha withdrawn", source: "distiller" })
  const p2 = store.write("global", { title: "Isla blocked", body: "alpha withdrawn", source: "distiller" })
  await r.indexNote(store.read(p1))
  await r.indexNote(store.read(p2))
  const res = await r.dedupe(store.read(p2))
  expect(res.removed).toEqual([])
  expect(res.flagged).toEqual([])
})

test("below the similarity threshold ⇒ gate is never consulted", async () => {
  let gateCalls = 0
  const { store, r } = setup(async () => { gateCalls++; return '{"same":true}' })
  const p1 = store.write("global", { title: "Alpha", body: "alpha", source: "distiller" })
  const p2 = store.write("global", { title: "Beta", body: "beta", source: "distiller" })  // orthogonal vector
  await r.indexNote(store.read(p1))
  await r.indexNote(store.read(p2))
  const res = await r.dedupe(store.read(p2))
  expect(res.removed).toEqual([])
  expect(gateCalls).toBe(0)
})
