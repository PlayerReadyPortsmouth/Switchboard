import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { VectorIndex, cosine } from "../hub/memory/vectorIndex"

test("cosine: identical=1, orthogonal=0, length-mismatch tolerated", () => {
  expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
  expect(cosine([], [1])).toBe(0)
  expect(cosine([0, 0], [1, 1])).toBe(0)
})

test("search ranks by similarity and filters by scope", async () => {
  const idx = new VectorIndex()
  await idx.set("/g/a.md", "global", [1, 0, 0])
  await idx.set("/g/b.md", "global", [0, 1, 0])
  await idx.set("/u/c.md", "users/1", [1, 0, 0])   // same vector, different scope
  const hits = await idx.search([1, 0, 0], ["global"], 10)
  expect(hits[0].path).toBe("/g/a.md")        // best match in scope
  expect(hits.map((h) => h.path)).not.toContain("/u/c.md")  // scope-filtered out
})

test("limit caps results", async () => {
  const idx = new VectorIndex()
  for (let i = 0; i < 5; i++) await idx.set(`/g/${i}.md`, "global", [1, i / 10])
  expect((await idx.search([1, 0], ["global"], 2)).length).toBe(2)
})

test("upsert replaces, remove deletes", async () => {
  const idx = new VectorIndex()
  await idx.set("/g/a.md", "global", [1, 0])
  await idx.set("/g/a.md", "global", [0, 1])
  expect(idx.size()).toBe(1)
  await idx.remove("/g/a.md")
  expect(idx.has("/g/a.md")).toBe(false)
})

test("search version filter excludes mismatched embedding spaces", async () => {
  const idx = new VectorIndex()
  await idx.set("/g/old.md", "global", [1, 0], "v1")
  await idx.set("/g/new.md", "global", [1, 0], "v2")
  const hits = await idx.search([1, 0], ["global"], 10, "v2")
  expect(hits.map((h) => h.path)).toEqual(["/g/new.md"])
  // no filter ⇒ both
  expect((await idx.search([1, 0], ["global"], 10)).length).toBe(2)
})

test("persists and reloads vectors", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "sb-vec-")), "vectors.json")
  const a = new VectorIndex(file)
  await a.set("/g/a.md", "global", [0.5, 0.5])
  const b = new VectorIndex(file)
  expect(b.has("/g/a.md")).toBe(true)
  expect((await b.search([0.5, 0.5], ["global"], 1))[0].path).toBe("/g/a.md")
})
