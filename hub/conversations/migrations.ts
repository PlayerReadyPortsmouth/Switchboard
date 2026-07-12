import type { Database } from "bun:sqlite"

const migrationOne = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    primary_agent TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    identity TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, identity)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    author TEXT NOT NULL,
    origin TEXT NOT NULL,
    content TEXT NOT NULL,
    reply_to TEXT REFERENCES messages(id),
    state TEXT NOT NULL,
    client_key TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(conversation_id, sequence),
    UNIQUE(conversation_id, client_key)
  );
  CREATE TABLE transport_links (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    adapter TEXT NOT NULL,
    external_location_id TEXT NOT NULL,
    label TEXT,
    sync_mode TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(adapter, external_location_id)
  );
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    link_id TEXT NOT NULL REFERENCES transport_links(id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER,
    external_message_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(message_id, link_id, event_kind)
  );
  CREATE TABLE external_event_receipts (
    adapter TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    received_at INTEGER NOT NULL,
    PRIMARY KEY(adapter, external_event_id)
  );
`

export function runConversationMigrations(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  if (db.filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  db.transaction(() => {
    const applied = db.query<{ version: number }, [number]>(
      "SELECT version FROM conversation_schema_migrations WHERE version = ?",
    ).get(1)
    if (applied) return

    db.exec(migrationOne)
    db.query("INSERT INTO conversation_schema_migrations(version, applied_at) VALUES (?, ?)").run(1, Date.now())
    db.exec("PRAGMA user_version = 1")
  })()
}
