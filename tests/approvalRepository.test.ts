import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ApprovalPrincipal,
  ApprovalRecord,
  ApprovalRisk,
} from "../hub/approvalTypes"
import {
  ApprovalRepositoryError,
  SqliteApprovalHistoryRepository,
} from "../hub/approvalRepository"
import type {
  ApprovalDecisionReservation,
  ApprovalDecisionReservationInput,
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

type DecisionInputOverrides = Partial<Omit<ApprovalDecisionReservationInput, "approvalId">> & {
  id?: string
}

function decisionInput(overrides: DecisionInputOverrides = {}): ApprovalDecisionReservationInput {
  const { id, ...inputOverrides } = overrides
  return {
    approvalId: id ?? "approval",
    principal: { surface: "web", id: "operator" },
    decision: "grant",
    expectedVersion: 2,
    idempotencyKey: "decision-key",
    requestHash: "request-hash",
    now: 10,
    ...inputOverrides,
  }
}

function pendingHarness(
  overrides: Partial<ApprovalRecord> = {},
): { db: Database; repo: SqliteApprovalHistoryRepository; pending: ApprovalRecord } {
  const { db, repo } = harness()
  const pending = insertPending(repo, {
    id: "approval",
    createdAt: 1,
    expiresAt: 1_000,
    ...overrides,
  })
  return { db, repo, pending }
}

function seedPendingFile(
  file: string,
  input: { id: string; version?: number; expiresAt: number },
): void {
  const { db, repo } = openHarness(file)
  const pending = insertPending(repo, { id: input.id, createdAt: 1, expiresAt: input.expiresAt })
  if (input.version !== undefined && input.version !== pending.version) {
    db.query("UPDATE approval_records SET version=? WHERE id=?").run(input.version, input.id)
  }
  db.close()
}

type ApprovalRaceOperation =
  | { op: "reserve"; input: ApprovalDecisionReservationInput }
  | { op: "expire"; id: string; now: number }

type ApprovalRaceResult =
  | ApprovalDecisionReservation
  | { kind: "expire_result"; record: ApprovalRecord | null }

type ApprovalRaceWireMessage =
  | { kind: "ready" }
  | { kind: "result"; result: ApprovalRaceResult }
  | { kind: "error"; error: { name: string; message: string; code?: string } }

function approvalRaceWorker(
  file: string,
  barrier: SharedArrayBuffer,
  operation: ApprovalRaceOperation,
): { worker: Worker; ready: Promise<void>; result: Promise<ApprovalRaceResult> } {
  const worker = new Worker(new URL("./fixtures/sqliteLockWorker.ts", import.meta.url).href)
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveResult!: (result: ApprovalRaceResult) => void
  let rejectResult!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const result = new Promise<ApprovalRaceResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const reject = (error: Error) => {
    rejectReady(error)
    rejectResult(error)
  }
  worker.onmessage = event => {
    const message = event.data as ApprovalRaceWireMessage
    if (message.kind === "ready") {
      resolveReady()
      return
    }
    if (message.kind === "result") {
      resolveResult(message.result)
      return
    }
    const error = Object.assign(new Error(message.error.message), {
      name: message.error.name,
      ...(message.error.code === undefined ? {} : { code: message.error.code }),
    })
    reject(error)
  }
  worker.onerror = event => reject(
    event.error instanceof Error ? event.error : new Error(event.message),
  )
  worker.postMessage({ kind: "approval_race", file, barrier, operation })
  return { worker, ready, result }
}

async function runApprovalBarrierRace(
  file: string,
  operations: { left: ApprovalRaceOperation; right: ApprovalRaceOperation },
): Promise<ApprovalRaceResult[]> {
  const barrier = new SharedArrayBuffer(4)
  const view = new Int32Array(barrier)
  const left = approvalRaceWorker(file, barrier, operations.left)
  const right = approvalRaceWorker(file, barrier, operations.right)
  try {
    await Promise.all([left.ready, right.ready])
    Atomics.store(view, 0, 1)
    Atomics.notify(view, 0, 2)
    const settled = await Promise.allSettled([left.result, right.result])
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason
    }
    return settled.map(outcome => (outcome as PromiseFulfilledResult<ApprovalRaceResult>).value)
  } finally {
    Atomics.store(view, 0, 1)
    Atomics.notify(view, 0, 2)
    left.worker.terminate()
    right.worker.terminate()
  }
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

test("decision CAS requires pending, exact version, and a future expiry", async () => {
  const file = temporaryDatabasePath()
  seedPendingFile(file, { id: "race", version: 2, expiresAt: 1_000 })
  const results = await runApprovalBarrierRace(file, {
    left: {
      op: "reserve",
      input: decisionInput({ id: "race", expectedVersion: 2, now: 1_000 }),
    },
    right: { op: "expire", id: "race", now: 1_000 },
  })
  const expiryWinners = results.filter(result =>
    (result.kind === "conflict" && result.code === "expired")
    || (result.kind === "expire_result" && result.record !== null)
  )
  expect(expiryWinners).toHaveLength(1)
  const inspect = openHarness(file)
  expect(inspect.repo.getVisible("race")).toMatchObject({
    state: "expired",
    execution: "not_applicable",
    version: 3,
  })
  inspect.db.close()
})

test("only one concurrent different decision wins", async () => {
  const file = temporaryDatabasePath()
  seedPendingFile(file, { id: "decision-race", version: 2, expiresAt: 2_000 })
  const results = await runApprovalBarrierRace(file, {
    left: {
      op: "reserve",
      input: decisionInput({
        id: "decision-race",
        decision: "grant",
        idempotencyKey: "grant-key",
        requestHash: "grant-hash",
        now: 1_000,
      }),
    },
    right: {
      op: "reserve",
      input: decisionInput({
        id: "decision-race",
        decision: "deny",
        idempotencyKey: "deny-key",
        requestHash: "deny-hash",
        now: 1_000,
      }),
    },
  })
  expect(results.filter(result => result.kind === "won")).toHaveLength(1)
  expect(results.filter(result => result.kind === "conflict" && result.code === "already_resolved"))
    .toHaveLength(1)
  const inspect = openHarness(file)
  expect(inspect.repo.getVisible("decision-race")).toMatchObject({ version: 3 })
  expect(inspect.db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM approval_idempotency",
  ).get()?.count).toBe(1)
  inspect.db.close()
})

test("rejected unknown, interrupted, stale, and malformed decisions never bind a key", () => {
  const { db, repo } = harness()
  insertPending(repo, { id: "stale", createdAt: 1, expiresAt: 1_000 })
  const stale = decisionInput({ id: "stale", expectedVersion: 99, idempotencyKey: "stale-key" })
  expect(repo.reserveDecision(stale)).toMatchObject({ kind: "conflict", code: "stale_version" })
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM approval_idempotency WHERE idempotency_key='stale-key'",
  ).get()?.count).toBe(0)
  expect(repo.reserveDecision({ ...stale, expectedVersion: 2 }).kind).toBe("won")

  const unknown = decisionInput({ id: "unknown", idempotencyKey: "unknown-key" })
  expect(repo.reserveDecision(unknown)).toMatchObject({
    kind: "conflict",
    code: "already_resolved",
    record: null,
  })
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM approval_idempotency WHERE idempotency_key='unknown-key'",
  ).get()?.count).toBe(0)
  insertPending(repo, { id: "unknown", createdAt: 1, expiresAt: 1_000 })
  expect(repo.reserveDecision(unknown).kind).toBe("won")

  repo.insertRegistering(record({ id: "interrupted", createdAt: 1, expiresAt: 1_000 }))
  repo.interruptRegistration("interrupted", 5, "registration_interrupted")
  expect(repo.reserveDecision(decisionInput({
    id: "interrupted",
    idempotencyKey: "interrupted-key",
  }))).toMatchObject({ kind: "conflict", code: "interrupted" })
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM approval_idempotency WHERE idempotency_key='interrupted-key'",
  ).get()?.count).toBe(0)

  expectRepositoryError(
    () => repo.reserveDecision(decisionInput({ id: "unknown", idempotencyKey: "" })),
    "invalid_record",
  )
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM approval_idempotency WHERE idempotency_key=''",
  ).get()?.count).toBe(0)
  db.close()
})

test("grant and denial atomically persist their canonical decision bindings", () => {
  const { db, repo } = harness()
  insertPending(repo, { id: "grant", createdAt: 1, expiresAt: 1_000 })
  insertPending(repo, { id: "deny", createdAt: 1, expiresAt: 1_000 })
  const principal: ApprovalPrincipal = { surface: "web", id: "operator" }
  const grant = decisionInput({
    id: "grant",
    principal,
    idempotencyKey: "grant-key",
    requestHash: "grant-hash",
    now: 10,
  })
  expect(repo.reserveDecision(grant)).toMatchObject({
    kind: "won",
    record: {
      id: "grant",
      version: 3,
      state: "granted",
      decisionBy: principal,
      decisionAt: 10,
      decisionKey: "grant-key",
      terminalAt: 10,
      execution: "pending",
      executionStartedAt: 10,
      executionFinishedAt: null,
    },
  })
  expect(repo.reserveDecision(grant)).toEqual({ kind: "in_flight" })
  expect(db.query<{
    approval_id: string
    request_hash: string
    status: string
    result_json: string | null
  }, []>(`
    SELECT approval_id, request_hash, status, result_json
    FROM approval_idempotency
    WHERE principal_surface='web' AND principal_id='operator' AND idempotency_key='grant-key'
  `).get()).toEqual({
    approval_id: "grant",
    request_hash: "grant-hash",
    status: "in_flight",
    result_json: null,
  })

  const deny = decisionInput({
    id: "deny",
    principal,
    decision: "deny",
    idempotencyKey: "deny-key",
    requestHash: "deny-hash",
    now: 11,
  })
  expect(repo.reserveDecision(deny)).toMatchObject({
    kind: "won",
    record: {
      id: "deny",
      version: 3,
      state: "denied",
      decisionBy: principal,
      decisionAt: 11,
      decisionKey: "deny-key",
      terminalAt: 11,
      execution: "not_applicable",
      executionStartedAt: null,
    },
  })
  expect(repo.reserveDecision(deny)).toEqual({
    kind: "replay",
    result: {
      approvalId: "deny",
      version: 3,
      lifecycle: "denied",
      execution: "not_applicable",
      executionDetail: null,
    },
  })
  db.close()
})

test("the same principal key replays only the identical bound request", () => {
  const { db, repo } = pendingHarness()
  const input = decisionInput({ idempotencyKey: "same" })
  expect(repo.reserveDecision(input).kind).toBe("won")
  expect(repo.finalizeGrantExecution(input.principal, "same", 3, {
    outcome: "succeeded",
    detail: { status: 204, attempts: 1 },
    now: 20,
  })).toMatchObject({ state: "granted", execution: "succeeded", version: 4 })
  expect(repo.reserveDecision(input)).toEqual({
    kind: "replay",
    result: {
      approvalId: "approval",
      version: 4,
      lifecycle: "granted",
      execution: "succeeded",
      executionDetail: { status: 204, attempts: 1 },
    },
  })
  expect(repo.reserveDecision({
    ...input,
    decision: "deny",
    expectedVersion: 999,
    requestHash: "different",
  })).toMatchObject({ kind: "conflict", code: "idempotency_conflict" })
  db.close()
})

test("the same key is independent across principal surface and ID", () => {
  const { db, repo } = harness()
  for (const id of ["one", "two", "three"]) {
    insertPending(repo, { id, createdAt: 1, expiresAt: 1_000 })
  }
  expect(repo.reserveDecision(decisionInput({
    id: "one",
    principal: { surface: "web", id: "a" },
    idempotencyKey: "key",
  })).kind).toBe("won")
  expect(repo.reserveDecision(decisionInput({
    id: "two",
    principal: { surface: "web", id: "b" },
    idempotencyKey: "key",
  })).kind).toBe("won")
  expect(repo.reserveDecision(decisionInput({
    id: "three",
    principal: { surface: "discord", id: "a" },
    idempotencyKey: "key",
  })).kind).toBe("won")
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM approval_idempotency WHERE idempotency_key='key'",
  ).get()?.count).toBe(3)
  db.close()
})

test("a completed principal binding survives reopen with only canonical safe fields", () => {
  const file = temporaryDatabasePath()
  const input = decisionInput({
    id: "persisted-decision",
    decision: "deny",
    idempotencyKey: "persistent-key",
    requestHash: "persistent-hash",
  })
  const first = openHarness(file)
  try {
    insertPending(first.repo, {
      id: "persisted-decision",
      createdAt: 1,
      expiresAt: 1_000,
      originConversationId: "caller-private-conversation",
    })
    expect(first.repo.reserveDecision(input).kind).toBe("won")
  } finally {
    first.db.close()
  }

  const second = openHarness(file)
  try {
    const replay = second.repo.reserveDecision(input)
    expect(replay).toEqual({
      kind: "replay",
      result: {
        approvalId: "persisted-decision",
        version: 3,
        lifecycle: "denied",
        execution: "not_applicable",
        executionDetail: null,
      },
    })
    expect(JSON.stringify(replay)).not.toContain("conversation")
    expect(JSON.stringify(replay)).not.toContain("permissions")
    expect(JSON.stringify(replay)).not.toContain("effectFingerprint")
  } finally {
    second.db.close()
  }
})

test("grant finalization requires the exact version and matching in-flight binding", () => {
  const { db, repo } = pendingHarness()
  const input = decisionInput({ idempotencyKey: "finalize-key" })
  expect(repo.reserveDecision(input)).toMatchObject({ kind: "won", record: { version: 3 } })
  expect(repo.finalizeGrantExecution(input.principal, "finalize-key", 2, {
    outcome: "succeeded",
    detail: { status: 204 },
    now: 20,
  })).toBeNull()
  expect(repo.getVisible("approval")).toMatchObject({ version: 3, execution: "pending" })

  expect(repo.finalizeGrantExecution({ surface: "web", id: "other" }, "finalize-key", 3, {
    outcome: "succeeded",
    detail: { status: 204 },
    now: 20,
  })).toBeNull()
  expect(repo.getVisible("approval")).toMatchObject({ version: 3, execution: "pending" })
  expect(db.query<{ status: string }, []>(
    "SELECT status FROM approval_idempotency WHERE idempotency_key='finalize-key'",
  ).get()?.status).toBe("in_flight")

  expect(repo.finalizeGrantExecution(input.principal, "finalize-key", 3, {
    outcome: "failed",
    detail: { status: 503, failureCode: "http_error" },
    now: 21,
  })).toMatchObject({
    version: 4,
    state: "granted",
    execution: "failed",
    executionDetail: { status: 503, failureCode: "http_error" },
    executionFinishedAt: 21,
  })
  expect(repo.finalizeGrantExecution(input.principal, "finalize-key", 3, {
    outcome: "succeeded",
    detail: null,
    now: 22,
  })).toBeNull()
  db.close()
})

test("grant finalization can record a non-replayable interrupted execution", () => {
  const { db, repo } = pendingHarness()
  const input = decisionInput({ idempotencyKey: "interrupted-execution-key" })
  expect(repo.reserveDecision(input).kind).toBe("won")
  expect(repo.finalizeGrantExecution(input.principal, input.idempotencyKey, 3, {
    outcome: "interrupted",
    detail: null,
    now: 30,
  })).toMatchObject({
    state: "granted",
    execution: "interrupted",
    outcomeReason: "execution_outcome_unknown",
    version: 4,
    executionFinishedAt: 30,
  })
  expect(repo.reserveDecision(input)).toMatchObject({
    kind: "replay",
    result: { lifecycle: "granted", execution: "interrupted", version: 4 },
  })
  db.close()
})

test("stored replay results use an exact canonical decoder", () => {
  const { db, repo } = pendingHarness()
  const input = decisionInput({ decision: "deny", idempotencyKey: "decode-key" })
  expect(repo.reserveDecision(input).kind).toBe("won")
  const stored = db.query<{ result_json: string }, []>(
    "SELECT result_json FROM approval_idempotency WHERE idempotency_key='decode-key'",
  ).get()
  expect(stored).not.toBeNull()
  expect(Object.keys(JSON.parse(stored!.result_json)).sort()).toEqual([
    "approvalId", "execution", "executionDetail", "lifecycle", "version",
  ])

  const corruptResults = [
    '{"approvalId":"approval","version":"3","lifecycle":"denied","execution":"not_applicable","executionDetail":null}',
    '{"approvalId":"approval","version":3,"lifecycle":"denied","execution":"not_applicable"}',
    '{"approvalId":"approval","version":3,"lifecycle":"denied","execution":"succeeded","executionDetail":null}',
    '{"approvalId":"approval","version":3,"lifecycle":"denied","execution":"not_applicable","executionDetail":null,"permissions":{"canDecide":true}}',
  ]
  for (const resultJson of corruptResults) {
    db.query("UPDATE approval_idempotency SET result_json=? WHERE idempotency_key='decode-key'")
      .run(resultJson)
    expectRepositoryError(() => repo.reserveDecision(input), "corrupt_record")
  }
  db.close()
})

test("expireDue drains a deterministic bounded set of exact CAS winners", () => {
  const { db, repo } = harness()
  for (const [id, expiresAt] of [
    ["z-first", 50],
    ["a-tie", 75],
    ["b-tie", 75],
    ["future", 101],
  ] as const) {
    insertPending(repo, { id, createdAt: 1, expiresAt })
  }
  expect(repo.expireDue(100, 2).map(item => item.id)).toEqual(["z-first", "a-tie"])
  expect(repo.expireDue(100, 2).map(item => item.id)).toEqual(["b-tie"])
  expect(repo.expireDue(100, 2)).toEqual([])
  expect(repo.getVisible("future")).toMatchObject({ state: "pending", version: 2 })
  for (const id of ["z-first", "a-tie", "b-tie"]) {
    expect(repo.getVisible(id)).toMatchObject({ state: "expired", version: 3, terminalAt: 100 })
  }
  expectRepositoryError(() => repo.expireDue(100, 0), "invalid_filter")
  expectRepositoryError(() => repo.expireDue(100, 101), "invalid_filter")
  db.close()
})

test("startup reconciliation interrupts only abandoned lifecycle and execution work", () => {
  const { db, repo } = harness()
  repo.insertRegistering(record({ id: "registering", createdAt: 1, expiresAt: 1_000 }))
  insertPending(repo, { id: "pending", createdAt: 1, expiresAt: 1_000 })
  insertPending(repo, { id: "grant-running", createdAt: 1, expiresAt: 1_000 })
  const runningInput = decisionInput({
    id: "grant-running",
    idempotencyKey: "running-key",
    requestHash: "running-hash",
  })
  expect(repo.reserveDecision(runningInput).kind).toBe("won")

  insertPending(repo, { id: "denied", createdAt: 1, expiresAt: 1_000 })
  expect(repo.reserveDecision(decisionInput({
    id: "denied",
    decision: "deny",
    idempotencyKey: "denied-key",
    requestHash: "denied-hash",
  })).kind).toBe("won")
  insertExpired(repo, { id: "expired", createdAt: 1, expiresAt: 30 }, 30)
  insertPending(repo, { id: "grant-complete", createdAt: 1, expiresAt: 1_000 })
  const completeInput = decisionInput({
    id: "grant-complete",
    idempotencyKey: "complete-key",
    requestHash: "complete-hash",
  })
  expect(repo.reserveDecision(completeInput).kind).toBe("won")
  expect(repo.finalizeGrantExecution(completeInput.principal, completeInput.idempotencyKey, 3, {
    outcome: "succeeded",
    detail: { status: 204 },
    now: 20,
  })).not.toBeNull()
  repo.insertRegistering(record({ id: "already-interrupted", createdAt: 1, expiresAt: 1_000 }))
  repo.interruptRegistration("already-interrupted", 25, "registration_interrupted")

  for (const [id, adapter] of [
    ["registering", "discord"],
    ["pending", "slack"],
    ["grant-running", "discord"],
    ["denied", "discord"],
  ] as const) {
    repo.putNotification(id, adapter, `reference-${id}`, 40)
  }
  const terminalBefore = new Map(
    ["denied", "expired", "grant-complete", "already-interrupted"]
      .map(id => [id, repo.getVisible(id)] as const),
  )

  const reconciled = repo.reconcileStartup(50)
  expect(reconciled.lifecycleInterrupted.map(item => item.id)).toEqual(["pending", "registering"])
  expect(reconciled.executionInterrupted.map(item => item.id)).toEqual(["grant-running"])
  expect(reconciled.notifications).toEqual([
    { approvalId: "grant-running", adapter: "discord", reference: "reference-grant-running" },
    { approvalId: "pending", adapter: "slack", reference: "reference-pending" },
    { approvalId: "registering", adapter: "discord", reference: "reference-registering" },
  ])
  expect(repo.getVisible("registering")).toMatchObject({
    state: "interrupted",
    execution: "not_applicable",
    version: 2,
    terminalAt: 50,
    outcomeReason: "registration_interrupted",
  })
  expect(repo.getVisible("pending")).toMatchObject({
    state: "interrupted",
    execution: "not_applicable",
    version: 3,
    terminalAt: 50,
    outcomeReason: "restart_interrupted",
  })
  expect(repo.getVisible("grant-running")).toMatchObject({
    state: "granted",
    execution: "interrupted",
    version: 4,
    executionFinishedAt: 50,
    outcomeReason: "execution_outcome_unknown",
  })
  expect(repo.reserveDecision(runningInput)).toEqual({
    kind: "replay",
    result: {
      approvalId: "grant-running",
      version: 4,
      lifecycle: "granted",
      execution: "interrupted",
      executionDetail: null,
    },
  })
  for (const [id, before] of terminalBefore) expect(repo.getVisible(id)).toEqual(before)
  expect(repo.listNotifications()).toEqual([
    { approvalId: "denied", adapter: "discord", reference: "reference-denied" },
    { approvalId: "grant-running", adapter: "discord", reference: "reference-grant-running" },
    { approvalId: "pending", adapter: "slack", reference: "reference-pending" },
    { approvalId: "registering", adapter: "discord", reference: "reference-registering" },
  ])
  expect(repo.reconcileStartup(60)).toEqual({
    lifecycleInterrupted: [],
    executionInterrupted: [],
    notifications: [],
  })
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
