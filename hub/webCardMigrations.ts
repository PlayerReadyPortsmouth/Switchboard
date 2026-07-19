// hub/webCardMigrations.ts
// Schema for the canonical (web-renderable) card record.
//
// Its own migration chain and its own database file, following hub/documentsMigrations.ts.
// Deliberately NOT the `card_locations` table added by the card-persistence work: that store
// documents itself as "a CACHE, not a record of truth" and is TTL-swept, every row droppable
// at any moment with no consequence beyond an old button ceasing to route. Transcript content
// cannot live somewhere with those semantics — a card the user can still see must not
// evaporate on a sweep.
//
// Two tables because a card is mutable and its history is append-only:
//   web_cards           — one row per correlation_id, holding the CURRENT state
//   web_card_revisions  — one row per superseded state, so an edit never destroys what the
//                         card said before
import type { Database } from "bun:sqlite"

const migrationOne = `
CREATE TABLE IF NOT EXISTS web_cards (
  correlation_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  revision INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The hydration route's only query: every card in one conversation, in anchor order.
CREATE INDEX IF NOT EXISTS web_cards_conversation_idx ON web_cards(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS web_card_revisions (
  correlation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (correlation_id, revision)
);
`

/** Create/upgrade the web-card schema. Idempotent — safe to run on every start. */
export function runWebCardMigrations(db: Database): void {
  db.exec("PRAGMA busy_timeout = 5000")
  if (db.filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL")

  db.exec(`CREATE TABLE IF NOT EXISTS web_card_schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
  )`)

  db.transaction(() => {
    const v1 = db.query<{ version: number }, [number]>(
      "SELECT version FROM web_card_schema_migrations WHERE version = ?").get(1)
    if (!v1) {
      db.exec(migrationOne)
      db.query("INSERT INTO web_card_schema_migrations(version, applied_at) VALUES (?, ?)").run(1, Date.now())
    }
    db.exec("PRAGMA user_version = 1")
  })()
}
