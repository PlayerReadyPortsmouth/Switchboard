// hub/publishCleanup.test.ts
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { selectExpired, reconcileDocuments } from "./publishCleanup"
import { runDocumentsMigrations } from "./documentsMigrations"
import { DocumentsDb, type DocumentRow } from "./documents"
import type { Sbmd } from "./publishLink"

const NOW = new Date("2026-06-28T00:00:00Z")

const sbmd = (over: Partial<Sbmd> = {}): Sbmd => ({
  v: 1, mode: "download", contentType: "text/plain", filename: "a.txt", title: "A",
  scope: "staff", createdAt: "2026-06-20T00:00:00Z", expiresAt: "", producer: "upload",
  ownerId: "ada@ready.co", ownerName: "Ada", visibility: "private", ...over,
})
function freshDb() {
  const db = new Database(":memory:")
  runDocumentsMigrations(db)
  return new DocumentsDb(db)
}

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

test("never reaps a permanent doc (empty expiresAt), even with a large ageMs", () => {
  expect(selectExpired([{ token: "perm", expiresAt: "", ageMs: 999_999_999 }], NOW, 3_600_000)).toEqual([])
})

test("reconcile: inserts a row for a disk dir with no row", () => {
  const db = freshDb()
  const res = reconcileDocuments([{ token: "t1", sbmd: sbmd(), sizeBytes: 3 }], db)
  expect(res).toMatchObject({ inserted: 1, updated: 0, deleted: 0 })
  expect(db.get("t1")!.ownerId).toBe("ada@ready.co")
})

test("reconcile: deletes a row whose dir no longer exists", () => {
  const db = freshDb()
  reconcileDocuments([{ token: "t1", sbmd: sbmd(), sizeBytes: 3 }], db)
  const res = reconcileDocuments([], db)   // disk now empty
  expect(res).toMatchObject({ deleted: 1 })
  expect(db.get("t1")).toBeNull()
})

test("reconcile: overwrites a row whose fields drifted from disk, preserving conversationId", () => {
  const db = freshDb()
  // seed a row with a conversationId and a stale title
  db.upsert({
    token: "t1", filename: "a.txt", title: "STALE", contentType: "text/plain", mode: "download",
    ownerId: "ada@ready.co", ownerName: "Ada", visibility: "private",
    createdAt: "2026-06-20T00:00:00Z", expiresAt: null, conversationId: "conv-9", sizeBytes: 3,
  } satisfies DocumentRow)
  const res = reconcileDocuments([{ token: "t1", sbmd: sbmd({ title: "FRESH" }), sizeBytes: 3 }], db)
  expect(res).toMatchObject({ updated: 1 })
  const row = db.get("t1")!
  expect(row.title).toBe("FRESH")
  expect(row.conversationId).toBe("conv-9")   // preserved from the existing row
})

test("reconcile: Discord-originated sbmd (no owner) → owner_id 'discord', visibility org", () => {
  const db = freshDb()
  reconcileDocuments([{ token: "t1", sbmd: sbmd({ ownerId: undefined, ownerName: undefined, visibility: undefined }), sizeBytes: 3 }], db)
  const row = db.get("t1")!
  expect(row.ownerId).toBe("discord")
  expect(row.visibility).toBe("org")
})

test("reconcile: an unchanged row is neither updated nor duplicated", () => {
  const db = freshDb()
  reconcileDocuments([{ token: "t1", sbmd: sbmd(), sizeBytes: 3 }], db)
  const res = reconcileDocuments([{ token: "t1", sbmd: sbmd(), sizeBytes: 3 }], db)
  expect(res).toMatchObject({ inserted: 0, updated: 0, deleted: 0 })
})
