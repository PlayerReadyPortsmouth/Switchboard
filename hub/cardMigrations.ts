// hub/cardMigrations.ts
// Schema for the card-routing store: the durable mirror of the three in-memory maps that
// decide where a clicked card button goes (CardRegistry, NotifyRouter, Gateway.modalByCustomId).
//
// Kept in its own migration chain (separate file, separate `card_schema_migrations` table) so
// it never entangles with the conversation or documents schemas — the same reason
// hub/documentsMigrations.ts exists. Mirrors the runner pattern in
// hub/conversations/migrations.ts.
//
// This store is a CACHE, not a record of truth: every row can be deleted at any time and the
// only consequence is that an old card's buttons stop routing (exactly today's behaviour).
// Nothing else reads it. That is why it gets its own file — the TTL sweep churns rows
// continuously, and that write traffic has no business sharing a WAL with the web transcript.
import type { Database } from "bun:sqlite"

const migrationOne = `
CREATE TABLE IF NOT EXISTS card_locations (
  correlation_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS card_locations_updated_idx ON card_locations(updated_at);

CREATE TABLE IF NOT EXISTS card_buttons (
  custom_id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS card_buttons_updated_idx ON card_buttons(updated_at);

CREATE TABLE IF NOT EXISTS card_modals (
  custom_id TEXT PRIMARY KEY,
  modal_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS card_modals_updated_idx ON card_modals(updated_at);
`

/** Create/upgrade the card-routing schema. Idempotent — safe to run on every start. */
export function runCardMigrations(db: Database): void {
  db.exec("PRAGMA busy_timeout = 5000")
  if (db.filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL")

  db.exec(`CREATE TABLE IF NOT EXISTS card_schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
  )`)

  db.transaction(() => {
    const v1 = db.query<{ version: number }, [number]>(
      "SELECT version FROM card_schema_migrations WHERE version = ?").get(1)
    if (!v1) {
      db.exec(migrationOne)
      db.query("INSERT INTO card_schema_migrations(version, applied_at) VALUES (?, ?)").run(1, Date.now())
    }
    db.exec("PRAGMA user_version = 1")
  })()
}
