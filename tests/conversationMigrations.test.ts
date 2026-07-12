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

test("v1 schema rejects values outside domain enums", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  db.exec("INSERT INTO conversations VALUES ('c','t','a','u',1,1,NULL)")
  const invalidStatements = [
    "INSERT INTO participants VALUES ('c','u','invalid','owner',1)",
    "INSERT INTO participants VALUES ('c','u','user','invalid',1)",
    "INSERT INTO messages VALUES ('m','c',1,'u','invalid','x',NULL,'committed',NULL,1)",
    "INSERT INTO messages VALUES ('m','c',1,'u','web','x',NULL,'invalid',NULL,1)",
    "INSERT INTO transport_links VALUES ('l','c','a','x',NULL,'invalid',1,1,1)",
  ]
  for (const sql of invalidStatements) expect(() => db.exec(sql)).toThrow(/CHECK constraint failed/)
  db.exec("INSERT INTO messages VALUES ('m','c',1,'u','web','x',NULL,'committed',NULL,1)")
  db.exec("INSERT INTO transport_links VALUES ('l','c','a','x',NULL,'two_way',1,1,1)")
  expect(() => db.exec("INSERT INTO deliveries VALUES ('d','m','l','send','invalid',0,NULL,NULL,NULL,1,1)")).toThrow(/CHECK constraint failed/)
})
