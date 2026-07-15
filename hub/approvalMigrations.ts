export const approvalMigrationFour = `
  CREATE TABLE approval_records (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version > 0),
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    requested_surface TEXT NOT NULL,
    requested_id TEXT NOT NULL,
    origin_conversation_id TEXT,
    risk TEXT NOT NULL CHECK (risk IN ('low','elevated','destructive')),
    effect_fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    terminal_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('registering','pending','granted','denied','expired','interrupted')),
    decision_surface TEXT,
    decision_id TEXT,
    decision_at INTEGER,
    decision_key TEXT,
    outcome_reason TEXT,
    execution_outcome TEXT NOT NULL CHECK (execution_outcome IN ('not_applicable','pending','succeeded','failed','interrupted')),
    execution_detail_json TEXT,
    execution_started_at INTEGER,
    execution_finished_at INTEGER,
    correlation_id TEXT NOT NULL,
    CHECK (expires_at >= created_at),
    CHECK (
      (state IN ('registering','pending','denied','expired','interrupted') AND execution_outcome='not_applicable') OR
      (state='granted' AND execution_outcome IN ('pending','succeeded','failed','interrupted'))
    )
  );

  CREATE INDEX approval_pending_order_idx
    ON approval_records(state, risk, expires_at, created_at, id);
  CREATE INDEX approval_history_order_idx
    ON approval_records(state, terminal_at DESC, id DESC);
  CREATE INDEX approval_origin_idx
    ON approval_records(origin_conversation_id, state, expires_at);

  CREATE TABLE approval_idempotency (
    principal_surface TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    approval_id TEXT NOT NULL REFERENCES approval_records(id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_flight','completed')),
    result_json TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (principal_surface, principal_id, idempotency_key)
  );

  CREATE TABLE approval_notifications (
    approval_id TEXT NOT NULL REFERENCES approval_records(id) ON DELETE CASCADE,
    adapter TEXT NOT NULL,
    reference TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (approval_id, adapter)
  );
`
