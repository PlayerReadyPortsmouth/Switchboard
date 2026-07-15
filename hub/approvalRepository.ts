import { Database, SQLiteError, type SQLQueryBindings } from "bun:sqlite"
import type {
  ApprovalDecision,
  ApprovalExecutionOutcome,
  ApprovalLifecycleState,
  ApprovalListQuery,
  ApprovalPendingAggregate,
  ApprovalPrincipal,
  ApprovalRecord,
  ApprovalRisk,
  ApprovalStorageState,
  SafeValue,
} from "./approvalTypes"

export type ApprovalRepositoryErrorCode =
  | "corrupt_record"
  | "invalid_cursor"
  | "invalid_filter"
  | "invalid_record"

export class ApprovalRepositoryError extends Error {
  readonly name = "ApprovalRepositoryError"

  constructor(
    public readonly code: ApprovalRepositoryErrorCode,
    options?: { cause?: unknown },
  ) {
    super(code, options)
  }
}

export interface ApprovalDecisionReservationInput {
  approvalId: string
  principal: ApprovalPrincipal
  decision: ApprovalDecision
  expectedVersion: number
  idempotencyKey: string
  requestHash: string
  now: number
}

export interface ApprovalStoredDecisionResult {
  approvalId: string
  version: number
  lifecycle: ApprovalLifecycleState
  execution: ApprovalExecutionOutcome
  executionDetail: SafeValue | null
}

export type ApprovalDecisionReservation =
  | { kind: "won"; record: ApprovalRecord }
  | { kind: "replay"; result: ApprovalStoredDecisionResult }
  | { kind: "in_flight" }
  | {
    kind: "conflict"
    code: "idempotency_conflict" | "stale_version" | "already_resolved" | "expired" | "interrupted"
    record: ApprovalRecord | null
  }

export interface ApprovalGrantExecutionFinalization {
  outcome: "succeeded" | "failed" | "interrupted"
  detail?: unknown
  now: number
}

export interface ApprovalReconciliation {
  lifecycleInterrupted: ApprovalRecord[]
  executionInterrupted: ApprovalRecord[]
  notifications: Array<{ approvalId: string; adapter: string; reference: string }>
}

export interface ApprovalHistoryRepository {
  insertRegistering(record: ApprovalRecord): { kind: "inserted" } | { kind: "id_collision" }
  activate(id: string, expectedVersion: number): ApprovalRecord | null
  interruptRegistration(id: string, now: number, reason: string): ApprovalRecord | null
  reserveDecision(input: ApprovalDecisionReservationInput): ApprovalDecisionReservation
  finalizeGrantExecution(
    principal: ApprovalPrincipal,
    idempotencyKey: string,
    expectedVersion: number,
    result: ApprovalGrantExecutionFinalization,
  ): ApprovalRecord | null
  expire(id: string, now: number): ApprovalRecord | null
  expireDue(now: number, limit: number): ApprovalRecord[]
  reconcileStartup(now: number): ApprovalReconciliation
  getVisible(id: string): ApprovalRecord | null
  list(query: ApprovalListQuery): { items: ApprovalRecord[]; nextCursor: string | null }
  summarizePending(query: Omit<ApprovalListQuery, "group" | "cursor" | "limit">): ApprovalPendingAggregate
  pendingCount(): number
  putNotification(approvalId: string, adapter: string, reference: string, now: number): void
  listNotifications(approvalId?: string): Array<{ approvalId: string; adapter: string; reference: string }>
  listPendingMissingNotification(adapter: string, afterId: string | null, limit: number): ApprovalRecord[]
}

type PendingCursor = {
  v: 1
  group: "pending"
  riskRank: number
  expiresAt: number
  createdAt: number
  id: string
}

type HistoryCursor = {
  v: 1
  group: "history"
  terminalAt: number
  id: string
}

interface ApprovalRow {
  id: unknown
  version: unknown
  kind: unknown
  target: unknown
  summary: unknown
  detail_json: unknown
  requested_surface: unknown
  requested_id: unknown
  origin_conversation_id: unknown
  risk: unknown
  effect_fingerprint: unknown
  created_at: unknown
  expires_at: unknown
  terminal_at: unknown
  state: unknown
  decision_surface: unknown
  decision_id: unknown
  decision_at: unknown
  decision_key: unknown
  outcome_reason: unknown
  execution_outcome: unknown
  execution_detail_json: unknown
  execution_started_at: unknown
  execution_finished_at: unknown
  correlation_id: unknown
}

interface AggregateRow {
  count: unknown
  highest_risk: unknown
  nearest_expiry: unknown
  first_id: unknown
}

interface NotificationRow {
  approval_id: unknown
  adapter: unknown
  reference: unknown
}

interface IdempotencyRow {
  approval_id: unknown
  request_hash: unknown
  status: unknown
  result_json: unknown
  created_at: unknown
  completed_at: unknown
}

interface ReconciliationCandidateRow {
  id: unknown
  state: unknown
}

interface NormalizedFilters {
  group: "pending" | "history"
  search?: string
  risk?: ApprovalRisk
  kind?: string
  requester?: { surface: string; id: string }
  state?: ApprovalLifecycleState
  conversationId?: string
  createdFrom?: number
  createdTo?: number
  decisionFrom?: number
  decisionTo?: number
  cursor?: string
  limit: number
}

const APPROVAL_COLUMNS = `
  r.id AS id,
  r.version AS version,
  r.kind AS kind,
  r.target AS target,
  r.summary AS summary,
  r.detail_json AS detail_json,
  r.requested_surface AS requested_surface,
  r.requested_id AS requested_id,
  r.origin_conversation_id AS origin_conversation_id,
  r.risk AS risk,
  r.effect_fingerprint AS effect_fingerprint,
  r.created_at AS created_at,
  r.expires_at AS expires_at,
  r.terminal_at AS terminal_at,
  r.state AS state,
  r.decision_surface AS decision_surface,
  r.decision_id AS decision_id,
  r.decision_at AS decision_at,
  r.decision_key AS decision_key,
  r.outcome_reason AS outcome_reason,
  r.execution_outcome AS execution_outcome,
  r.execution_detail_json AS execution_detail_json,
  r.execution_started_at AS execution_started_at,
  r.execution_finished_at AS execution_finished_at,
  r.correlation_id AS correlation_id
`

const RISK_RANK_SQL = `CASE r.risk
  WHEN 'destructive' THEN 3
  WHEN 'elevated' THEN 2
  WHEN 'low' THEN 1
  ELSE 0
END`

const RISK_VALUES = new Set<ApprovalRisk>(["low", "elevated", "destructive"])
const STORAGE_STATES = new Set<ApprovalStorageState>([
  "registering", "pending", "granted", "denied", "expired", "interrupted",
])
const LIFECYCLE_STATES = new Set<ApprovalLifecycleState>([
  "pending", "granted", "denied", "expired", "interrupted",
])
const EXECUTION_OUTCOMES = new Set<ApprovalExecutionOutcome>([
  "not_applicable", "pending", "succeeded", "failed", "interrupted",
])
const TERMINAL_STATES = new Set<ApprovalStorageState>([
  "granted", "denied", "expired", "interrupted",
])
const REQUESTER_SURFACE = /^[a-z0-9_-]+$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const MAX_SAFE_JSON_BYTES = 1_048_576
const MAX_SAFE_VALUE_DEPTH = 32
const MAX_SAFE_COLLECTION_ITEMS = 1_000
const MAX_SAFE_VALUE_NODES = 10_000
const MAX_APPROVAL_ID_BYTES = 4_096
const MAX_CURSOR_BYTES = Math.ceil(((MAX_APPROVAL_ID_BYTES * 6) + 512) * 4 / 3)
const MAX_FILTER_BYTES = 4_096
const MAX_EXPIRY_BATCH = 100
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"])
const STORED_RESULT_KEYS = new Set([
  "approvalId", "version", "lifecycle", "execution", "executionDetail",
])
const DECISION_INPUT_KEYS = new Set([
  "approvalId", "principal", "decision", "expectedVersion", "idempotencyKey", "requestHash", "now",
])
const PRINCIPAL_KEYS = new Set(["surface", "id"])
const FINALIZATION_KEYS = new Set(["outcome", "detail", "now"])
const FINALIZATION_BINDING_MISS = Object.freeze({ kind: "finalization_binding_miss" })
const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder("utf-8", { fatal: true })

function repositoryError(code: ApprovalRepositoryErrorCode, cause?: unknown): ApprovalRepositoryError {
  return new ApprovalRepositoryError(code, cause === undefined ? undefined : { cause })
}

function corrupt(cause?: unknown): never {
  throw repositoryError("corrupt_record", cause)
}

function invalidFilter(): never {
  throw repositoryError("invalid_filter")
}

function invalidRecord(): never {
  throw repositoryError("invalid_record")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function safeValueClone(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): SafeValue {
  budget.remaining -= 1
  if (budget.remaining < 0 || depth > MAX_SAFE_VALUE_DEPTH) corrupt()
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) corrupt()
    return value
  }
  if (Array.isArray(value)) {
    let prototype: object | null
    let keys: Array<string | symbol>
    try {
      prototype = Object.getPrototypeOf(value)
      keys = Reflect.ownKeys(value)
    } catch (error) {
      corrupt(error)
    }
    if (prototype !== Array.prototype || value.length > MAX_SAFE_COLLECTION_ITEMS) corrupt()
    if (keys!.length !== value.length + 1 || !keys!.includes("length")) corrupt()
    const result: SafeValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      } catch (error) {
        corrupt(error)
      }
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) corrupt()
      result.push(safeValueClone(descriptor.value, depth + 1, budget))
    }
    return result
  }
  if (!isPlainObject(value)) corrupt()
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
  } catch (error) {
    corrupt(error)
  }
  if (keys.length > MAX_SAFE_COLLECTION_ITEMS) corrupt()
  const result: { [key: string]: SafeValue } = Object.create(null) as { [key: string]: SafeValue }
  for (const key of keys) {
    if (typeof key !== "string" || PROTOTYPE_KEYS.has(key)) corrupt()
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch (error) {
      corrupt(error)
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) corrupt()
    result[key] = safeValueClone(descriptor.value, depth + 1, budget)
  }
  return result
}

function validateSafeValue(value: unknown): SafeValue {
  return safeValueClone(value, 0, { remaining: MAX_SAFE_VALUE_NODES })
}

function decodeSafeJson(value: unknown): SafeValue {
  if (typeof value !== "string" || encoder.encode(value).byteLength > MAX_SAFE_JSON_BYTES) corrupt()
  try {
    return validateSafeValue(JSON.parse(value))
  } catch (error) {
    if (error instanceof ApprovalRepositoryError && error.code === "corrupt_record") throw error
    corrupt(error)
  }
}

function encodeSafeJson(value: unknown): string {
  const safe = validateSafeValue(value)
  let encoded: string
  try {
    encoded = JSON.stringify(safe)
  } catch (error) {
    corrupt(error)
  }
  if (encoder.encode(encoded!).byteLength > MAX_SAFE_JSON_BYTES) corrupt()
  return encoded!
}

function rowString(value: unknown, nonEmpty = false, maxBytes?: number): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)
    || (maxBytes !== undefined && encoder.encode(value as string).byteLength > maxBytes)) {
    corrupt()
  }
  return value
}

function rowNullableString(value: unknown, nonEmpty = false, maxBytes?: number): string | null {
  return value === null ? null : rowString(value, nonEmpty, maxBytes)
}

function rowInteger(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive && (value as number) <= 0)) corrupt()
  return value as number
}

function rowNullableInteger(value: unknown): number | null {
  return value === null ? null : rowInteger(value)
}

function rowRisk(value: unknown): ApprovalRisk {
  if (typeof value !== "string" || !RISK_VALUES.has(value as ApprovalRisk)) corrupt()
  return value as ApprovalRisk
}

function rowState(value: unknown): ApprovalStorageState {
  if (typeof value !== "string" || !STORAGE_STATES.has(value as ApprovalStorageState)) corrupt()
  return value as ApprovalStorageState
}

function rowExecution(value: unknown): ApprovalExecutionOutcome {
  if (typeof value !== "string" || !EXECUTION_OUTCOMES.has(value as ApprovalExecutionOutcome)) corrupt()
  return value as ApprovalExecutionOutcome
}

function validStateExecution(state: ApprovalStorageState, execution: ApprovalExecutionOutcome): boolean {
  return state === "granted"
    ? execution === "pending" || execution === "succeeded" || execution === "failed" || execution === "interrupted"
    : execution === "not_applicable"
}

function storedResultFromRecord(record: ApprovalRecord): ApprovalStoredDecisionResult {
  if (!LIFECYCLE_STATES.has(record.state as ApprovalLifecycleState) || record.execution === "pending") corrupt()
  return {
    approvalId: record.id,
    version: record.version,
    lifecycle: record.state as ApprovalLifecycleState,
    execution: record.execution,
    executionDetail: record.executionDetail,
  }
}

function encodeStoredDecisionResult(record: ApprovalRecord): string {
  return encodeSafeJson(storedResultFromRecord(record))
}

function decodeStoredDecisionResult(
  value: unknown,
  boundApprovalId: string,
): ApprovalStoredDecisionResult {
  const decoded = decodeSafeJson(value)
  if (!isPlainObject(decoded)) corrupt()
  const keys = Reflect.ownKeys(decoded)
  if (keys.length !== STORED_RESULT_KEYS.size
    || keys.some(key => typeof key !== "string" || !STORED_RESULT_KEYS.has(key))) {
    corrupt()
  }
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of STORED_RESULT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(decoded, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) corrupt()
    data[key] = descriptor.value
  }
  const approvalId = rowString(data.approvalId, true, MAX_APPROVAL_ID_BYTES)
  const version = rowInteger(data.version, true)
  const lifecycleValue = data.lifecycle
  if (typeof lifecycleValue !== "string"
    || !LIFECYCLE_STATES.has(lifecycleValue as ApprovalLifecycleState)) {
    corrupt()
  }
  const lifecycle = lifecycleValue as ApprovalLifecycleState
  const execution = rowExecution(data.execution)
  const executionDetail = data.executionDetail as SafeValue
  const validCompletedPair = lifecycle === "granted"
    ? execution === "succeeded" || execution === "failed" || execution === "interrupted"
    : lifecycle === "denied" && execution === "not_applicable"
  if (!validCompletedPair || (execution === "not_applicable" && executionDetail !== null)
    || approvalId !== boundApprovalId) {
    corrupt()
  }
  return { approvalId, version, lifecycle, execution, executionDetail }
}

function decodeApprovalRow(row: ApprovalRow): ApprovalRecord {
  const version = rowInteger(row.version, true)
  const createdAt = rowInteger(row.created_at)
  const expiresAt = rowInteger(row.expires_at)
  const terminalAt = rowNullableInteger(row.terminal_at)
  const state = rowState(row.state)
  const execution = rowExecution(row.execution_outcome)
  if (expiresAt < createdAt || !validStateExecution(state, execution)) corrupt()
  if (TERMINAL_STATES.has(state) ? terminalAt === null : terminalAt !== null) corrupt()

  const decisionSurface = rowNullableString(row.decision_surface, true)
  const decisionId = rowNullableString(row.decision_id, true)
  const decisionAt = rowNullableInteger(row.decision_at)
  const decisionKey = rowNullableString(row.decision_key, true)
  const hasNoDecision = decisionSurface === null && decisionId === null && decisionAt === null && decisionKey === null
  const hasCompleteDecision = decisionSurface !== null && decisionId !== null && decisionAt !== null && decisionKey !== null
  if (!hasNoDecision && !hasCompleteDecision) corrupt()

  const executionStartedAt = rowNullableInteger(row.execution_started_at)
  const executionFinishedAt = rowNullableInteger(row.execution_finished_at)
  if (executionFinishedAt !== null && executionStartedAt === null) corrupt()
  const executionJson = row.execution_detail_json
  const executionDetail = executionJson === null ? null : decodeSafeJson(executionJson)

  return {
    id: rowString(row.id, true, MAX_APPROVAL_ID_BYTES),
    version,
    kind: rowString(row.kind, true),
    target: rowString(row.target, true),
    summary: rowString(row.summary, true),
    detail: decodeSafeJson(row.detail_json),
    requestedBy: {
      surface: rowString(row.requested_surface, true),
      id: rowString(row.requested_id, true),
    },
    originConversationId: rowNullableString(row.origin_conversation_id, true),
    risk: rowRisk(row.risk),
    effectFingerprint: rowString(row.effect_fingerprint, true),
    createdAt,
    expiresAt,
    terminalAt,
    state,
    decisionBy: hasCompleteDecision ? { surface: decisionSurface, id: decisionId } : null,
    decisionAt,
    decisionKey,
    outcomeReason: rowNullableString(row.outcome_reason, true),
    execution,
    executionDetail,
    executionStartedAt,
    executionFinishedAt,
    correlationId: rowString(row.correlation_id, true),
  }
}

function queryRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainObject(value)) invalidFilter()
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    invalidFilter()
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) invalidFilter()
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      invalidFilter()
    }
    if (!descriptor || !("value" in descriptor)) invalidFilter()
    result[key] = descriptor.value
  }
  return result
}

function optionalFilterString(
  value: unknown,
  options: { nonEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") invalidFilter()
  if (options.nonEmpty !== false && value.length === 0) invalidFilter()
  if (encoder.encode(value).byteLength > MAX_FILTER_BYTES) invalidFilter()
  return value
}

function optionalFilterInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) invalidFilter()
  return value as number
}

function optionalCursorString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_BYTES) {
    throw repositoryError("invalid_cursor")
  }
  return value
}

const FILTER_KEYS = new Set([
  "search", "risk", "kind", "requester", "state", "conversationId",
  "createdFrom", "createdTo", "decisionFrom", "decisionTo",
])
const LIST_QUERY_KEYS = new Set([...FILTER_KEYS, "group", "cursor", "limit"])

function normalizeFilters(value: unknown, aggregate: boolean): NormalizedFilters {
  const raw = queryRecord(value, aggregate ? FILTER_KEYS : LIST_QUERY_KEYS)
  const groupValue = aggregate ? "pending" : raw.group
  if (groupValue !== "pending" && groupValue !== "history") invalidFilter()
  const group = groupValue

  const search = optionalFilterString(raw.search)
  const riskValue = raw.risk
  if (riskValue !== undefined && (typeof riskValue !== "string" || !RISK_VALUES.has(riskValue as ApprovalRisk))) {
    invalidFilter()
  }
  const risk = riskValue as ApprovalRisk | undefined
  const kind = optionalFilterString(raw.kind)
  const requesterValue = optionalFilterString(raw.requester)
  let requester: { surface: string; id: string } | undefined
  if (requesterValue !== undefined) {
    const separator = requesterValue.indexOf(":")
    if (separator <= 0 || separator === requesterValue.length - 1) invalidFilter()
    const surface = requesterValue.slice(0, separator)
    const id = requesterValue.slice(separator + 1)
    if (!REQUESTER_SURFACE.test(surface)) invalidFilter()
    requester = { surface, id }
  }

  const stateValue = raw.state
  if (stateValue !== undefined
    && (typeof stateValue !== "string" || !LIFECYCLE_STATES.has(stateValue as ApprovalLifecycleState))) {
    invalidFilter()
  }
  const state = stateValue as ApprovalLifecycleState | undefined
  if (state !== undefined) {
    if (group === "pending" && state !== "pending") invalidFilter()
    if (group === "history" && state === "pending") invalidFilter()
  }

  const conversationId = optionalFilterString(raw.conversationId)
  const createdFrom = optionalFilterInteger(raw.createdFrom)
  const createdTo = optionalFilterInteger(raw.createdTo)
  const decisionFrom = optionalFilterInteger(raw.decisionFrom)
  const decisionTo = optionalFilterInteger(raw.decisionTo)
  if (createdFrom !== undefined && createdTo !== undefined && createdFrom > createdTo) invalidFilter()
  if (decisionFrom !== undefined && decisionTo !== undefined && decisionFrom > decisionTo) invalidFilter()

  let cursor: string | undefined
  let limit = 50
  if (!aggregate) {
    cursor = optionalCursorString(raw.cursor)
    if (raw.limit !== undefined) {
      if (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 100) {
        invalidFilter()
      }
      limit = raw.limit as number
    }
  }

  return {
    group,
    search,
    risk,
    kind,
    requester,
    state,
    conversationId,
    createdFrom,
    createdTo,
    decisionFrom,
    decisionTo,
    cursor,
    limit,
  }
}

function cursorObject(value: unknown, exactKeys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw repositoryError("invalid_cursor")
  const keys = Reflect.ownKeys(value)
  if (keys.length !== exactKeys.length
    || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))) {
    throw repositoryError("invalid_cursor")
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of exactKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) throw repositoryError("invalid_cursor")
    result[key] = descriptor.value
  }
  return result
}

function cursorInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw repositoryError("invalid_cursor")
  return value as number
}

function decodeCursor(value: string, group: "pending"): PendingCursor
function decodeCursor(value: string, group: "history"): HistoryCursor
function decodeCursor(value: string, group: "pending" | "history"): PendingCursor | HistoryCursor {
  try {
    if (value.length === 0 || value.length > MAX_CURSOR_BYTES || value.length % 4 === 1 || !BASE64URL.test(value)) {
      throw repositoryError("invalid_cursor")
    }
    const bytes = Buffer.from(value, "base64url")
    if (bytes.toString("base64url") !== value) throw repositoryError("invalid_cursor")
    const parsed = JSON.parse(fatalDecoder.decode(bytes))
    if (group === "pending") {
      const raw = cursorObject(parsed, ["v", "group", "riskRank", "expiresAt", "createdAt", "id"])
      const riskRank = cursorInteger(raw.riskRank)
      const id = raw.id
      if (raw.v !== 1 || raw.group !== "pending" || riskRank < 1 || riskRank > 3
        || typeof id !== "string" || id.length === 0 || encoder.encode(id).byteLength > MAX_APPROVAL_ID_BYTES) {
        throw repositoryError("invalid_cursor")
      }
      return {
        v: 1,
        group: "pending",
        riskRank,
        expiresAt: cursorInteger(raw.expiresAt),
        createdAt: cursorInteger(raw.createdAt),
        id,
      }
    }
    const raw = cursorObject(parsed, ["v", "group", "terminalAt", "id"])
    const id = raw.id
    if (raw.v !== 1 || raw.group !== "history"
      || typeof id !== "string" || id.length === 0 || encoder.encode(id).byteLength > MAX_APPROVAL_ID_BYTES) {
      throw repositoryError("invalid_cursor")
    }
    return {
      v: 1,
      group: "history",
      terminalAt: cursorInteger(raw.terminalAt),
      id,
    }
  } catch (error) {
    if (error instanceof ApprovalRepositoryError && error.code === "invalid_cursor") throw error
    throw repositoryError("invalid_cursor", error)
  }
}

function encodeCursor(cursor: PendingCursor | HistoryCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
  if (encoded.length > MAX_CURSOR_BYTES) corrupt()
  return encoded
}

function riskRank(risk: ApprovalRisk): number {
  if (risk === "destructive") return 3
  if (risk === "elevated") return 2
  return 1
}

function buildWhere(filters: NormalizedFilters): { sql: string; params: SQLQueryBindings[] } {
  const clauses = ["r.state <> 'registering'"]
  const params: SQLQueryBindings[] = []
  if (filters.group === "pending") {
    clauses.push("r.state = 'pending'")
  } else {
    clauses.push("r.state IN ('granted','denied','expired','interrupted')")
  }
  if (filters.search !== undefined) {
    clauses.push("instr(lower(r.summary || ' ' || r.target), lower(?)) > 0")
    params.push(filters.search)
  }
  if (filters.risk !== undefined) {
    clauses.push("r.risk = ?")
    params.push(filters.risk)
  }
  if (filters.kind !== undefined) {
    clauses.push("r.kind = ?")
    params.push(filters.kind)
  }
  if (filters.requester !== undefined) {
    clauses.push("r.requested_surface = ?", "r.requested_id = ?")
    params.push(filters.requester.surface, filters.requester.id)
  }
  if (filters.state !== undefined) {
    clauses.push("r.state = ?")
    params.push(filters.state)
  }
  if (filters.conversationId !== undefined) {
    clauses.push("r.origin_conversation_id = ?")
    params.push(filters.conversationId)
  }
  if (filters.createdFrom !== undefined) {
    clauses.push("r.created_at >= ?")
    params.push(filters.createdFrom)
  }
  if (filters.createdTo !== undefined) {
    clauses.push("r.created_at <= ?")
    params.push(filters.createdTo)
  }
  if (filters.decisionFrom !== undefined) {
    clauses.push("r.decision_at >= ?")
    params.push(filters.decisionFrom)
  }
  if (filters.decisionTo !== undefined) {
    clauses.push("r.decision_at <= ?")
    params.push(filters.decisionTo)
  }
  return { sql: clauses.join(" AND "), params }
}

function requireInputString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > MAX_FILTER_BYTES) {
    invalidRecord()
  }
  return value
}

function requireInputInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) invalidRecord()
  return value as number
}

function inputDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainObject(value)) invalidRecord()
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    invalidRecord()
  }
  if (keys!.some(key => typeof key !== "string" || !allowedKeys.has(key))) invalidRecord()
  for (const key of requiredKeys) {
    if (!keys!.includes(key)) invalidRecord()
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys!) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      invalidRecord()
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalidRecord()
    result[key as string] = descriptor.value
  }
  return result
}

function normalizePrincipal(value: unknown): ApprovalPrincipal {
  const raw = inputDataRecord(value, PRINCIPAL_KEYS, PRINCIPAL_KEYS)
  return {
    surface: requireInputString(raw.surface),
    id: requireInputString(raw.id),
  }
}

function normalizeDecisionReservationInput(
  value: ApprovalDecisionReservationInput,
): ApprovalDecisionReservationInput {
  const raw = inputDataRecord(value, DECISION_INPUT_KEYS, DECISION_INPUT_KEYS)
  if (raw.decision !== "grant" && raw.decision !== "deny") invalidRecord()
  const expectedVersion = requireInputInteger(raw.expectedVersion)
  if (expectedVersion <= 0) invalidRecord()
  return {
    approvalId: requireInputString(raw.approvalId),
    principal: normalizePrincipal(raw.principal),
    decision: raw.decision,
    expectedVersion,
    idempotencyKey: requireInputString(raw.idempotencyKey),
    requestHash: requireInputString(raw.requestHash),
    now: requireInputInteger(raw.now),
  }
}

function normalizeGrantExecutionFinalization(
  value: ApprovalGrantExecutionFinalization,
): { outcome: "succeeded" | "failed" | "interrupted"; detailJson: string | null; now: number } {
  const required = new Set(["outcome", "now"])
  const raw = inputDataRecord(value, FINALIZATION_KEYS, required)
  if (raw.outcome !== "succeeded" && raw.outcome !== "failed" && raw.outcome !== "interrupted") {
    invalidRecord()
  }
  const detail = raw.detail === undefined ? null : validateSafeValue(raw.detail)
  return {
    outcome: raw.outcome,
    detailJson: detail === null ? null : encodeSafeJson(detail),
    now: requireInputInteger(raw.now),
  }
}

export class SqliteApprovalHistoryRepository implements ApprovalHistoryRepository {
  constructor(private readonly db: Database) {}

  insertRegistering(record: ApprovalRecord): { kind: "inserted" } | { kind: "id_collision" } {
    if (record.state !== "registering" || record.execution !== "not_applicable") invalidRecord()
    requireInputString(record.id)
    const detailJson = encodeSafeJson(record.detail)
    const executionDetailJson = record.executionDetail === null ? null : encodeSafeJson(record.executionDetail)
    try {
      this.db.query(`
        INSERT INTO approval_records(
          id, version, kind, target, summary, detail_json,
          requested_surface, requested_id, origin_conversation_id, risk,
          effect_fingerprint, created_at, expires_at, terminal_at, state,
          decision_surface, decision_id, decision_at, decision_key, outcome_reason,
          execution_outcome, execution_detail_json, execution_started_at,
          execution_finished_at, correlation_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        record.id,
        record.version,
        record.kind,
        record.target,
        record.summary,
        detailJson,
        record.requestedBy.surface,
        record.requestedBy.id,
        record.originConversationId,
        record.risk,
        record.effectFingerprint,
        record.createdAt,
        record.expiresAt,
        record.terminalAt,
        record.state,
        record.decisionBy?.surface ?? null,
        record.decisionBy?.id ?? null,
        record.decisionAt,
        record.decisionKey,
        record.outcomeReason,
        record.execution,
        executionDetailJson,
        record.executionStartedAt,
        record.executionFinishedAt,
        record.correlationId,
      )
      return { kind: "inserted" }
    } catch (error) {
      if (error instanceof SQLiteError
        && error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
        && error.message.includes("approval_records.id")) {
        return { kind: "id_collision" }
      }
      throw error
    }
  }

  activate(id: string, expectedVersion: number): ApprovalRecord | null {
    requireInputString(id)
    requireInputInteger(expectedVersion)
    return this.db.transaction(() => {
      const result = this.db.query(`
        UPDATE approval_records
        SET state='pending', version=version+1
        WHERE id=? AND state='registering' AND version=?
      `).run(id, expectedVersion)
      return result.changes === 1 ? this.readVisible(id) : null
    }).immediate()
  }

  interruptRegistration(id: string, now: number, reason: string): ApprovalRecord | null {
    requireInputString(id)
    requireInputInteger(now)
    requireInputString(reason)
    return this.db.transaction(() => {
      const result = this.db.query(`
        UPDATE approval_records
        SET state='interrupted', version=version+1, terminal_at=?, outcome_reason=?
        WHERE id=? AND state='registering'
      `).run(now, reason, id)
      return result.changes === 1 ? this.readVisible(id) : null
    }).immediate()
  }

  reserveDecision(rawInput: ApprovalDecisionReservationInput): ApprovalDecisionReservation {
    const input = normalizeDecisionReservationInput(rawInput)
    return this.db.transaction((): ApprovalDecisionReservation => {
      const binding = this.db.query<IdempotencyRow, [string, string, string]>(`
        SELECT
          approval_id, request_hash, status, result_json, created_at, completed_at
        FROM approval_idempotency
        WHERE principal_surface=? AND principal_id=? AND idempotency_key=?
      `).get(input.principal.surface, input.principal.id, input.idempotencyKey)
      if (binding !== null) {
        const boundApprovalId = rowString(binding.approval_id, true, MAX_APPROVAL_ID_BYTES)
        const boundHash = rowString(binding.request_hash, true)
        if (boundHash !== input.requestHash) {
          return {
            kind: "conflict",
            code: "idempotency_conflict",
            record: this.readVisible(boundApprovalId),
          }
        }
        rowInteger(binding.created_at)
        if (binding.status === "in_flight") {
          if (binding.result_json !== null || binding.completed_at !== null) corrupt()
          return { kind: "in_flight" }
        }
        if (binding.status !== "completed" || binding.result_json === null) corrupt()
        rowInteger(binding.completed_at)
        return {
          kind: "replay",
          result: decodeStoredDecisionResult(binding.result_json, boundApprovalId),
        }
      }

      const current = this.readVisible(input.approvalId)
      if (current === null) {
        return { kind: "conflict", code: "already_resolved", record: null }
      }
      if (current.state === "interrupted") {
        return { kind: "conflict", code: "interrupted", record: current }
      }
      if (current.state !== "pending") {
        return { kind: "conflict", code: "already_resolved", record: current }
      }

      const changed = input.decision === "grant"
        ? this.db.query(`
          UPDATE approval_records
          SET
            state='granted',
            version=version+1,
            terminal_at=?,
            decision_surface=?,
            decision_id=?,
            decision_at=?,
            decision_key=?,
            outcome_reason=NULL,
            execution_outcome='pending',
            execution_detail_json=NULL,
            execution_started_at=?,
            execution_finished_at=NULL
          WHERE id=? AND state='pending' AND version=? AND expires_at>?
        `).run(
          input.now,
          input.principal.surface,
          input.principal.id,
          input.now,
          input.idempotencyKey,
          input.now,
          input.approvalId,
          input.expectedVersion,
          input.now,
        )
        : this.db.query(`
          UPDATE approval_records
          SET
            state='denied',
            version=version+1,
            terminal_at=?,
            decision_surface=?,
            decision_id=?,
            decision_at=?,
            decision_key=?,
            outcome_reason='denied',
            execution_outcome='not_applicable',
            execution_detail_json=NULL,
            execution_started_at=NULL,
            execution_finished_at=NULL
          WHERE id=? AND state='pending' AND version=? AND expires_at>?
        `).run(
          input.now,
          input.principal.surface,
          input.principal.id,
          input.now,
          input.idempotencyKey,
          input.approvalId,
          input.expectedVersion,
          input.now,
        )

      if (changed.changes === 1) {
        const decided = this.readVisible(input.approvalId)
        if (decided === null) corrupt()
        const completed = input.decision === "deny"
        const resultJson = completed ? encodeStoredDecisionResult(decided) : null
        this.db.query(`
          INSERT INTO approval_idempotency(
            principal_surface, principal_id, idempotency_key, approval_id,
            request_hash, status, result_json, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.principal.surface,
          input.principal.id,
          input.idempotencyKey,
          input.approvalId,
          input.requestHash,
          completed ? "completed" : "in_flight",
          resultJson,
          input.now,
          completed ? input.now : null,
        )
        return { kind: "won", record: decided }
      }

      let canonical = this.readVisible(input.approvalId)
      if (canonical?.state === "pending" && canonical.expiresAt <= input.now) {
        const expired = this.db.query(`
          UPDATE approval_records
          SET state='expired', version=version+1, terminal_at=?, outcome_reason='expired'
          WHERE id=? AND state='pending' AND expires_at<=?
        `).run(input.now, input.approvalId, input.now)
        if (expired.changes === 1) {
          canonical = this.readVisible(input.approvalId)
          if (canonical === null) corrupt()
          return { kind: "conflict", code: "expired", record: canonical }
        }
        canonical = this.readVisible(input.approvalId)
      }
      if (canonical === null) {
        return { kind: "conflict", code: "already_resolved", record: null }
      }
      if (canonical.state === "interrupted") {
        return { kind: "conflict", code: "interrupted", record: canonical }
      }
      if (canonical.state === "pending") {
        return { kind: "conflict", code: "stale_version", record: canonical }
      }
      return { kind: "conflict", code: "already_resolved", record: canonical }
    }).immediate()
  }

  finalizeGrantExecution(
    rawPrincipal: ApprovalPrincipal,
    idempotencyKey: string,
    expectedVersion: number,
    rawResult: ApprovalGrantExecutionFinalization,
  ): ApprovalRecord | null {
    const principal = normalizePrincipal(rawPrincipal)
    const key = requireInputString(idempotencyKey)
    const version = requireInputInteger(expectedVersion)
    if (version <= 0) invalidRecord()
    const result = normalizeGrantExecutionFinalization(rawResult)
    try {
      return this.db.transaction(() => {
        const changed = this.db.query(`
          UPDATE approval_records
          SET
            version=version+1,
            execution_outcome=?,
            execution_detail_json=?,
            execution_finished_at=?,
            outcome_reason=?
          WHERE id=(
            SELECT approval_id
            FROM approval_idempotency
            WHERE principal_surface=? AND principal_id=? AND idempotency_key=?
          )
            AND state='granted'
            AND execution_outcome='pending'
            AND version=?
        `).run(
          result.outcome,
          result.detailJson,
          result.now,
          result.outcome === "interrupted" ? "execution_outcome_unknown" : null,
          principal.surface,
          principal.id,
          key,
          version,
        )
        if (changed.changes !== 1) return null
        const binding = this.db.query<{ approval_id: unknown }, [string, string, string]>(`
          SELECT approval_id
          FROM approval_idempotency
          WHERE principal_surface=? AND principal_id=? AND idempotency_key=?
        `).get(principal.surface, principal.id, key)
        if (binding === null) throw FINALIZATION_BINDING_MISS
        const approvalId = rowString(binding.approval_id, true, MAX_APPROVAL_ID_BYTES)
        const finalized = this.readVisible(approvalId)
        if (finalized === null) corrupt()
        const completed = this.db.query(`
          UPDATE approval_idempotency
          SET status='completed', result_json=?, completed_at=?
          WHERE principal_surface=? AND principal_id=? AND idempotency_key=?
            AND approval_id=? AND status='in_flight'
        `).run(
          encodeStoredDecisionResult(finalized),
          result.now,
          principal.surface,
          principal.id,
          key,
          approvalId,
        )
        if (completed.changes !== 1) throw FINALIZATION_BINDING_MISS
        return finalized
      }).immediate()
    } catch (error) {
      if (error === FINALIZATION_BINDING_MISS) return null
      throw error
    }
  }

  expire(id: string, now: number): ApprovalRecord | null {
    requireInputString(id)
    requireInputInteger(now)
    return this.db.transaction(() => {
      const result = this.db.query(`
        UPDATE approval_records
        SET state='expired', version=version+1, terminal_at=?, outcome_reason='expired'
        WHERE id=? AND state='pending' AND expires_at<=?
      `).run(now, id, now)
      return result.changes === 1 ? this.readVisible(id) : null
    }).immediate()
  }

  expireDue(now: number, limit: number): ApprovalRecord[] {
    requireInputInteger(now)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPIRY_BATCH) invalidFilter()
    return this.db.transaction(() => {
      const candidates = this.db.query<{ id: unknown }, [number, number]>(`
        SELECT id
        FROM approval_records
        WHERE state='pending' AND expires_at<=?
        ORDER BY expires_at ASC, created_at ASC, id ASC
        LIMIT ?
      `).all(now, limit)
      const expired: ApprovalRecord[] = []
      for (const candidate of candidates) {
        const id = rowString(candidate.id, true, MAX_APPROVAL_ID_BYTES)
        const changed = this.db.query(`
          UPDATE approval_records
          SET state='expired', version=version+1, terminal_at=?, outcome_reason='expired'
          WHERE id=? AND state='pending' AND expires_at<=?
        `).run(now, id, now)
        if (changed.changes !== 1) continue
        const record = this.readVisible(id)
        if (record === null) corrupt()
        expired.push(record)
      }
      return expired
    }).immediate()
  }

  reconcileStartup(now: number): ApprovalReconciliation {
    requireInputInteger(now)
    return this.db.transaction(() => {
      const candidates = this.db.query<ReconciliationCandidateRow, []>(`
        SELECT id, state
        FROM approval_records
        WHERE state IN ('registering','pending')
          OR (state='granted' AND execution_outcome='pending')
        ORDER BY id ASC
      `).all()
      const lifecycleInterrupted: ApprovalRecord[] = []
      const executionInterrupted: ApprovalRecord[] = []
      const affectedIds: string[] = []

      for (const candidate of candidates) {
        const id = rowString(candidate.id, true, MAX_APPROVAL_ID_BYTES)
        const state = rowState(candidate.state)
        if (state === "registering" || state === "pending") {
          const changed = this.db.query(`
            UPDATE approval_records
            SET
              state='interrupted',
              version=version+1,
              terminal_at=?,
              outcome_reason=?
            WHERE id=? AND state=?
          `).run(
            now,
            state === "registering" ? "registration_interrupted" : "restart_interrupted",
            id,
            state,
          )
          if (changed.changes !== 1) corrupt()
          const interrupted = this.readVisible(id)
          if (interrupted === null) corrupt()
          lifecycleInterrupted.push(interrupted)
          affectedIds.push(id)
          continue
        }
        if (state !== "granted") corrupt()
        const changed = this.db.query(`
          UPDATE approval_records
          SET
            version=version+1,
            execution_outcome='interrupted',
            execution_detail_json=NULL,
            execution_finished_at=?,
            outcome_reason='execution_outcome_unknown'
          WHERE id=? AND state='granted' AND execution_outcome='pending'
        `).run(now, id)
        if (changed.changes !== 1) corrupt()
        const interrupted = this.readVisible(id)
        if (interrupted === null) corrupt()
        this.db.query(`
          UPDATE approval_idempotency
          SET status='completed', result_json=?, completed_at=?
          WHERE approval_id=? AND status='in_flight'
        `).run(encodeStoredDecisionResult(interrupted), now, id)
        executionInterrupted.push(interrupted)
        affectedIds.push(id)
      }

      const notifications: ApprovalReconciliation["notifications"] = []
      for (const id of affectedIds) notifications.push(...this.listNotifications(id))
      return { lifecycleInterrupted, executionInterrupted, notifications }
    }).immediate()
  }

  getVisible(id: string): ApprovalRecord | null {
    requireInputString(id)
    return this.readVisible(id)
  }

  list(query: ApprovalListQuery): { items: ApprovalRecord[]; nextCursor: string | null } {
    const filters = normalizeFilters(query, false)
    const where = buildWhere(filters)
    const params = [...where.params]
    let continuation = ""
    let order: string
    if (filters.group === "pending") {
      order = `${RISK_RANK_SQL} DESC, r.expires_at ASC, r.created_at ASC, r.id ASC`
      if (filters.cursor !== undefined) {
        const cursor = decodeCursor(filters.cursor, "pending")
        continuation = `AND (
          ${RISK_RANK_SQL} < ?
          OR (${RISK_RANK_SQL} = ? AND r.expires_at > ?)
          OR (${RISK_RANK_SQL} = ? AND r.expires_at = ? AND r.created_at > ?)
          OR (${RISK_RANK_SQL} = ? AND r.expires_at = ? AND r.created_at = ? AND r.id > ?)
        )`
        params.push(
          cursor.riskRank,
          cursor.riskRank, cursor.expiresAt,
          cursor.riskRank, cursor.expiresAt, cursor.createdAt,
          cursor.riskRank, cursor.expiresAt, cursor.createdAt, cursor.id,
        )
      }
    } else {
      order = "r.terminal_at DESC, r.id DESC"
      if (filters.cursor !== undefined) {
        const cursor = decodeCursor(filters.cursor, "history")
        continuation = "AND (r.terminal_at < ? OR (r.terminal_at = ? AND r.id < ?))"
        params.push(cursor.terminalAt, cursor.terminalAt, cursor.id)
      }
    }
    params.push(filters.limit + 1)
    const rows = this.db.query<ApprovalRow, SQLQueryBindings[]>(`
      SELECT ${APPROVAL_COLUMNS}
      FROM approval_records r
      WHERE ${where.sql}
      ${continuation}
      ORDER BY ${order}
      LIMIT ?
    `).all(...params)
    const decoded = rows.map(decodeApprovalRow)
    const hasMore = decoded.length > filters.limit
    const items = hasMore ? decoded.slice(0, filters.limit) : decoded
    const last = items.at(-1)
    let nextCursor: string | null = null
    if (hasMore && last) {
      if (filters.group === "pending") {
        nextCursor = encodeCursor({
          v: 1,
          group: "pending",
          riskRank: riskRank(last.risk),
          expiresAt: last.expiresAt,
          createdAt: last.createdAt,
          id: last.id,
        })
      } else {
        if (last.terminalAt === null) corrupt()
        nextCursor = encodeCursor({
          v: 1,
          group: "history",
          terminalAt: last.terminalAt,
          id: last.id,
        })
      }
    }
    return { items, nextCursor }
  }

  summarizePending(
    query: Omit<ApprovalListQuery, "group" | "cursor" | "limit">,
  ): ApprovalPendingAggregate {
    const filters = normalizeFilters(query, true)
    const where = buildWhere(filters)
    const row = this.db.query<AggregateRow, SQLQueryBindings[]>(`
      WITH filtered AS (
        SELECT
          r.id AS id,
          r.risk AS risk,
          r.expires_at AS expires_at,
          r.created_at AS created_at,
          ${RISK_RANK_SQL} AS risk_rank
        FROM approval_records r
        WHERE ${where.sql}
      )
      SELECT
        COUNT(*) AS count,
        CASE MAX(risk_rank)
          WHEN 3 THEN 'destructive'
          WHEN 2 THEN 'elevated'
          WHEN 1 THEN 'low'
          ELSE NULL
        END AS highest_risk,
        MIN(expires_at) AS nearest_expiry,
        (
          SELECT id
          FROM filtered
          ORDER BY risk_rank DESC, expires_at ASC, created_at ASC, id ASC
          LIMIT 1
        ) AS first_id
      FROM filtered
    `).get(...where.params)
    if (!row) corrupt()
    const count = rowInteger(row.count)
    if (count < 0) corrupt()
    const highestRisk = row.highest_risk === null ? null : rowRisk(row.highest_risk)
    const nearestExpiry = rowNullableInteger(row.nearest_expiry)
    const firstId = row.first_id === null ? null : rowString(row.first_id, true, MAX_APPROVAL_ID_BYTES)
    if (count === 0) {
      if (highestRisk !== null || nearestExpiry !== null || firstId !== null) corrupt()
    } else if (highestRisk === null || nearestExpiry === null || firstId === null) {
      corrupt()
    }
    return { count, highestRisk, nearestExpiry, firstId }
  }

  pendingCount(): number {
    const row = this.db.query<{ count: unknown }, []>(`
      SELECT COUNT(*) AS count
      FROM approval_records r
      WHERE r.state <> 'registering' AND r.state='pending'
    `).get()
    if (!row) corrupt()
    const count = rowInteger(row.count)
    if (count < 0) corrupt()
    return count
  }

  putNotification(approvalId: string, adapter: string, reference: string, now: number): void {
    requireInputString(approvalId)
    requireInputString(adapter)
    requireInputString(reference)
    requireInputInteger(now)
    this.db.query(`
      INSERT INTO approval_notifications(
        approval_id, adapter, reference, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(approval_id, adapter) DO UPDATE SET
        reference=excluded.reference,
        updated_at=excluded.updated_at
    `).run(approvalId, adapter, reference, now, now)
  }

  listNotifications(
    approvalId?: string,
  ): Array<{ approvalId: string; adapter: string; reference: string }> {
    if (approvalId !== undefined) requireInputString(approvalId)
    const params: SQLQueryBindings[] = []
    const approvalClause = approvalId === undefined ? "" : "AND n.approval_id=?"
    if (approvalId !== undefined) params.push(approvalId)
    const rows = this.db.query<NotificationRow, SQLQueryBindings[]>(`
      SELECT
        n.approval_id AS approval_id,
        n.adapter AS adapter,
        n.reference AS reference
      FROM approval_notifications n
      INNER JOIN approval_records r ON r.id=n.approval_id
      WHERE r.state <> 'registering'
      ${approvalClause}
      ORDER BY n.approval_id ASC, n.adapter ASC
    `).all(...params)
    return rows.map((row) => ({
      approvalId: rowString(row.approval_id, true, MAX_APPROVAL_ID_BYTES),
      adapter: rowString(row.adapter, true),
      reference: rowString(row.reference, true),
    }))
  }

  listPendingMissingNotification(
    adapter: string,
    afterId: string | null,
    limit: number,
  ): ApprovalRecord[] {
    requireInputString(adapter)
    if (afterId !== null) requireInputString(afterId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidFilter()
    const rows = this.db.query<ApprovalRow, [string, string | null, string | null, number]>(`
      SELECT ${APPROVAL_COLUMNS}
      FROM approval_records r
      LEFT JOIN approval_notifications n
        ON n.approval_id=r.id AND n.adapter=?
      WHERE r.state <> 'registering'
        AND r.state='pending'
        AND n.approval_id IS NULL
        AND (? IS NULL OR r.id>?)
      ORDER BY r.id ASC
      LIMIT ?
    `).all(adapter, afterId, afterId, limit)
    return rows.map(decodeApprovalRow)
  }

  private readVisible(id: string): ApprovalRecord | null {
    const row = this.db.query<ApprovalRow, [string]>(`
      SELECT ${APPROVAL_COLUMNS}
      FROM approval_records r
      WHERE r.id=? AND r.state <> 'registering'
    `).get(id)
    return row === null ? null : decodeApprovalRow(row)
  }
}
