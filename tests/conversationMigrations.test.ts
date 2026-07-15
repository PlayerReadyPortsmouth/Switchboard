import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import {
  migrationOne,
  migrationThree,
  migrationTwo,
  runConversationMigrations,
} from "../hub/conversations/migrations"

function createVersionThreeDatabase(db: Database): void {
  db.exec(`
    CREATE TABLE conversation_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    ${migrationOne}
    ${migrationTwo}
    ${migrationThree}
    INSERT INTO conversation_schema_migrations(version, applied_at) VALUES
      (1, 1), (2, 2), (3, 3);
    INSERT INTO conversations(
      id, title, primary_agent, created_by, created_at, updated_at, archived_at
    ) VALUES ('before-v4', 'Before v4', 'architect', 'owner', 10, 10, NULL);
    PRAGMA user_version = 3;
  `)
}

function insertApprovalPair(
  db: Database,
  id: string,
  state: string,
  execution: string,
  risk = "low",
): void {
  db.query(`
    INSERT INTO approval_records(
      id, version, kind, target, summary, detail_json,
      requested_surface, requested_id, origin_conversation_id, risk,
      effect_fingerprint, created_at, expires_at, state,
      execution_outcome, correlation_id
    ) VALUES (?, 1, 'test', 'target', 'summary', '{}',
      'web', 'owner', NULL, ?, 'fingerprint', 1, 2, ?, ?, 'correlation')
  `).run(id, risk, state, execution)
}

test("creates the canonical conversation and approval schema idempotently", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  runConversationMigrations(db)
  const names = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((row) => row.name)
  expect(names).toEqual(expect.arrayContaining([
    "conversations", "participants", "messages", "transport_links",
    "deliveries", "external_event_receipts", "external_message_links", "conversation_schema_migrations",
    "approval_records", "approval_idempotency", "approval_notifications",
  ]))
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM conversation_schema_migrations WHERE version = 4",
  ).get()?.count).toBe(1)
  db.close()
})

test("upgrades an existing v1 database with link-scoped external message mappings", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  db.exec("DROP TABLE external_message_links; DELETE FROM conversation_schema_migrations WHERE version=2; PRAGMA user_version=1")
  runConversationMigrations(db)
  expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='external_message_links'").get()?.name).toBe("external_message_links")
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
  db.close()
})

test("migration four adds durable approval history without changing conversation rows", () => {
  const db = new Database(":memory:")
  createVersionThreeDatabase(db)
  runConversationMigrations(db)
  const names = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((row) => row.name)
  expect(names).toContain("approval_records")
  expect(names).toContain("approval_idempotency")
  expect(names).toContain("approval_notifications")
  expect(db.query("SELECT id FROM conversations WHERE id='before-v4'").get()).toBeTruthy()
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
  runConversationMigrations(db)
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM conversation_schema_migrations WHERE version=4",
  ).get()?.count).toBe(1)
  db.close()
})

test("approval schema accepts only the exact lifecycle and execution pairs", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  const states = ["registering", "pending", "granted", "denied", "expired", "interrupted"] as const
  const executions = ["not_applicable", "pending", "succeeded", "failed", "interrupted"] as const
  const validPairs = [
    ["registering", "not_applicable"],
    ["pending", "not_applicable"],
    ["denied", "not_applicable"],
    ["expired", "not_applicable"],
    ["interrupted", "not_applicable"],
    ["granted", "pending"],
    ["granted", "succeeded"],
    ["granted", "failed"],
    ["granted", "interrupted"],
  ] as const
  const valid = new Set(validPairs.map(([state, execution]) => `${state}:${execution}`))

  for (const [index, [state, execution]] of validPairs.entries()) {
    expect(() => insertApprovalPair(db, `valid-${index}`, state, execution)).not.toThrow()
  }
  let invalidIndex = 0
  for (const state of states) {
    for (const execution of executions) {
      if (valid.has(`${state}:${execution}`)) continue
      expect(() => insertApprovalPair(db, `invalid-${invalidIndex++}`, state, execution))
        .toThrow(/CHECK constraint failed/)
    }
  }
  db.close()
})

test("approval schema rejects invalid risk, nonpositive versions, and backwards expiry", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  expect(() => insertApprovalPair(db, "bad-risk", "pending", "not_applicable", "critical"))
    .toThrow(/CHECK constraint failed/)
  expect(() => db.exec(`
    INSERT INTO approval_records(
      id, version, kind, target, summary, detail_json, requested_surface,
      requested_id, risk, effect_fingerprint, created_at, expires_at,
      state, execution_outcome, correlation_id
    ) VALUES ('bad-version', 0, 'test', 'target', 'summary', '{}', 'web',
      'owner', 'low', 'fingerprint', 1, 2, 'pending', 'not_applicable', 'correlation')
  `)).toThrow(/CHECK constraint failed/)
  expect(() => db.exec(`
    INSERT INTO approval_records(
      id, version, kind, target, summary, detail_json, requested_surface,
      requested_id, risk, effect_fingerprint, created_at, expires_at,
      state, execution_outcome, correlation_id
    ) VALUES ('bad-expiry', 1, 'test', 'target', 'summary', '{}', 'web',
      'owner', 'low', 'fingerprint', 2, 1, 'pending', 'not_applicable', 'correlation')
  `)).toThrow(/CHECK constraint failed/)
  db.close()
})

test("migration ledger and version-four DDL roll back together on failure", () => {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE conversation_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TRIGGER reject_version_four
    BEFORE INSERT ON conversation_schema_migrations
    WHEN NEW.version = 4
    BEGIN
      SELECT RAISE(ABORT, 'reject version four');
    END;
  `)

  expect(() => runConversationMigrations(db)).toThrow(/reject version four/)
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM conversation_schema_migrations",
  ).get()?.count).toBe(0)
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(0)
  for (const name of ["conversations", "approval_records", "approval_idempotency", "approval_notifications"]) {
    expect(db.query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name)).toBeNull()
  }
  db.close()
})

test("conversation schema rejects values outside domain enums", () => {
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
  expect(() => db.exec("INSERT INTO deliveries(id,message_id,link_id,event_kind,state,attempts,next_attempt_at,external_message_id,error,created_at,updated_at) VALUES ('d','m','l','send','invalid',0,NULL,NULL,NULL,1,1)")).toThrow(/CHECK constraint failed/)
  db.close()
})
