// hub/publishCleanup.test.ts
import { test, expect } from "bun:test"
import { selectExpired } from "./publishCleanup"

const NOW = new Date("2026-06-28T00:00:00Z")

test("selects tokens whose expiresAt is past", () => {
  expect(selectExpired([
    { token: "a", expiresAt: "2026-06-01T00:00:00Z" },   // past
    { token: "b", expiresAt: "2026-12-01T00:00:00Z" },   // future
  ], NOW, 3_600_000)).toEqual(["a"])
})

test("reaps an unreadable .sbmd dir only past the grace period", () => {
  expect(selectExpired([
    { token: "old", ageMs: 7_200_000 },   // 2h old, grace 1h → reap
    { token: "new", ageMs: 60_000 },      // 1m old → keep
  ], NOW, 3_600_000)).toEqual(["old"])
})

test("ignores a malformed expiresAt (keeps it)", () => {
  expect(selectExpired([{ token: "x", expiresAt: "not-a-date" }], NOW, 3_600_000)).toEqual([])
})
