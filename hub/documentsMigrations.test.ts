// hub/documentsMigrations.test.ts
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { runDocumentsMigrations } from "./documentsMigrations"

test("runDocumentsMigrations creates the documents table in a fresh :memory: DB", () => {
  const db = new Database(":memory:")
  runDocumentsMigrations(db)
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(documents)").all().map((c) => c.name)
  expect(cols).toEqual([
    "token", "filename", "title", "content_type", "mode", "owner_id",
    "owner_name", "visibility", "created_at", "expires_at", "conversation_id", "size_bytes",
  ])
  expect(db.query("PRAGMA user_version").get()).toMatchObject({ user_version: 1 })
})

test("runDocumentsMigrations is idempotent — safe to run twice", () => {
  const db = new Database(":memory:")
  runDocumentsMigrations(db)
  runDocumentsMigrations(db)
  const applied = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM document_schema_migrations").get()
  expect(applied?.n).toBe(1)
})
