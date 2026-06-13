import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AccessStore } from "../hub/memory/accessStore"

const HALF = 1000  // 1s half-life for tests

test("hit increments count and importance; unknown path = 0", () => {
  const a = new AccessStore(undefined, HALF)
  expect(a.importance("/x", 0)).toBe(0)
  a.hit("/x", 0)
  expect(a.count("/x")).toBe(1)
  const i1 = a.importance("/x", 0)
  a.hit("/x", 0)
  expect(a.importance("/x", 0)).toBeGreaterThan(i1)
  expect(a.importance("/x", 0)).toBeLessThan(1)
})

test("importance decays by half after one half-life of no use", () => {
  const a = new AccessStore(undefined, HALF)
  a.hit("/x", 0)               // score = 1
  const before = a.importance("/x", 0)        // 1 - 2^-1 = 0.5
  expect(before).toBeCloseTo(0.5)
  const after = a.importance("/x", HALF)      // score → 0.5 → 1 - 2^-0.5 ≈ 0.293
  expect(after).toBeCloseTo(1 - Math.pow(2, -0.5))
  expect(after).toBeLessThan(before)
})

test("more-recent / more-frequent notes outrank cold ones (coldest ordering)", () => {
  const a = new AccessStore(undefined, HALF)
  a.hit("/hot", 0); a.hit("/hot", 0); a.hit("/hot", 0)
  a.hit("/warm", 0)
  // /cold never hit
  const cold = a.coldest(["/hot", "/warm", "/cold"], 2, 0)
  expect(cold[0]).toBe("/cold")   // lowest importance first
  expect(cold[1]).toBe("/warm")
})

test("prune drops stats for notes that no longer exist", () => {
  const a = new AccessStore(undefined, HALF)
  a.hit("/keep", 0); a.hit("/gone", 0)
  a.prune(new Set(["/keep"]))
  expect(a.count("/gone")).toBe(0)
  expect(a.count("/keep")).toBe(1)
})

test("persists and reloads", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sb-acc-")), "access.json")
  const a = new AccessStore(file, HALF)
  a.hit("/x", 0); a.hit("/x", 0)
  const b = new AccessStore(file, HALF)
  expect(b.count("/x")).toBe(2)
})
