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
    kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'external')),
    role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, identity)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    author TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('web', 'agent', 'transport', 'system')),
    content TEXT NOT NULL,
    reply_to TEXT REFERENCES messages(id),
    state TEXT NOT NULL CHECK (state IN ('committed', 'queued', 'working', 'streaming', 'completed', 'failed')),
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
    sync_mode TEXT NOT NULL CHECK (sync_mode IN ('two_way', 'inbound_only', 'outbound_only', 'notifications_only')),
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
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'retry_wait', 'exhausted')),
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

const migrationTwo = `
  CREATE TABLE external_message_links (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    link_id TEXT NOT NULL REFERENCES transport_links(id) ON DELETE CASCADE,
    external_message_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, link_id),
    UNIQUE (link_id, external_message_id)
  );
`
const migrationThree = `
  ALTER TABLE deliveries ADD COLUMN lease_owner TEXT;
  ALTER TABLE deliveries ADD COLUMN lease_expires_at INTEGER;
  CREATE INDEX deliveries_due_lease_idx ON deliveries(state, next_attempt_at, lease_expires_at);
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
    const v1 = db.query<{ version: number }, [number]>(
      "SELECT version FROM conversation_schema_migrations WHERE version = ?",
    ).get(1)
    if (!v1) {
      db.exec(migrationOne)
      db.query("INSERT INTO conversation_schema_migrations(version, applied_at) VALUES (?, ?)").run(1, Date.now())
    }
    const v2 = db.query<{ version: number }, [number]>("SELECT version FROM conversation_schema_migrations WHERE version = ?").get(2)
    if (!v2) {
      db.exec(migrationTwo)
      db.query("INSERT INTO conversation_schema_migrations(version, applied_at) VALUES (?, ?)").run(2, Date.now())
    }
    const v3 = db.query<{ version: number }, [number]>("SELECT version FROM conversation_schema_migrations WHERE version = ?").get(3)
    if (!v3) {
      db.exec(migrationThree)
      db.query("INSERT INTO conversation_schema_migrations(version, applied_at) VALUES (?, ?)").run(3, Date.now())
    }
    db.exec("PRAGMA user_version = 3")
  })()
}
