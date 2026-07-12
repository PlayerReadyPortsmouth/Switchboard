import { Database } from "bun:sqlite"
import { test, expect } from "bun:test"
import { runConversationMigrations } from "../hub/conversations/migrations"

test("creates the canonical conversation schema idempotently", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  runConversationMigrations(db)
  const names = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((row) => row.name)
  expect(names).toEqual(expect.arrayContaining([
    "conversations", "participants", "messages", "transport_links",
    "deliveries", "external_event_receipts", "conversation_schema_migrations",
  ]))
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1)
})
