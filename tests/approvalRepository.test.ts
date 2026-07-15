import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalRecord, ApprovalRisk } from "../hub/approvalTypes"
import {
  ApprovalRepositoryError,
  SqliteApprovalHistoryRepository,
} from "../hub/approvalRepository"
import { runConversationMigrations } from "../hub/conversations/migrations"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

function temporaryDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-approvals-"))
  tempDirs.push(dir)
  return join(dir, "switchboard.sqlite")
}

function openHarness(file = ":memory:"): {
  db: Database
  repo: SqliteApprovalHistoryRepository
} {
  const db = file === ":memory:" ? new Database(file) : new Database(file, { create: true })
  runConversationMigrations(db)
  return { db, repo: new SqliteApprovalHistoryRepository(db) }
}

function harness(): { db: Database; repo: SqliteApprovalHistoryRepository } {
  return openHarness()
}

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const createdAt = overrides.createdAt ?? 100
  const base: ApprovalRecord = {
    id: "approval",
    version: 1,
    kind: "outbound",
    target: "deploy",
    summary: "POST deploy",
    detail: { routeId: "deploy", safe: [true, 1, null] },
    requestedBy: { surface: "web", id: "alice" },
    originConversationId: null,
    risk: "low",
    effectFingerprint: "f".repeat(64),
    createdAt,
    expiresAt: overrides.expiresAt ?? createdAt + 1_000,
    terminalAt: null,
    state: "registering",
    decisionBy: null,
    decisionAt: null,
    decisionKey: null,
    outcomeReason: null,
    execution: "not_applicable",
    executionDetail: null,
    executionStartedAt: null,
    executionFinishedAt: null,
    correlationId: `correlation-${overrides.id ?? "approval"}`,
  }
  return { ...base, ...overrides }
}

function insertPending(
  repo: SqliteApprovalHistoryRepository,
  overrides: Partial<ApprovalRecord>,
): ApprovalRecord {
  const registering = record(overrides)
  const inserted = repo.insertRegistering(registering)
  if (inserted.kind !== "inserted") throw new Error(`fixture collision: ${registering.id}`)
  const active = repo.activate(registering.id, registering.version)
  if (!active) throw new Error(`fixture activation failed: ${registering.id}`)
  return active
}

function insertExpired(
  repo: SqliteApprovalHistoryRepository,
  overrides: Partial<ApprovalRecord> & { id: string },
  terminalAt: number,
): ApprovalRecord {
  insertPending(repo, { createdAt: 1, expiresAt: terminalAt, ...overrides })
  const expired = repo.expire(overrides.id, terminalAt)
  if (!expired) throw new Error(`fixture expiry failed: ${overrides.id}`)
  return expired
}

function expectRepositoryError(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalRepositoryError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected ApprovalRepositoryError(${code})`)
}

function rawCursor(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url")
}

test("registering rows are excluded from every read and aggregate", () => {
  const { db, repo } = harness()
  repo.insertRegistering(record({ id: "registering", summary: "hidden needle" }))
  repo.putNotification("registering", "discord", "hidden-reference", 200)

  expect(repo.getVisible("registering")).toBeNull()
  expect(repo.list({ group: "pending", limit: 50 }).items).toEqual([])
  expect(repo.list({ group: "history", search: "hidden needle", limit: 50 }).items).toEqual([])
  expect(repo.summarizePending({ search: "hidden needle" })).toEqual({
    count: 0,
    highestRisk: null,
    nearestExpiry: null,
    firstId: null,
  })
  expect(repo.pendingCount()).toBe(0)
  expect(repo.listNotifications()).toEqual([])
  expect(repo.listPendingMissingNotification("discord", null, 50)).toEqual([])
  db.close()
})

test("sanitized terminal history survives a file reopen", () => {
  const file = temporaryDatabasePath()
  const first = openHarness(file)
  first.repo.insertRegistering(record({ id: "persisted", expiresAt: 1_000 }))
  first.repo.activate("persisted", 1)
  first.repo.expire("persisted", 2_000)
  first.db.close()

  const second = openHarness(file)
  expect(second.repo.getVisible("persisted")).toMatchObject({
    id: "persisted",
    state: "expired",
    execution: "not_applicable",
    detail: { routeId: "deploy", safe: [true, 1, null] },
    terminalAt: 2_000,
  })
  second.db.close()
})

test("activation and terminal registration transitions use exact state predicates", () => {
  const { db, repo } = harness()
  repo.insertRegistering(record({ id: "activate" }))
  expect(repo.activate("activate", 99)).toBeNull()
  expect(repo.getVisible("activate")).toBeNull()
  expect(repo.activate("activate", 1)).toMatchObject({ id: "activate", state: "pending", version: 2 })
  expect(repo.activate("activate", 2)).toBeNull()

  repo.insertRegistering(record({ id: "interrupted" }))
  expect(repo.interruptRegistration("interrupted", 300, "activation_failed")).toMatchObject({
    id: "interrupted",
    state: "interrupted",
    version: 2,
    terminalAt: 300,
    outcomeReason: "activation_failed",
  })
  expect(repo.interruptRegistration("interrupted", 301, "again")).toBeNull()

  insertPending(repo, { id: "not-due", expiresAt: 500 })
  expect(repo.expire("not-due", 499)).toBeNull()
  expect(repo.expire("not-due", 500)).toMatchObject({ state: "expired", version: 3, terminalAt: 500 })
  expect(repo.expire("not-due", 501)).toBeNull()
  db.close()
})

test("pending keyset order is risk desc, expiry asc, creation asc, id asc", () => {
  const { db, repo } = harness()
  insertPending(repo, { id: "low", risk: "low", expiresAt: 100, createdAt: 1 })
  insertPending(repo, { id: "elevated-later", risk: "elevated", expiresAt: 300, createdAt: 1 })
  insertPending(repo, { id: "elevated-soon", risk: "elevated", expiresAt: 200, createdAt: 1 })
  insertPending(repo, { id: "destructive-soon", risk: "destructive", expiresAt: 150, createdAt: 1 })

  const first = repo.list({ group: "pending", limit: 2 })
  const second = repo.list({ group: "pending", limit: 2, cursor: first.nextCursor! })
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual([
    "destructive-soon", "elevated-soon", "elevated-later", "low",
  ])
  expect(second.nextCursor).toBeNull()
  db.close()
})

test("pending keyset uses creation and id tie breakers without duplicates", () => {
  const { db, repo } = harness()
  for (const [id, createdAt] of [["b", 2], ["a", 2], ["old", 1]] as const) {
    insertPending(repo, { id, risk: "elevated", expiresAt: 500, createdAt })
  }
  const pages: string[] = []
  let cursor: string | undefined
  do {
    const page = repo.list({ group: "pending", limit: 1, cursor })
    pages.push(...page.items.map((item) => item.id))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(pages).toEqual(["old", "a", "b"])
  db.close()
})

test("repository-emitted cursors remain valid for every accepted record ID", () => {
  const { db, repo } = harness()
  const longId = `a-${"x".repeat(3_000)}`
  insertPending(repo, { id: longId, risk: "elevated", expiresAt: 500, createdAt: 1 })
  insertPending(repo, { id: "z", risk: "elevated", expiresAt: 500, createdAt: 1 })
  const first = repo.list({ group: "pending", limit: 1 })
  expect(first.items.map((item) => item.id)).toEqual([longId])
  expect(repo.list({ group: "pending", limit: 1, cursor: first.nextCursor! }).items.map((item) => item.id))
    .toEqual(["z"])
  expectRepositoryError(
    () => repo.insertRegistering(record({ id: "x".repeat(4_097) })),
    "invalid_record",
  )
  db.close()

  const escaped = harness()
  const controlId = "\u0000".repeat(4_096)
  insertPending(escaped.repo, { id: controlId, risk: "elevated", expiresAt: 500, createdAt: 1 })
  insertPending(escaped.repo, { id: "z-control", risk: "elevated", expiresAt: 500, createdAt: 1 })
  const escapedFirst = escaped.repo.list({ group: "pending", limit: 1 })
  expect(escapedFirst.nextCursor!.length).toBeGreaterThan(8_192)
  expect(escaped.repo.list({ group: "pending", limit: 1, cursor: escapedFirst.nextCursor! }).items[0]?.id)
    .toBe("z-control")
  escaped.db.close()
})

test("history keyset order is terminal time desc then id desc", () => {
  const { db, repo } = harness()
  insertExpired(repo, { id: "old" }, 200)
  insertExpired(repo, { id: "a" }, 300)
  insertExpired(repo, { id: "z" }, 300)

  const first = repo.list({ group: "history", limit: 2 })
  const second = repo.list({ group: "history", limit: 2, cursor: first.nextCursor! })
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(["z", "a", "old"])
  expect(second.nextCursor).toBeNull()
  db.close()
})

test("list applies exact risk, kind, requester, state, conversation, time, and literal text filters", () => {
  const { db, repo } = harness()
  insertPending(repo, {
    id: "matching",
    risk: "elevated",
    kind: "outbound",
    requestedBy: { surface: "web", id: "team:alice" },
    originConversationId: "conversation-a",
    createdAt: 100,
    expiresAt: 1_000,
    summary: "Deploy sanitized",
    target: "alpha-target",
  })
  insertPending(repo, {
    id: "other",
    risk: "low",
    kind: "process",
    requestedBy: { surface: "discord", id: "bob" },
    originConversationId: "conversation-b",
    createdAt: 200,
    expiresAt: 1_100,
    summary: "Routine",
    target: "100% beta",
  })
  insertExpired(repo, {
    id: "history",
    requestedBy: { surface: "web", id: "team:alice" },
    originConversationId: "conversation-a",
    decisionBy: { surface: "web", id: "operator" },
    decisionAt: 500,
    decisionKey: "decision-key",
  }, 600)

  const pendingIds = (query: Parameters<typeof repo.list>[0]) =>
    repo.list(query).items.map((item) => item.id)
  expect(pendingIds({ group: "pending", risk: "elevated" })).toEqual(["matching"])
  expect(pendingIds({ group: "pending", kind: "process" })).toEqual(["other"])
  expect(pendingIds({ group: "pending", requester: "web:team:alice" })).toEqual(["matching"])
  expect(pendingIds({ group: "pending", requester: "web:team" })).toEqual([])
  expect(pendingIds({ group: "pending", state: "pending" })).toEqual(["matching", "other"])
  expect(pendingIds({ group: "pending", conversationId: "conversation-a" })).toEqual(["matching"])
  expect(pendingIds({ group: "pending", createdFrom: 150, createdTo: 250 })).toEqual(["other"])
  expect(pendingIds({ group: "pending", search: "sanitized alpha" })).toEqual(["matching"])
  expect(pendingIds({ group: "pending", search: "%" })).toEqual(["other"])
  expect(pendingIds({ group: "history", state: "expired" })).toEqual(["history"])
  expect(pendingIds({ group: "history", decisionFrom: 500, decisionTo: 500 })).toEqual(["history"])
  expect(pendingIds({ group: "history", decisionFrom: 501 })).toEqual([])
  db.close()
})

test("list rejects malformed filters and incompatible group-state pairs", () => {
  const { db, repo } = harness()
  for (const requester of ["WEB:alice", "web", ":alice", "web:", "web space:alice"]) {
    expectRepositoryError(() => repo.list({ group: "pending", requester }), "invalid_filter")
  }
  expectRepositoryError(() => repo.list({ group: "pending", state: "denied" }), "invalid_filter")
  expectRepositoryError(() => repo.list({ group: "history", state: "pending" }), "invalid_filter")
  expectRepositoryError(() => repo.list({ group: "pending", limit: 0 }), "invalid_filter")
  expectRepositoryError(() => repo.list({ group: "pending", limit: 101 }), "invalid_filter")
  expectRepositoryError(() => repo.list({ group: "pending", createdFrom: Number.POSITIVE_INFINITY }), "invalid_filter")
  expectRepositoryError(() => repo.list({ group: "pending", createdFrom: 2, createdTo: 1 }), "invalid_filter")
  expectRepositoryError(() => repo.summarizePending({ state: "denied" }), "invalid_filter")
  const trappedQuery = new Proxy({ group: "pending" as const }, {
    getOwnPropertyDescriptor: () => { throw new Error("query descriptor trap") },
  })
  expectRepositoryError(() => repo.list(trappedQuery), "invalid_filter")
  db.close()
})

test("invalid, wrong-group, truncated, non-finite, and non-canonical cursors fail closed", () => {
  const { db, repo } = harness()
  insertPending(repo, { id: "a" })
  insertPending(repo, { id: "b" })
  const valid = repo.list({ group: "pending", limit: 1 }).nextCursor!
  const invalidCursors = [
    "not base64!",
    valid.slice(0, -1),
    rawCursor('{"v":1,"group":"history","terminalAt":1,"id":"a"}'),
    rawCursor('{"v":1,"group":"pending","riskRank":3,"expiresAt":1e400,"createdAt":1,"id":"a"}'),
    rawCursor('{"v":1,"group":"pending","riskRank":3,"expiresAt":1,"createdAt":1,"id":"a","extra":true}'),
    Buffer.from([0xff]).toString("base64url"),
    `${valid}=`,
  ]
  for (const cursor of invalidCursors) {
    expectRepositoryError(() => repo.list({ group: "pending", cursor }), "invalid_cursor")
  }
  db.close()
})

test("pending aggregate covers the full filtered set rather than the first page", () => {
  const { db, repo } = harness()
  for (let index = 0; index < 100; index += 1) {
    insertPending(repo, {
      id: `high-${index.toString().padStart(3, "0")}`,
      risk: "destructive",
      originConversationId: "allowed",
      createdAt: 10 + index,
      expiresAt: 1_000 + index,
    })
  }
  insertPending(repo, {
    id: "nearest-low",
    risk: "low",
    originConversationId: "allowed",
    createdAt: 110,
    expiresAt: 150,
  })
  insertPending(repo, {
    id: "other-conversation",
    risk: "destructive",
    originConversationId: "other",
    createdAt: 1,
    expiresAt: 2,
  })
  repo.insertRegistering(record({
    id: "hidden-registration",
    risk: "destructive",
    originConversationId: "allowed",
    createdAt: 1,
    expiresAt: 2,
  }))

  const firstPage = repo.list({ group: "pending", conversationId: "allowed", limit: 100 })
  expect(firstPage.items).toHaveLength(100)
  expect(firstPage.items.some((item) => item.id === "nearest-low")).toBeFalse()
  expect(repo.summarizePending({ conversationId: "allowed" })).toEqual({
    count: 101,
    highestRisk: "destructive",
    nearestExpiry: 150,
    firstId: "high-000",
  })
  expect(repo.summarizePending({ conversationId: "missing" })).toEqual({
    count: 0,
    highestRisk: null,
    nearestExpiry: null,
    firstId: null,
  })
  db.close()
})

test("strict JSON decoding rejects malformed, non-finite, prototype, deep, large, and oversized values", () => {
  const { db, repo } = harness()
  insertPending(repo, { id: "corrupt" })
  let deep: unknown = null
  for (let depth = 0; depth < 40; depth += 1) deep = [deep]
  const corruptJson = [
    "{",
    "1e400",
    '{"__proto__":{"polluted":true}}',
    JSON.stringify(deep),
    JSON.stringify(Array.from({ length: 1_001 }, () => null)),
    JSON.stringify("x".repeat(1_048_577)),
  ]
  for (const detail of corruptJson) {
    db.query("UPDATE approval_records SET detail_json=? WHERE id='corrupt'").run(detail)
    expectRepositoryError(() => repo.getVisible("corrupt"), "corrupt_record")
  }
  db.query("UPDATE approval_records SET detail_json='{}', execution_detail_json='1e400' WHERE id='corrupt'").run()
  expectRepositoryError(() => repo.getVisible("corrupt"), "corrupt_record")
  const trappedDetail = new Proxy({ safe: true }, {
    getOwnPropertyDescriptor: () => { throw new Error("detail descriptor trap") },
  })
  expectRepositoryError(() => repo.insertRegistering(record({
    id: "trapped-detail",
    detail: trappedDetail,
  })), "corrupt_record")
  db.close()
})

test("strict row mapping validates scalar types, nullable relationships, and state pairs", () => {
  const corruptions: Array<{ sql: string; reset: string }> = [
    { sql: "UPDATE approval_records SET version=1.5 WHERE id='row'", reset: "UPDATE approval_records SET version=2 WHERE id='row'" },
    { sql: "UPDATE approval_records SET decision_at='not-a-number' WHERE id='row'", reset: "UPDATE approval_records SET decision_at=NULL WHERE id='row'" },
    { sql: "UPDATE approval_records SET decision_surface='web', decision_id=NULL WHERE id='row'", reset: "UPDATE approval_records SET decision_surface=NULL WHERE id='row'" },
    { sql: "UPDATE approval_records SET decision_surface='', decision_id='', decision_at=1, decision_key='' WHERE id='row'", reset: "UPDATE approval_records SET decision_surface=NULL, decision_id=NULL, decision_at=NULL, decision_key=NULL WHERE id='row'" },
    { sql: "UPDATE approval_records SET summary='' WHERE id='row'", reset: "UPDATE approval_records SET summary='POST deploy' WHERE id='row'" },
    { sql: "UPDATE approval_records SET origin_conversation_id='' WHERE id='row'", reset: "UPDATE approval_records SET origin_conversation_id=NULL WHERE id='row'" },
    { sql: "UPDATE approval_records SET summary=x'80' WHERE id='row'", reset: "UPDATE approval_records SET summary='POST deploy' WHERE id='row'" },
  ]
  const { db, repo } = harness()
  insertPending(repo, { id: "row" })
  for (const { sql, reset } of corruptions) {
    db.exec(sql)
    expectRepositoryError(() => repo.getVisible("row"), "corrupt_record")
    db.exec(reset)
  }
  db.exec("PRAGMA ignore_check_constraints=ON; UPDATE approval_records SET state='granted', execution_outcome='not_applicable' WHERE id='row'")
  expectRepositoryError(() => repo.getVisible("row"), "corrupt_record")
  db.close()
})

test("pending aggregate fails closed when its deterministic first identifier is corrupt", () => {
  const { db, repo } = harness()
  db.exec(`
    INSERT INTO approval_records(
      id, version, kind, target, summary, detail_json, requested_surface,
      requested_id, risk, effect_fingerprint, created_at, expires_at,
      state, execution_outcome, correlation_id
    ) VALUES ('', 1, 'test', 'target', 'summary', '{}', 'web', 'owner',
      'low', 'fingerprint', 1, 2, 'pending', 'not_applicable', 'correlation')
  `)
  expectRepositoryError(() => repo.summarizePending({}), "corrupt_record")
  db.close()
})

test("row mapping selects explicit columns and ignores later table additions", () => {
  const { db, repo } = harness()
  insertPending(repo, { id: "explicit" })
  db.exec("ALTER TABLE approval_records ADD COLUMN injected_secret TEXT; UPDATE approval_records SET injected_secret='must-not-spread'")
  const visible = repo.getVisible("explicit") as ApprovalRecord & { injected_secret?: string }
  expect(visible.injected_secret).toBeUndefined()
  expect(JSON.stringify(visible)).not.toContain("must-not-spread")
  db.close()
})

test("insertRegistering maps only the approval primary-key collision", () => {
  const { db, repo } = harness()
  expect(repo.insertRegistering(record({ id: "same" }))).toEqual({ kind: "inserted" })
  expect(repo.insertRegistering(record({ id: "same" }))).toEqual({ kind: "id_collision" })
  db.exec(`
    CREATE TRIGGER reject_blocked_approval
    BEFORE INSERT ON approval_records
    WHEN NEW.id = 'blocked'
    BEGIN
      SELECT RAISE(ABORT, 'blocked by unrelated constraint');
    END;
  `)
  expect(() => repo.insertRegistering(record({ id: "blocked" }))).toThrow(/blocked by unrelated constraint/)
  expect(() => repo.insertRegistering(record({
    id: "bad-risk",
    risk: "critical" as ApprovalRisk,
  }))).toThrow(/CHECK constraint failed/)
  db.close()
})

test("notification references upsert by adapter and missing scans remain adapter scoped", () => {
  const { db, repo } = harness()
  for (const id of ["a", "b", "c"]) insertPending(repo, { id })
  repo.putNotification("a", "discord", "old", 10)
  repo.putNotification("a", "discord", "new", 20)
  repo.putNotification("b", "slack", "slack-b", 30)

  expect(repo.listNotifications()).toEqual([
    { approvalId: "a", adapter: "discord", reference: "new" },
    { approvalId: "b", adapter: "slack", reference: "slack-b" },
  ])
  expect(repo.listNotifications("a")).toEqual([
    { approvalId: "a", adapter: "discord", reference: "new" },
  ])
  expect(repo.listPendingMissingNotification("discord", null, 10).map((item) => item.id)).toEqual(["b", "c"])
  expect(repo.listPendingMissingNotification("slack", null, 10).map((item) => item.id)).toEqual(["a", "c"])
  expect(repo.listPendingMissingNotification("discord", "b", 1).map((item) => item.id)).toEqual(["c"])
  db.close()
})
