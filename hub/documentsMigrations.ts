// hub/documentsMigrations.ts
// Schema for the Documents-library SQLite mirror. The authoritative store is the on-disk
// `.sbmd` set under ARTIFACTS_DIR; this table is a queryable index rebuilt by the
// reconciliation sweep if it ever drifts. Kept in its own migration chain (separate file,
// separate `document_schema_migrations` table) so it never entangles with the conversation
// schema. Mirrors the runner pattern in hub/conversations/migrations.ts.
import type { Database } from "bun:sqlite"

const migrationOne = `
CREATE TABLE IF NOT EXISTS documents (
  token TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  conversation_id TEXT,
  size_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_id);
CREATE INDEX IF NOT EXISTS documents_visibility_idx ON documents(visibility);
`

/** Create/upgrade the documents schema. Idempotent — safe to run on every start. */
export function runDocumentsMigrations(db: Database): void {
  db.exec("PRAGMA busy_timeout = 5000")
  if (db.filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL")

  db.exec(`CREATE TABLE IF NOT EXISTS document_schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
  )`)

  db.transaction(() => {
    const v1 = db.query<{ version: number }, [number]>(
      "SELECT version FROM document_schema_migrations WHERE version = ?").get(1)
    if (!v1) {
      db.exec(migrationOne)
      db.query("INSERT INTO document_schema_migrations(version, applied_at) VALUES (?, ?)").run(1, Date.now())
    }
    db.exec("PRAGMA user_version = 1")
  })()
}
