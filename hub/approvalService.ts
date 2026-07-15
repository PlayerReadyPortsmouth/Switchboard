import { createHash, timingSafeEqual } from "node:crypto"
import type { ApprovalEventStream, ApprovalOperationsEvent } from "./approvalEvents"
import type { ApprovalKindPolicy, ApprovalPolicyRegistry } from "./approvalPolicy"
import {
  ApprovalRepositoryError,
  type ApprovalDecisionReservation,
  type ApprovalHistoryRepository,
  type ApprovalReconciliation,
  type ApprovalStoredDecisionResult,
} from "./approvalRepository"
import type { HeldApprovalRegistry } from "./heldApprovalRegistry"
import {
  resolveApprovalWebAccess,
  type ApprovalWebAccess,
  type WorkspaceRole,
} from "./operations/access"
import type {
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalDetailView,
  ApprovalFire,
  ApprovalLifecycleState,
  ApprovalListPage,
  ApprovalListQuery,
  ApprovalNotificationView,
  ApprovalOrigin,
  ApprovalPrincipal,
  ApprovalRecord,
  ApprovalRequestDescriptor,
  ApprovalSummaryView,
  SafeApprovalAuditView,
  SafeValue,
} from "./approvalTypes"
import type {
  ApprovalConfig,
  AuditEvent,
  AuditInput,
  WorkspaceConfig,
} from "./types"

export type ApprovalAccessContext = "workspace" | "legacy" | "adapter"

export interface ApprovalNotificationPort {
  readonly adapter: string
  post(input: {
    approval: ApprovalNotificationView
    origin: { surface?: string; externalLocation?: string } | null
  }): Promise<string | null>
  update(reference: string, approval: ApprovalNotificationView): Promise<void>
}

export interface ApprovalNotificationLifecycle {
  activateNotificationAdapter(adapter: string): Promise<void>
  deactivateNotificationAdapter(adapter: string): void
}

export interface ApprovalOperationsDependencies {
  repository: ApprovalHistoryRepository
  held: HeldApprovalRegistry
  policies: ApprovalPolicyRegistry
  events: ApprovalEventStream
  workspace: WorkspaceConfig | undefined
  approvals: ApprovalConfig | undefined
  approversBySurface: Readonly<Record<string, readonly string[]>>
  audit(input: AuditInput): void
  relatedAudit(correlationId: string): AuditEvent[]
  canViewConversation(principal: ApprovalPrincipal, conversationId: string): boolean
  now(): number
  id(): string
  ttlMs: number
  notifications?: ApprovalNotificationPort[]
}

export interface ApprovalOperationsSession {
  feature: boolean
  coreEnabled: boolean
  role: WorkspaceRole
  canDecide: boolean
  pendingCount: number
}

export type ApprovalOperationsErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_request"
  | "invalid_cursor"
  | "stale_version"
  | "already_resolved"
  | "idempotency_conflict"
  | "expired"
  | "interrupted"
  | "registration_failed"
  | "approval_unavailable"

export class ApprovalOperationsError extends Error {
  readonly name = "ApprovalOperationsError"

  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    readonly code: ApprovalOperationsErrorCode,
    readonly recovery: "none" | "reload" | "contact_operator",
    readonly canonical: ApprovalDetailView | null = null,
  ) {
    super(code)
  }
}

interface InFlightDecision {
  requestHash: string
  promise: Promise<ApprovalDecisionResult>
}

interface OriginNotificationContext {
  origin: { surface?: string; externalLocation?: string } | null
  remaining: Set<string>
}

const ABSENT = Symbol("absent")
const encoder = new TextEncoder()
const MAX_SURFACE_BYTES = 64
const MAX_ID_BYTES = 256
const MAX_IDEMPOTENCY_KEY_BYTES = 256
const MAX_NOTIFICATION_REFERENCE_BYTES = 4_096
const MAX_REGISTRATION_ATTEMPTS = 5
const EXPIRY_BATCH_SIZE = 50
const BACKFILL_PAGE_SIZE = 50
const MAX_ORIGIN_CONTEXTS = 1_000
const MAX_AUDIT_ACTIVITY = 100

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function dataValue(value: Record<string, unknown>, key: string): unknown | typeof ABSENT {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    throw invalidRequest()
  }
  if (descriptor === undefined) return ABSENT
  if (!("value" in descriptor)) throw invalidRequest()
  return descriptor.value
}

function invalidRequest(): ApprovalOperationsError {
  return new ApprovalOperationsError(400, "invalid_request", "none")
}

function notFound(): ApprovalOperationsError {
  return new ApprovalOperationsError(404, "not_found", "none")
}

function unavailable(): ApprovalOperationsError {
  return new ApprovalOperationsError(500, "approval_unavailable", "contact_operator")
}

function boundedString(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || encoder.encode(value).byteLength === 0
    || encoder.encode(value).byteLength > maxBytes) {
    throw invalidRequest()
  }
  return value
}

function optionalBoundedString(value: unknown, maxBytes: number): string | undefined {
  if (value === ABSENT || value === undefined) return undefined
  return boundedString(value, maxBytes)
}

function safeNow(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw invalidRequest()
  return value as number
}

function principalCopy(value: unknown): ApprovalPrincipal {
  if (!isPlainRecord(value)) throw invalidRequest()
  return {
    surface: boundedString(dataValue(value, "surface"), MAX_SURFACE_BYTES),
    id: boundedString(dataValue(value, "id"), MAX_ID_BYTES),
  }
}

function originCopy(value: unknown): {
  conversationId: string | null
  notification: { surface?: string; externalLocation?: string } | null
} {
  if (value === ABSENT || value === undefined) {
    return { conversationId: null, notification: null }
  }
  if (!isPlainRecord(value)) throw invalidRequest()
  const conversationId = optionalBoundedString(dataValue(value, "conversationId"), MAX_ID_BYTES) ?? null
  const surface = optionalBoundedString(dataValue(value, "surface"), MAX_SURFACE_BYTES)
  const externalLocation = optionalBoundedString(dataValue(value, "externalLocation"), MAX_ID_BYTES)
  return {
    conversationId,
    notification: surface === undefined && externalLocation === undefined
      ? null
      : {
        ...(surface === undefined ? {} : { surface }),
        ...(externalLocation === undefined ? {} : { externalLocation }),
      },
  }
}

function requestParts(descriptor: ApprovalRequestDescriptor): {
  kind: string
  requestedBy: ApprovalPrincipal
  origin: ReturnType<typeof originCopy>
} {
  if (!isPlainRecord(descriptor)) throw invalidRequest()
  return {
    kind: boundedString(dataValue(descriptor, "kind"), MAX_SURFACE_BYTES),
    requestedBy: principalCopy(dataValue(descriptor, "requestedBy")),
    origin: originCopy(dataValue(descriptor, "origin")),
  }
}

function lifecycle(record: ApprovalRecord): ApprovalLifecycleState {
  if (record.state === "registering") throw unavailable()
  return record.state
}

function actor(principal: ApprovalPrincipal): string {
  return `${principal.surface}:${principal.id}`
}

function fingerprintMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

export class ApprovalOperationsService implements ApprovalNotificationLifecycle {
  private readonly notificationPorts = new Map<string, ApprovalNotificationPort>()
  private readonly readyAdapters = new Set<string>()
  private readonly adapterActivationGenerations = new Map<string, number>()
  private readonly adapterActivations = new Map<string, Promise<void>>()
  private readonly notificationPromises = new Map<string, Promise<void>>()
  private readonly originContexts = new Map<string, OriginNotificationContext>()
  private readonly queuedRefreshes = new Map<string, Map<string, string>>()
  private readonly notificationUpdateTails = new Map<string, Promise<void>>()
  private readonly inFlightDecisions = new Map<string, InFlightDecision>()

  constructor(private readonly deps: ApprovalOperationsDependencies) {
    if (!Number.isSafeInteger(deps.ttlMs) || deps.ttlMs <= 0) throw invalidRequest()
    for (const port of deps.notifications ?? []) {
      if (typeof port.adapter !== "string" || port.adapter.trim().length === 0
        || encoder.encode(port.adapter).byteLength > MAX_SURFACE_BYTES) {
        throw new Error("invalid_notification_adapter")
      }
      if (this.notificationPorts.has(port.adapter)) throw new Error("duplicate_notification_adapter")
      this.notificationPorts.set(port.adapter, port)
    }
  }

  async request(descriptor: ApprovalRequestDescriptor, fire: ApprovalFire): Promise<ApprovalRecord> {
    if (this.deps.approvals?.enabled !== true) throw notFound()
    if (typeof fire !== "function") throw invalidRequest()
    const trusted = requestParts(descriptor)
    let policy: ApprovalKindPolicy
    let prepared: ReturnType<ApprovalKindPolicy["prepare"]>
    try {
      policy = this.deps.policies.require(trusted.kind)
      prepared = policy.prepare(descriptor)
    } catch {
      throw invalidRequest()
    }

    const createdAt = safeNow(this.deps.now())
    const expiresAt = createdAt + this.deps.ttlMs
    if (!Number.isSafeInteger(expiresAt) || expiresAt < createdAt) throw invalidRequest()

    let registering: ApprovalRecord | null = null
    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
      let id: string
      try {
        id = boundedString(this.deps.id(), MAX_ID_BYTES)
      } catch {
        throw new ApprovalOperationsError(500, "registration_failed", "contact_operator")
      }
      const candidate: ApprovalRecord = {
        id,
        version: 1,
        kind: policy.kind,
        target: prepared.target,
        summary: prepared.summary,
        detail: prepared.detail,
        requestedBy: { ...trusted.requestedBy },
        originConversationId: trusted.origin.conversationId,
        risk: prepared.risk,
        effectFingerprint: prepared.effectFingerprint,
        createdAt,
        expiresAt,
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
        correlationId: id,
      }
      let inserted: ReturnType<ApprovalHistoryRepository["insertRegistering"]>
      try {
        inserted = this.deps.repository.insertRegistering(candidate)
      } catch {
        throw new ApprovalOperationsError(500, "registration_failed", "contact_operator")
      }
      if (inserted.kind === "id_collision") continue
      registering = candidate
      break
    }
    if (registering === null) {
      throw new ApprovalOperationsError(500, "registration_failed", "contact_operator")
    }

    let active: ApprovalRecord
    try {
      await this.deps.held.activate(registering.id, registering.effectFingerprint, fire)
      const activated = this.deps.repository.activate(registering.id, registering.version)
      if (activated === null) throw new Error("registration_activation_lost")
      active = activated
    } catch {
      this.deps.held.discard(registering.id)
      this.originContexts.delete(registering.id)
      try {
        this.deps.repository.interruptRegistration(
          registering.id,
          safeNow(this.deps.now()),
          "registration_failed",
        )
      } catch {
        // Registration failure remains a safe typed error even if cleanup also fails.
      }
      throw new ApprovalOperationsError(500, "registration_failed", "contact_operator")
    }
    this.rememberOrigin(active.id, trusted.origin.notification)
    await this.emitTransition(active, "approval_requested", "pending", trusted.requestedBy)
    await Promise.all([...this.readyAdapters].map(adapter => this.ensureNotification(adapter, active.id)))
    return active
  }

  session(
    principalValue: ApprovalPrincipal,
    context: ApprovalAccessContext = "workspace",
  ): ApprovalOperationsSession {
    const principal = principalCopy(principalValue)
    this.requireContext(context)
    const access = this.webAccess(principal)
    const visible = principal.surface === "web" && access.role !== "hidden"
      && (context === "workspace" ? access.feature : context === "legacy" ? access.coreEnabled : false)
    return {
      feature: access.feature,
      coreEnabled: access.coreEnabled,
      role: access.role,
      canDecide: visible && this.canDecide(principal, context),
      pendingCount: visible ? this.safePendingCount() : 0,
    }
  }

  pendingCount(): number {
    return this.safePendingCount()
  }

  list(
    principalValue: ApprovalPrincipal,
    context: ApprovalAccessContext,
    query: ApprovalListQuery,
  ): ApprovalListPage {
    const principal = principalCopy(principalValue)
    this.requireReadable(principal, context)
    if (!isPlainRecord(query)) throw invalidRequest()
    const conversationValue = dataValue(query, "conversationId")
    if (conversationValue !== ABSENT && conversationValue !== undefined) {
      const conversationId = boundedString(conversationValue, MAX_ID_BYTES)
      if (!this.safeCanViewConversation(principal, conversationId)) throw notFound()
    }

    let page: ReturnType<ApprovalHistoryRepository["list"]>
    try {
      page = this.deps.repository.list(query)
    } catch (error) {
      throw this.mapRepositoryReadError(error)
    }
    const items = page.items.map(record => this.summaryView(record, principal))
    let querySummary: ApprovalListPage["querySummary"] = null
    if (query.group === "pending") {
      const aggregateQuery = this.aggregateQuery(query)
      try {
        querySummary = this.deps.repository.summarizePending(aggregateQuery)
      } catch (error) {
        throw this.mapRepositoryReadError(error)
      }
    }
    return {
      items,
      nextCursor: page.nextCursor,
      pendingCount: this.safePendingCount(),
      querySummary,
    }
  }

  get(
    principalValue: ApprovalPrincipal,
    context: ApprovalAccessContext,
    approvalIdValue: string,
  ): ApprovalDetailView {
    const principal = principalCopy(principalValue)
    this.requireReadable(principal, context)
    const approvalId = boundedString(approvalIdValue, MAX_ID_BYTES)
    const record = this.visibleRecord(approvalId)
    if (record === null) throw notFound()
    return this.detailView(record, principal, context)
  }

  subscribe(
    after: number,
    callback: (event: ApprovalOperationsEvent) => void,
  ): { unsubscribe(): void } {
    if (!Number.isSafeInteger(after) || after < 0 || typeof callback !== "function") throw invalidRequest()
    return this.deps.events.subscribe(after, callback)
  }

  decide(
    principalValue: ApprovalPrincipal,
    context: ApprovalAccessContext,
    inputValue: ApprovalDecisionInput,
  ): Promise<ApprovalDecisionResult> {
    const principal = principalCopy(principalValue)
    this.requireReadable(principal, context)
    if (!isPlainRecord(inputValue)) throw invalidRequest()
    const approvalId = boundedString(dataValue(inputValue, "approvalId"), MAX_ID_BYTES)
    const record = this.visibleRecord(approvalId)
    if (record === null) throw notFound()
    this.requireDecisionAuthorization(principal, context, record)
    this.projectedRecord(record)

    const decisionValue = dataValue(inputValue, "decision")
    if (decisionValue !== "grant" && decisionValue !== "deny") throw invalidRequest()
    const versionValue = dataValue(inputValue, "expectedVersion")
    if (typeof versionValue !== "string" || !/^[1-9][0-9]*$/.test(versionValue)) throw invalidRequest()
    const expectedVersion = Number(versionValue)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) throw invalidRequest()
    const idempotencyKey = boundedString(
      dataValue(inputValue, "idempotencyKey"),
      MAX_IDEMPOTENCY_KEY_BYTES,
    )
    const requestHash = createHash("sha256").update(JSON.stringify({
      approvalId,
      decision: decisionValue,
      expectedVersion,
    })).digest("hex")
    const inFlightKey = JSON.stringify([principal.surface, principal.id, idempotencyKey])
    const existing = this.inFlightDecisions.get(inFlightKey)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApprovalOperationsError(409, "idempotency_conflict", "reload")
      }
      return existing.promise
    }

    let resolve!: (result: ApprovalDecisionResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<ApprovalDecisionResult>((yes, no) => {
      resolve = yes
      reject = no
    })
    const entry = { requestHash, promise }
    this.inFlightDecisions.set(inFlightKey, entry)
    const execution = this.executeDecision(
      principal,
      context,
      approvalId,
      decisionValue,
      expectedVersion,
      idempotencyKey,
      requestHash,
    )
    const release = (): void => {
      if (this.inFlightDecisions.get(inFlightKey) === entry) {
        this.inFlightDecisions.delete(inFlightKey)
      }
    }
    void execution.then(
      result => {
        release()
        resolve(result)
      },
      error => {
        release()
        reject(error)
      },
    )
    return promise
  }

  async expireDue(): Promise<ApprovalRecord[]> {
    const now = safeNow(this.deps.now())
    const expired: ApprovalRecord[] = []
    while (true) {
      let batch: ApprovalRecord[]
      try {
        batch = this.deps.repository.expireDue(now, EXPIRY_BATCH_SIZE)
      } catch (error) {
        throw this.mapRepositoryReadError(error)
      }
      if (batch.length === 0) return expired
      for (const record of batch) {
        expired.push(record)
        this.deps.held.discard(record.id)
        this.originContexts.delete(record.id)
        await this.emitTransition(record, "approval_expired", "ok", { surface: "hub", id: "expiry" })
      }
    }
  }

  async reconcileStartup(): Promise<ApprovalReconciliation> {
    let reconciliation: ApprovalReconciliation
    try {
      reconciliation = this.deps.repository.reconcileStartup(safeNow(this.deps.now()))
    } catch (error) {
      throw this.mapRepositoryReadError(error)
    }

    for (const reference of reconciliation.notifications) {
      this.queueRefresh(reference.adapter, reference.approvalId, reference.reference)
    }
    for (const record of reconciliation.lifecycleInterrupted) {
      this.deps.held.discard(record.id)
      this.originContexts.delete(record.id)
      await this.emitTransition(record, "approval_restart_interrupted", "error", {
        surface: "hub",
        id: "startup",
      })
    }
    for (const record of reconciliation.executionInterrupted) {
      this.deps.held.discard(record.id)
      this.originContexts.delete(record.id)
      await this.emitTransition(record, "approval_execution_interrupted", "error", {
        surface: "hub",
        id: "startup",
      })
    }
    await Promise.all([...this.readyAdapters].map(adapter => this.flushQueuedRefreshes(adapter)))
    return reconciliation
  }

  activateNotificationAdapter(adapter: string): Promise<void> {
    const port = this.notificationPorts.get(adapter)
    if (!port) throw new Error("invalid_notification_adapter")
    const becameReady = !this.readyAdapters.has(adapter)
    this.readyAdapters.add(adapter)
    if (becameReady) {
      this.adapterActivationGenerations.set(
        adapter,
        (this.adapterActivationGenerations.get(adapter) ?? 0) + 1,
      )
    }
    const current = this.adapterActivations.get(adapter)
    if (current) return current
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const activation = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    this.adapterActivations.set(adapter, activation)
    void (async () => {
      try {
        while (this.readyAdapters.has(adapter)) {
          const generation = this.adapterActivationGenerations.get(adapter) ?? 0
          await this.backfillMissingNotifications(adapter)
          await this.flushQueuedRefreshes(adapter)
          if (!this.readyAdapters.has(adapter)
            || this.adapterActivationGenerations.get(adapter) === generation) {
            break
          }
        }
        if (this.adapterActivations.get(adapter) === activation) {
          this.adapterActivations.delete(adapter)
        }
        resolve()
      } catch (error) {
        if (this.adapterActivations.get(adapter) === activation) {
          this.adapterActivations.delete(adapter)
        }
        reject(error)
      }
    })()
    return activation
  }

  deactivateNotificationAdapter(adapter: string): void {
    this.readyAdapters.delete(adapter)
  }

  async backfillMissingNotifications(adapter: string): Promise<void> {
    if (!this.notificationPorts.has(adapter)) throw new Error("invalid_notification_adapter")
    let afterId: string | null = null
    while (this.readyAdapters.has(adapter)) {
      let records: ApprovalRecord[]
      try {
        records = this.deps.repository.listPendingMissingNotification(
          adapter,
          afterId,
          BACKFILL_PAGE_SIZE,
        )
      } catch (error) {
        throw this.mapRepositoryReadError(error)
      }
      if (records.length === 0) return
      for (const record of records) await this.ensureNotification(adapter, record.id)
      afterId = records.at(-1)!.id
    }
  }

  private async executeDecision(
    principal: ApprovalPrincipal,
    context: ApprovalAccessContext,
    approvalId: string,
    decision: "grant" | "deny",
    expectedVersion: number,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ApprovalDecisionResult> {
    let reservation: ApprovalDecisionReservation
    try {
      reservation = this.deps.repository.reserveDecision({
        approvalId,
        principal,
        decision,
        expectedVersion,
        idempotencyKey,
        requestHash,
        now: safeNow(this.deps.now()),
      })
    } catch (error) {
      throw this.mapRepositoryReadError(error)
    }

    if (reservation.kind === "replay") {
      const replay = this.recordForStoredResult(reservation.result)
      this.requireDecisionAuthorization(principal, context, replay)
      if (context === "adapter") await this.refreshAdapterRecord(principal.surface, replay)
      return { approval: this.detailView(replay, principal, context) }
    }

    if (reservation.kind === "in_flight") {
      const canonicalRecord = this.visibleRecord(approvalId)
      if (canonicalRecord) this.requireDecisionAuthorization(principal, context, canonicalRecord)
      const canonical = canonicalRecord === null ? null : this.detailView(canonicalRecord, principal, context)
      if (canonicalRecord && context === "adapter") {
        await this.refreshAdapterRecord(principal.surface, canonicalRecord)
      }
      throw new ApprovalOperationsError(409, "already_resolved", "reload", canonical)
    }

    if (reservation.kind === "conflict") {
      const canonicalRecord = reservation.record
      if (canonicalRecord && reservation.code === "expired") {
        this.deps.held.discard(canonicalRecord.id)
        this.originContexts.delete(canonicalRecord.id)
        await this.emitTransition(canonicalRecord, "approval_expired", "ok", principal)
      }
      if (canonicalRecord) this.requireDecisionAuthorization(principal, context, canonicalRecord)
      if (canonicalRecord && reservation.code !== "expired" && context === "adapter") {
        await this.refreshAdapterRecord(principal.surface, canonicalRecord)
      }
      const canonical = canonicalRecord === null
        ? null
        : this.detailView(canonicalRecord, principal, context)
      throw new ApprovalOperationsError(409, reservation.code, "reload", canonical)
    }

    const decided = reservation.record
    if (decision === "deny") {
      this.deps.held.discard(decided.id)
      this.originContexts.delete(decided.id)
      await this.emitTransition(decided, "approval_denied", "ok", principal)
      return { approval: this.detailView(decided, principal, context) }
    }

    await this.emitTransition(decided, "approval_granted", "pending", principal)
    const held = this.deps.held.consume(decided.id)
    if (held === null || !fingerprintMatches(held.fingerprint, decided.effectFingerprint)) {
      const finalized = this.finalizeGrantOrCanonical(
        principal,
        context,
        idempotencyKey,
        decided,
        { outcome: "interrupted", now: safeNow(this.deps.now()) },
      )
      this.originContexts.delete(finalized.id)
      await this.emitTransition(finalized, "approval_execution_interrupted", "error", principal)
      return { approval: this.detailView(finalized, principal, context) }
    }

    let execution: { outcome: "succeeded" | "failed"; detail: SafeValue | null }
    const policy = this.policyFor(decided)
    try {
      execution = policy.sanitizeExecution(await held.fire(decided.id))
    } catch {
      try {
        execution = policy.sanitizeExecution({
          outcome: "failed",
          detail: { failureCode: "effect_rejected" },
        })
      } catch {
        execution = { outcome: "failed", detail: null }
      }
    }
    const finalized = this.finalizeGrantOrCanonical(
      principal,
      context,
      idempotencyKey,
      decided,
      {
        outcome: execution.outcome,
        detail: execution.detail,
        now: safeNow(this.deps.now()),
      },
    )
    this.originContexts.delete(finalized.id)
    const finalAction = finalized.execution === "succeeded"
      ? "approval_execution_succeeded"
      : finalized.execution === "failed"
        ? "approval_execution_failed"
        : "approval_execution_interrupted"
    await this.emitTransition(
      finalized,
      finalAction,
      finalized.execution === "succeeded" ? "ok" : "error",
      principal,
    )
    return { approval: this.detailView(finalized, principal, context) }
  }

  private finalizeGrantOrCanonical(
    principal: ApprovalPrincipal,
    context: ApprovalAccessContext,
    idempotencyKey: string,
    decided: ApprovalRecord,
    result: Parameters<ApprovalHistoryRepository["finalizeGrantExecution"]>[3],
  ): ApprovalRecord {
    let finalized: ApprovalRecord | null
    try {
      finalized = this.deps.repository.finalizeGrantExecution(
        principal,
        idempotencyKey,
        decided.version,
        result,
      )
    } catch {
      try {
        finalized = this.deps.repository.finalizeGrantExecution(
          principal,
          idempotencyKey,
          decided.version,
          { outcome: "interrupted", now: result.now },
        )
      } catch {
        finalized = null
      }
      if (finalized) return finalized
      const canonicalRecord = this.visibleRecord(decided.id)
      if (canonicalRecord?.state === "granted" && canonicalRecord.execution !== "pending") {
        return canonicalRecord
      }
      const canonical = canonicalRecord === null
        ? null
        : this.detailView(canonicalRecord, principal, context)
      throw new ApprovalOperationsError(409, "interrupted", "reload", canonical)
    }
    if (finalized) return finalized
    const canonicalRecord = this.visibleRecord(decided.id)
    if (canonicalRecord?.state === "granted" && canonicalRecord.execution !== "pending") {
      return canonicalRecord
    }
    const canonical = canonicalRecord === null
      ? null
      : this.detailView(canonicalRecord, principal, context)
    throw new ApprovalOperationsError(409, "already_resolved", "reload", canonical)
  }

  private recordForStoredResult(result: ApprovalStoredDecisionResult): ApprovalRecord {
    const record = this.visibleRecord(result.approvalId)
    if (record === null || record.version !== result.version || record.state !== result.lifecycle
      || record.execution !== result.execution) {
      throw unavailable()
    }
    return record
  }

  private requireContext(context: ApprovalAccessContext): void {
    if (context !== "workspace" && context !== "legacy" && context !== "adapter") {
      throw invalidRequest()
    }
  }

  private webAccess(principal: ApprovalPrincipal): ApprovalWebAccess {
    if (principal.surface !== "web") {
      return {
        feature: this.deps.workspace?.features?.approvals === true,
        coreEnabled: this.deps.approvals?.enabled === true,
        role: "hidden",
        canDecide: false,
      }
    }
    return resolveApprovalWebAccess(principal.id, this.deps.workspace, this.deps.approvals)
  }

  private requireReadable(principal: ApprovalPrincipal, context: ApprovalAccessContext): void {
    this.requireContext(context)
    if (context === "adapter") {
      if (this.deps.approvals?.enabled !== true) throw notFound()
      return
    }
    const access = this.webAccess(principal)
    if (principal.surface !== "web" || access.role === "hidden") throw notFound()
    if (context === "workspace" && !access.feature) throw notFound()
    if (context === "legacy" && !access.coreEnabled) throw notFound()
  }

  private canDecide(principal: ApprovalPrincipal, context: ApprovalAccessContext): boolean {
    if (this.deps.approvals?.enabled !== true) return false
    if (context === "adapter") {
      const allowed = this.deps.approversBySurface[principal.surface]
      return allowed?.some(value => value === "*" || value === principal.id) === true
    }
    if (principal.surface !== "web") return false
    const access = this.webAccess(principal)
    return access.canDecide && (context !== "workspace" || access.feature)
  }

  private requireDecisionAuthorization(
    principal: ApprovalPrincipal,
    context: ApprovalAccessContext,
    record: ApprovalRecord,
  ): void {
    this.requireReadable(principal, context)
    if (this.canDecide(principal, context)) return
    this.auditForbidden(principal, record)
    throw new ApprovalOperationsError(403, "forbidden", "none")
  }

  private safeCanViewConversation(principal: ApprovalPrincipal, conversationId: string): boolean {
    try {
      return this.deps.canViewConversation({ ...principal }, conversationId) === true
    } catch {
      return false
    }
  }

  private aggregateQuery(
    query: ApprovalListQuery,
  ): Omit<ApprovalListQuery, "group" | "cursor" | "limit"> {
    return {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.risk === undefined ? {} : { risk: query.risk }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.requester === undefined ? {} : { requester: query.requester }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
      ...(query.createdFrom === undefined ? {} : { createdFrom: query.createdFrom }),
      ...(query.createdTo === undefined ? {} : { createdTo: query.createdTo }),
      ...(query.decisionFrom === undefined ? {} : { decisionFrom: query.decisionFrom }),
      ...(query.decisionTo === undefined ? {} : { decisionTo: query.decisionTo }),
    }
  }

  private visibleRecord(id: string): ApprovalRecord | null {
    try {
      return this.deps.repository.getVisible(id)
    } catch (error) {
      throw this.mapRepositoryReadError(error)
    }
  }

  private safePendingCount(): number {
    try {
      return this.deps.repository.pendingCount()
    } catch (error) {
      throw this.mapRepositoryReadError(error)
    }
  }

  private mapRepositoryReadError(error: unknown): ApprovalOperationsError {
    if (error instanceof ApprovalOperationsError) return error
    if (error instanceof ApprovalRepositoryError) {
      if (error.code === "invalid_cursor") {
        return new ApprovalOperationsError(400, "invalid_cursor", "none")
      }
      if (error.code === "invalid_filter" || error.code === "invalid_record") {
        return invalidRequest()
      }
    }
    return unavailable()
  }

  private policyFor(record: ApprovalRecord): ApprovalKindPolicy {
    try {
      return this.deps.policies.require(record.kind)
    } catch {
      throw unavailable()
    }
  }

  private projectedRecord(record: ApprovalRecord): {
    detail: SafeValue
    executionDetail: SafeValue | null
  } {
    const policy = this.policyFor(record)
    try {
      const detail = policy.projectDetail(record.detail)
      let executionDetail: SafeValue | null = null
      if (record.execution === "succeeded" || record.execution === "failed") {
        executionDetail = policy.sanitizeExecution({
          outcome: record.execution,
          ...(record.executionDetail === null ? {} : { detail: record.executionDetail }),
        }).detail
      }
      return { detail, executionDetail }
    } catch {
      throw unavailable()
    }
  }

  private summaryFields(record: ApprovalRecord, principal: ApprovalPrincipal): ApprovalSummaryView {
    const view: ApprovalSummaryView = {
      id: record.id,
      version: String(record.version),
      kind: record.kind,
      target: record.target,
      summary: record.summary,
      risk: record.risk,
      requestedBy: { ...record.requestedBy },
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      terminalAt: record.terminalAt,
      state: lifecycle(record),
      execution: record.execution,
    }
    if (record.originConversationId !== null
      && this.safeCanViewConversation(principal, record.originConversationId)) {
      view.conversationId = record.originConversationId
    }
    return view
  }

  private summaryView(record: ApprovalRecord, principal: ApprovalPrincipal): ApprovalSummaryView {
    this.projectedRecord(record)
    return this.summaryFields(record, principal)
  }

  private detailView(
    record: ApprovalRecord,
    principal: ApprovalPrincipal,
    context: ApprovalAccessContext,
  ): ApprovalDetailView {
    const projected = this.projectedRecord(record)
    const summary = this.summaryFields(record, principal)
    return {
      ...summary,
      detail: projected.detail,
      executionDetail: projected.executionDetail,
      decisionBy: record.decisionBy === null ? null : { ...record.decisionBy },
      decisionAt: record.decisionAt,
      outcomeReason: record.outcomeReason,
      executionStartedAt: record.executionStartedAt,
      executionFinishedAt: record.executionFinishedAt,
      audit: this.relatedAudit(record.correlationId),
      permissions: { canDecide: this.canDecide(principal, context) },
    }
  }

  private relatedAudit(correlationId: string): SafeApprovalAuditView[] {
    let events: AuditEvent[]
    try {
      events = this.deps.relatedAudit(correlationId)
    } catch {
      return []
    }
    if (!Array.isArray(events)) return []
    return events.slice(-MAX_AUDIT_ACTIVITY).flatMap(event => {
      if (!Number.isSafeInteger(event.ts) || typeof event.actor !== "string"
        || typeof event.action !== "string" || typeof event.outcome !== "string") {
        return []
      }
      return [{
        ts: event.ts,
        actor: event.actor,
        action: event.action,
        outcome: event.outcome,
      }]
    })
  }

  private notificationView(record: ApprovalRecord): ApprovalNotificationView {
    this.projectedRecord(record)
    return {
      id: record.id,
      version: String(record.version),
      kind: record.kind,
      target: record.target,
      summary: record.summary,
      risk: record.risk,
      requestedBy: { ...record.requestedBy },
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      terminalAt: record.terminalAt,
      state: lifecycle(record),
      decisionBy: record.decisionBy === null ? null : { ...record.decisionBy },
      decisionAt: record.decisionAt,
      outcomeReason: record.outcomeReason,
      execution: record.execution,
      executionStartedAt: record.executionStartedAt,
      executionFinishedAt: record.executionFinishedAt,
    }
  }

  private safeAudit(input: AuditInput): void {
    try {
      this.deps.audit(input)
    } catch {
      // Auditing is evidence, never a state-transition dependency.
    }
  }

  private auditForbidden(principal: ApprovalPrincipal, record: ApprovalRecord): void {
    this.safeAudit({
      kind: "approval",
      actor: actor(principal),
      action: "approval_decision_forbidden",
      outcome: "deny",
      corr: record.correlationId,
    })
  }

  private safePublish(record: ApprovalRecord): void {
    try {
      this.deps.events.publish({
        kind: "approval_changed",
        approvalId: record.id,
        pendingCount: this.deps.repository.pendingCount(),
        ts: safeNow(this.deps.now()),
      })
    } catch {
      // Event listeners cannot roll back a committed canonical transition.
    }
  }

  private async emitTransition(
    record: ApprovalRecord,
    action: string,
    outcome: "ok" | "deny" | "error" | "pending",
    principal: ApprovalPrincipal,
  ): Promise<void> {
    this.safeAudit({
      kind: "approval",
      actor: actor(principal),
      action,
      outcome,
      corr: record.correlationId,
    })
    await this.refreshAllNotifications(record)
    this.safePublish(record)
  }

  private async refreshAllNotifications(record: ApprovalRecord): Promise<void> {
    let references: Array<{ approvalId: string; adapter: string; reference: string }>
    try {
      references = this.deps.repository.listNotifications(record.id)
    } catch {
      this.safeAudit({
        kind: "approval",
        actor: "hub",
        action: "approval_notification_lookup_failed",
        outcome: "error",
        corr: record.correlationId,
      })
      return
    }
    await Promise.all(references.map(reference => this.updateReference(
      reference.adapter,
      reference.approvalId,
      reference.reference,
      record,
    )))
  }

  private async refreshAdapterRecord(adapter: string, record: ApprovalRecord): Promise<void> {
    let reference: { approvalId: string; adapter: string; reference: string } | undefined
    try {
      reference = this.deps.repository.listNotifications(record.id)
        .find(value => value.adapter === adapter)
    } catch {
      return
    }
    if (reference) {
      await this.updateReference(adapter, record.id, reference.reference, record)
    }
  }

  private queueRefresh(adapter: string, approvalId: string, reference: string): void {
    let adapterQueue = this.queuedRefreshes.get(adapter)
    if (!adapterQueue) {
      adapterQueue = new Map()
      this.queuedRefreshes.set(adapter, adapterQueue)
    }
    adapterQueue.set(approvalId, reference)
  }

  private async updateReference(
    adapter: string,
    approvalId: string,
    reference: string,
    record: ApprovalRecord,
  ): Promise<boolean> {
    const key = JSON.stringify([adapter, approvalId])
    const previous = this.notificationUpdateTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    this.notificationUpdateTails.set(key, tail)
    try {
      await previous
      return await this.performUpdateReference(adapter, approvalId, reference, record)
    } finally {
      if (this.notificationUpdateTails.get(key) === tail) {
        this.notificationUpdateTails.delete(key)
      }
      release()
    }
  }

  private async performUpdateReference(
    adapter: string,
    approvalId: string,
    reference: string,
    record: ApprovalRecord,
  ): Promise<boolean> {
    const port = this.notificationPorts.get(adapter)
    if (!port || !this.readyAdapters.has(adapter)) {
      this.queueRefresh(adapter, approvalId, reference)
      return false
    }
    try {
      await port.update(reference, this.notificationView(record))
      this.queuedRefreshes.get(adapter)?.delete(approvalId)
      return true
    } catch {
      this.queueRefresh(adapter, approvalId, reference)
      this.safeAudit({
        kind: "approval",
        actor: "hub",
        action: "approval_notification_update_failed",
        outcome: "error",
        target: adapter,
        corr: record.correlationId,
      })
      return false
    }
  }

  private async flushQueuedRefreshes(adapter: string): Promise<void> {
    const queued = this.queuedRefreshes.get(adapter)
    if (!queued || !this.readyAdapters.has(adapter)) return
    for (const [approvalId, reference] of [...queued]) {
      const record = this.visibleRecord(approvalId)
      if (record === null) {
        queued.delete(approvalId)
        continue
      }
      await this.updateReference(adapter, approvalId, reference, record)
    }
    if (queued.size === 0) this.queuedRefreshes.delete(adapter)
  }

  private ensureNotification(adapter: string, approvalId: string): Promise<void> {
    const key = JSON.stringify([adapter, approvalId])
    const current = this.notificationPromises.get(key)
    if (current) return current
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const tracked = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    this.notificationPromises.set(key, tracked)
    void this.postMissingNotification(adapter, approvalId).then(
      () => {
        if (this.notificationPromises.get(key) === tracked) this.notificationPromises.delete(key)
        resolve()
      },
      error => {
        if (this.notificationPromises.get(key) === tracked) this.notificationPromises.delete(key)
        reject(error)
      },
    )
    return tracked
  }

  private async postMissingNotification(adapter: string, approvalId: string): Promise<void> {
    const port = this.notificationPorts.get(adapter)
    if (!port || !this.readyAdapters.has(adapter)) return
    let record: ApprovalRecord | null
    try {
      record = this.deps.repository.getVisible(approvalId)
      if (record === null || record.state !== "pending") return
      if (this.deps.repository.listNotifications(approvalId).some(value => value.adapter === adapter)) {
        this.markOriginComplete(approvalId, adapter)
        return
      }
    } catch {
      this.safeAudit({
        kind: "approval",
        actor: "hub",
        action: "approval_notification_lookup_failed",
        outcome: "error",
        corr: approvalId,
      })
      return
    }

    let approval: ApprovalNotificationView
    try {
      approval = this.notificationView(record)
    } catch {
      this.safeAudit({
        kind: "approval",
        actor: "hub",
        action: "approval_notification_projection_failed",
        outcome: "error",
        corr: approvalId,
      })
      return
    }
    const origin = this.originContexts.get(approvalId)?.origin ?? null
    try {
      const reference = await port.post({
        approval,
        origin: origin === null ? null : { ...origin },
      })
      if (reference === null) {
        this.markOriginComplete(approvalId, adapter)
        return
      }
      const safeReference = boundedString(reference, MAX_NOTIFICATION_REFERENCE_BYTES)
      this.deps.repository.putNotification(approvalId, adapter, safeReference, safeNow(this.deps.now()))
      this.markOriginComplete(approvalId, adapter)
      const current = this.deps.repository.getVisible(approvalId)
      if (current && current.state !== "pending") {
        await this.updateReference(adapter, approvalId, safeReference, current)
      }
    } catch {
      this.safeAudit({
        kind: "approval",
        actor: "hub",
        action: "approval_notification_post_failed",
        outcome: "error",
        target: adapter,
        corr: approvalId,
      })
    }
  }

  private rememberOrigin(
    approvalId: string,
    origin: { surface?: string; externalLocation?: string } | null,
  ): void {
    if (this.notificationPorts.size === 0) return
    if (this.originContexts.size >= MAX_ORIGIN_CONTEXTS) {
      const oldest = this.originContexts.keys().next().value as string | undefined
      if (oldest !== undefined) this.originContexts.delete(oldest)
    }
    this.originContexts.set(approvalId, {
      origin: origin === null ? null : { ...origin },
      remaining: new Set(this.notificationPorts.keys()),
    })
  }

  private markOriginComplete(approvalId: string, adapter: string): void {
    const context = this.originContexts.get(approvalId)
    if (!context) return
    context.remaining.delete(adapter)
    if (context.remaining.size === 0) this.originContexts.delete(approvalId)
  }
}
