import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditEvent } from "./audit"
import { ApprovalEventStream, type ApprovalOperationsEvent } from "./approvalEvents"
import { ApprovalPolicyRegistry, createOutboundApprovalPolicy } from "./approvalPolicy"
import {
  type ApprovalHistoryRepository,
  SqliteApprovalHistoryRepository,
} from "./approvalRepository"
import {
  ApprovalOperationsError,
  ApprovalOperationsService,
  type ApprovalAccessContext,
  type ApprovalNotificationPort,
  type ApprovalOperationsSession,
} from "./approvalService"
import type {
  ApprovalDecisionInput,
  ApprovalExecutionResult,
  ApprovalFire,
  ApprovalPrincipal,
  ApprovalRecord,
  ApprovalRequestDescriptor,
} from "./approvalTypes"
import { runConversationMigrations } from "./conversations/migrations"
import { HeldApprovalRegistry } from "./heldApprovalRegistry"
import type {
  ApprovalConfig,
  AuditEvent,
  AuditInput,
  WorkspaceConfig,
} from "./types"

const openDatabases = new Set<Database>()
const tempDirectories: string[] = []

afterEach(() => {
  for (const db of openDatabases) {
    try {
      db.close()
    } catch {
      // A reopen test may have closed the handle explicitly.
    }
  }
  openDatabases.clear()
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "switchboard-approval-service-"))
  tempDirectories.push(directory)
  return join(directory, "switchboard.sqlite")
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class ControlledHeldRegistry extends HeldApprovalRegistry {
  readonly activationReached = deferred<void>()
  readonly activationRelease = deferred<void>()

  constructor(
    private readonly pauseActivation: boolean,
    private readonly failActivation: boolean,
  ) {
    super()
  }

  override activate(id: string, fingerprint: string, fire: ApprovalFire): void {
    this.activationReached.resolve()
    if (this.failActivation) throw new Error("raw held activation failure")
    if (!this.pauseActivation) {
      super.activate(id, fingerprint, fire)
      return
    }
    return this.activationRelease.promise.then(() => {
      super.activate(id, fingerprint, fire)
    }) as unknown as void
  }

  releaseActivation(): void {
    this.activationRelease.resolve()
  }
}

type NotificationPostInput = Parameters<ApprovalNotificationPort["post"]>[0]
type NotificationUpdateInput = {
  reference: string
  approval: Parameters<ApprovalNotificationPort["update"]>[1]
}

class FakeNotificationPort implements ApprovalNotificationPort {
  readonly postCalls: NotificationPostInput[] = []
  readonly updateCalls: NotificationUpdateInput[] = []
  postHandler: ((input: NotificationPostInput) => Promise<string | null>) | null = null
  updateHandler: ((reference: string, approval: NotificationUpdateInput["approval"]) => Promise<void>) | null = null

  constructor(readonly adapter: string) {}

  async post(input: NotificationPostInput): Promise<string | null> {
    this.postCalls.push(structuredClone(input))
    if (this.postHandler) return this.postHandler(input)
    return `${this.adapter}-ref:${input.approval.id}`
  }

  async update(reference: string, approval: NotificationUpdateInput["approval"]): Promise<void> {
    this.updateCalls.push({ reference, approval: structuredClone(approval) })
    if (this.updateHandler) await this.updateHandler(reference, approval)
  }
}

interface HarnessOptions {
  approvals?: ApprovalConfig
  workspace?: WorkspaceConfig
  ports?: FakeNotificationPort[]
  pauseActivation?: boolean
  failHeldActivation?: boolean
  failRepositoryActivation?: boolean
  failFirstFinalization?: boolean
  missingPageCap?: number
  ids?: string[]
  now?: number
  ttlMs?: number
  databaseFile?: string
  auditThrows?: boolean
  canViewConversation?: (principal: ApprovalPrincipal, conversationId: string) => boolean
}

interface ServiceHarness {
  db: Database
  repo: SqliteApprovalHistoryRepository
  repository: ApprovalHistoryRepository
  service: ApprovalOperationsService
  held: ControlledHeldRegistry
  policies: ApprovalPolicyRegistry
  events: ApprovalEventStream
  eventRows: ApprovalOperationsEvent[]
  auditRows: AuditEvent[]
  approvals: ApprovalConfig
  workspace: WorkspaceConfig
  ports: FakeNotificationPort[]
  listCalls(): number
  conversationChecks(): Array<{ principal: ApprovalPrincipal; conversationId: string }>
  lastId(): string
  setNow(value: number): void
}

function serviceHarness(options: HarnessOptions = {}): ServiceHarness {
  const db = options.databaseFile
    ? new Database(options.databaseFile, { create: true })
    : new Database(":memory:")
  openDatabases.add(db)
  runConversationMigrations(db)
  const repo = new SqliteApprovalHistoryRepository(db)
  let listCalls = 0
  let finalizationCalls = 0
  const repository = new Proxy(repo, {
    get(target, property) {
      if (property === "activate" && options.failRepositoryActivation) {
        return () => null
      }
      if (property === "list") {
        return (query: Parameters<ApprovalHistoryRepository["list"]>[0]) => {
          listCalls += 1
          return target.list(query)
        }
      }
      if (property === "finalizeGrantExecution" && options.failFirstFinalization) {
        return (...args: Parameters<ApprovalHistoryRepository["finalizeGrantExecution"]>) => {
          finalizationCalls += 1
          if (finalizationCalls === 1) throw new Error("raw finalization failure")
          return target.finalizeGrantExecution(...args)
        }
      }
      if (property === "listPendingMissingNotification" && options.missingPageCap !== undefined) {
        return (
          adapter: string,
          afterId: string | null,
          limit: number,
        ) => target.listPendingMissingNotification(
          adapter,
          afterId,
          Math.min(limit, options.missingPageCap!),
        )
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as ApprovalHistoryRepository

  const approvals = options.approvals ?? {
    enabled: true,
    approvers: ["discord-approver"],
    webApprovers: ["operator"],
  }
  const workspace = options.workspace ?? {
    features: { approvals: true },
    viewers: ["viewer", "participant"],
    operators: ["operator", "excluded", "discord-approver"],
  }
  const held = new ControlledHeldRegistry(
    options.pauseActivation ?? false,
    options.failHeldActivation ?? false,
  )
  const policies = new ApprovalPolicyRegistry()
  policies.register(createOutboundApprovalPolicy(Buffer.alloc(32, 7)))
  const events = new ApprovalEventStream(100)
  const eventRows: ApprovalOperationsEvent[] = []
  events.subscribe(0, event => eventRows.push(event))
  const auditRows: AuditEvent[] = []
  const ports = options.ports ?? [new FakeNotificationPort("fake")]
  const conversationChecks: Array<{ principal: ApprovalPrincipal; conversationId: string }> = []
  let currentNow = options.now ?? 1_000
  const generated = [...(options.ids ?? [])]
  let fallbackId = 0
  let lastId = ""

  const service = new ApprovalOperationsService({
    repository,
    held,
    policies,
    events,
    workspace,
    approvals,
    approversBySurface: {
      discord: approvals.approvers ?? [],
    },
    audit(input: AuditInput): void {
      if (options.auditThrows) throw new Error("raw audit sink failure")
      auditRows.push(auditEvent(input, currentNow))
    },
    relatedAudit(correlationId: string): AuditEvent[] {
      return auditRows.filter(row => row.corr === correlationId)
    },
    canViewConversation(principal, conversationId): boolean {
      conversationChecks.push({ principal: { ...principal }, conversationId })
      return options.canViewConversation?.(principal, conversationId)
        ?? (principal.surface === "web" && principal.id === "participant" && conversationId === "conversation-1")
    },
    now: () => currentNow,
    id: () => {
      lastId = generated.shift() ?? `approval-${++fallbackId}`
      return lastId
    },
    ttlMs: options.ttlMs ?? 1_000,
    notifications: ports,
  })

  return {
    db,
    repo,
    repository,
    service,
    held,
    policies,
    events,
    eventRows,
    auditRows,
    approvals,
    workspace,
    ports,
    listCalls: () => listCalls,
    conversationChecks: () => [...conversationChecks],
    lastId: () => lastId,
    setNow: value => { currentNow = value },
  }
}

function outboundDescriptor(
  overrides: Partial<ApprovalRequestDescriptor> = {},
): ApprovalRequestDescriptor {
  return {
    kind: "outbound",
    target: "untrusted target",
    requestedBy: { surface: "agent", id: "assistant" },
    origin: {
      conversationId: "conversation-1",
      surface: "discord",
      externalLocation: "channel-1",
    },
    summary: "untrusted summary",
    detail: {
      route: {
        id: "deploy",
        url: "https://user:pass@hooks.example.com/private?secret=raw#fragment",
        method: "post",
        headers: { Authorization: "Bearer raw-secret" },
        secretEnv: "OUTBOUND_SECRET",
        template: "raw-template",
      },
      body: "tiny secret body",
    },
    ...overrides,
  }
}

function web(id: string): ApprovalPrincipal {
  return { surface: "web", id }
}

function discord(id: string): ApprovalPrincipal {
  return { surface: "discord", id }
}

function decision(
  approval: Pick<ApprovalRecord, "id" | "version"> | { id: string; version: string },
  overrides: Partial<ApprovalDecisionInput> = {},
): ApprovalDecisionInput {
  return {
    approvalId: approval.id,
    decision: "grant",
    expectedVersion: String(approval.version),
    idempotencyKey: `key:${approval.id}`,
    ...overrides,
  }
}

async function expectOperationsError(
  action: () => unknown | Promise<unknown>,
  code: string,
  status?: number,
): Promise<ApprovalOperationsError> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalOperationsError)
    expect(error).toMatchObject({ code, ...(status === undefined ? {} : { status }) })
    return error as ApprovalOperationsError
  }
  throw new Error(`expected ApprovalOperationsError(${code})`)
}

function registeringRecord(
  h: ServiceHarness,
  id: string,
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  const prepared = h.policies.require("outbound").prepare(outboundDescriptor())
  const createdAt = overrides.createdAt ?? 1_000
  return {
    id,
    version: 1,
    kind: "outbound",
    target: prepared.target,
    summary: prepared.summary,
    detail: prepared.detail,
    requestedBy: { surface: "agent", id: "assistant" },
    originConversationId: "conversation-1",
    risk: prepared.risk,
    effectFingerprint: prepared.effectFingerprint,
    createdAt,
    expiresAt: createdAt + 1_000,
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
    ...overrides,
  }
}

function seedPending(h: ServiceHarness, id: string): ApprovalRecord {
  const record = registeringRecord(h, id)
  expect(h.repo.insertRegistering(record)).toEqual({ kind: "inserted" })
  const pending = h.repo.activate(id, 1)
  if (!pending) throw new Error(`failed to activate fixture ${id}`)
  return pending
}

test("request is invisible and side-effect free until the row and closure are both active", async () => {
  const h = serviceHarness({ pauseActivation: true })
  const port = h.ports[0]!
  port.postHandler = async input => {
    expect(h.repo.getVisible(input.approval.id)).toMatchObject({ state: "pending" })
    return `ref:${input.approval.id}`
  }
  await h.service.activateNotificationAdapter("fake")

  const pending = h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  await h.held.activationReached.promise

  expect(h.repo.pendingCount()).toBe(0)
  expect(h.repo.getVisible(h.lastId())).toBeNull()
  expect(h.repo.list({ group: "pending", limit: 50 }).items).toEqual([])
  expect(h.auditRows).toEqual([])
  expect(h.eventRows).toEqual([])
  expect(port.postCalls).toEqual([])

  h.held.releaseActivation()
  await expect(pending).resolves.toMatchObject({ state: "pending", version: 2 })
  expect(h.held.has(h.lastId())).toBe(true)
  expect(h.auditRows).toHaveLength(1)
  expect(h.eventRows).toHaveLength(1)
  expect(port.postCalls).toHaveLength(1)
})

test("activation failure discards the closure, interrupts registration, and emits no premature effects", async () => {
  const h = serviceHarness({ failRepositoryActivation: true })
  await h.service.activateNotificationAdapter("fake")

  await expectOperationsError(
    () => h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" })),
    "registration_failed",
    500,
  )

  expect(h.held.has(h.lastId())).toBe(false)
  expect(h.repo.getVisible(h.lastId())).toMatchObject({
    state: "interrupted",
    execution: "not_applicable",
    outcomeReason: "registration_failed",
  })
  expect(h.auditRows).toEqual([])
  expect(h.eventRows).toEqual([])
  expect(h.ports[0]!.postCalls).toEqual([])
})

test("request validates core enablement, trusted identity bounds, policy support, and TTL overflow", async () => {
  const disabled = serviceHarness({ approvals: { enabled: false } })
  await expectOperationsError(
    () => disabled.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" })),
    "not_found",
    404,
  )

  const h = serviceHarness()
  await expectOperationsError(
    () => h.service.request(outboundDescriptor({ requestedBy: { surface: "", id: "assistant" } }), async () => ({ outcome: "succeeded" })),
    "invalid_request",
    400,
  )
  await expectOperationsError(
    () => h.service.request(outboundDescriptor({ kind: "x".repeat(65) }), async () => ({ outcome: "succeeded" })),
    "invalid_request",
    400,
  )
  await expectOperationsError(
    () => h.service.request(outboundDescriptor({
      origin: { conversationId: "c", surface: "discord", externalLocation: "x".repeat(257) },
    }), async () => ({ outcome: "succeeded" })),
    "invalid_request",
    400,
  )
  await expectOperationsError(
    () => h.service.request(outboundDescriptor({ kind: "unsupported" }), async () => ({ outcome: "succeeded" })),
    "invalid_request",
    400,
  )
  h.setNow(Number.MAX_SAFE_INTEGER)
  await expectOperationsError(
    () => h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" })),
    "invalid_request",
    400,
  )
  expect(h.repo.pendingCount()).toBe(0)
  expect(h.auditRows).toEqual([])
})

test("construction rejects blank or duplicate notification adapter names", () => {
  expect(() => serviceHarness({ ports: [new FakeNotificationPort("")] })).toThrow("invalid_notification_adapter")
  expect(() => serviceHarness({ ports: [new FakeNotificationPort(" \t ")] })).toThrow("invalid_notification_adapter")
  expect(() => serviceHarness({
    ports: [new FakeNotificationPort("same"), new FakeNotificationPort("same")],
  })).toThrow("duplicate_notification_adapter")
})

test("request retries only an ID collision and activates only the fresh record", async () => {
  const h = serviceHarness({ ids: ["collision", "fresh"] })
  seedPending(h, "collision")

  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  expect(record.id).toBe("fresh")
  expect(h.held.has("collision")).toBe(false)
  expect(h.held.has("fresh")).toBe(true)
  expect(h.auditRows.map(row => row.corr)).toEqual(["fresh"])
  expect(h.eventRows.map(row => row.kind === "approval_changed" ? row.approvalId : null)).toEqual(["fresh"])
})

test("request bounds collision retries and never turns repeated collisions into side effects", async () => {
  const ids = ["collision", "collision", "collision", "collision", "collision", "collision"]
  const h = serviceHarness({ ids })
  seedPending(h, "collision")

  await expectOperationsError(
    () => h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" })),
    "registration_failed",
    500,
  )

  expect(h.auditRows).toEqual([])
  expect(h.eventRows).toEqual([])
  expect(h.held.has("collision")).toBe(false)
})

test("an inactive adapter is deferred, activation backfills once, and deactivation preserves references", async () => {
  const h = serviceHarness({ ids: ["approval-a", "approval-b"] })
  const port = h.ports[0]!
  const first = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  expect(port.postCalls).toEqual([])
  expect(h.repo.listNotifications(first.id)).toEqual([])

  const activation = h.service.activateNotificationAdapter("fake")
  const coalesced = h.service.activateNotificationAdapter("fake")
  expect(coalesced).toBe(activation)
  await activation

  expect(port.postCalls).toHaveLength(1)
  expect(port.postCalls[0]).toMatchObject({
    approval: { id: first.id, state: "pending" },
    origin: { surface: "discord", externalLocation: "channel-1" },
  })
  expect(h.repo.listNotifications(first.id)).toEqual([{
    approvalId: first.id,
    adapter: "fake",
    reference: `fake-ref:${first.id}`,
  }])

  await h.service.activateNotificationAdapter("fake")
  expect(port.postCalls).toHaveLength(1)
  h.service.deactivateNotificationAdapter("fake")
  const second = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  expect(port.postCalls).toHaveLength(1)
  expect(h.repo.listNotifications(first.id)).toHaveLength(1)
  expect(h.repo.listNotifications(second.id)).toEqual([])
  await h.service.activateNotificationAdapter("fake")
  expect(port.postCalls.map(call => call.approval.id)).toEqual([first.id, second.id])
})

test("synchronous notification re-entry coalesces activation and posting", async () => {
  const h = serviceHarness({ ids: ["approval-a"] })
  const port = h.ports[0]!
  const record = await h.service.request(
    outboundDescriptor(),
    async () => ({ outcome: "succeeded" }),
  )
  const reentry: {
    activation: Promise<void> | null
    backfill: Promise<void> | null
  } = { activation: null, backfill: null }
  let reentered = false
  port.postHandler = async () => {
    if (!reentered) {
      reentered = true
      reentry.activation = h.service.activateNotificationAdapter("fake")
      reentry.backfill = h.service.backfillMissingNotifications("fake")
    }
    return `ref:${record.id}`
  }

  const activation = h.service.activateNotificationAdapter("fake")
  await activation
  await reentry.backfill

  expect(reentry.activation).toBe(activation)
  expect(port.postCalls).toHaveLength(1)
  expect(h.repo.listNotifications(record.id)).toEqual([{
    approvalId: record.id,
    adapter: "fake",
    reference: `ref:${record.id}`,
  }])
})

test("reactivating during in-flight backfill restores readiness and completes the scan", async () => {
  const h = serviceHarness({ ids: ["approval-a", "approval-b"], missingPageCap: 1 })
  const port = h.ports[0]!
  const first = await h.service.request(
    outboundDescriptor(),
    async () => ({ outcome: "succeeded" }),
  )
  const firstStarted = deferred<void>()
  const firstRelease = deferred<void>()
  port.postHandler = async input => {
    if (input.approval.id === first.id) {
      firstStarted.resolve()
      await firstRelease.promise
    }
    return `ref:${input.approval.id}`
  }

  const activation = h.service.activateNotificationAdapter("fake")
  await firstStarted.promise
  h.service.deactivateNotificationAdapter("fake")
  const second = await h.service.request(
    outboundDescriptor(),
    async () => ({ outcome: "succeeded" }),
  )
  const reactivation = h.service.activateNotificationAdapter("fake")
  expect(reactivation).toBe(activation)
  firstRelease.resolve()
  await reactivation

  expect(port.postCalls.map(call => call.approval.id)).toEqual([first.id, second.id])
  expect(h.repo.listNotifications()).toHaveLength(2)
})

test("reactivating after backfill while activation flushes starts another scan", async () => {
  const h = serviceHarness({ ids: ["approval-a", "approval-b"] })
  const port = h.ports[0]!
  const first = await h.service.request(
    outboundDescriptor(),
    async () => ({ outcome: "succeeded" }),
  )
  await h.service.activateNotificationAdapter("fake")

  h.service.deactivateNotificationAdapter("fake")
  await h.service.decide(web("operator"), "workspace", decision(first, { decision: "deny" }))

  const refreshStarted = deferred<void>()
  const releaseRefresh = deferred<void>()
  port.updateHandler = async () => {
    refreshStarted.resolve()
    await releaseRefresh.promise
  }
  const activation = h.service.activateNotificationAdapter("fake")
  await refreshStarted.promise

  h.service.deactivateNotificationAdapter("fake")
  const second = await h.service.request(
    outboundDescriptor(),
    async () => ({ outcome: "succeeded" }),
  )
  const reactivation = h.service.activateNotificationAdapter("fake")
  expect(reactivation).toBe(activation)
  releaseRefresh.resolve()
  await reactivation

  expect(port.postCalls.map(call => call.approval.id)).toEqual([first.id, second.id])
  expect(h.repo.listNotifications(second.id)).toEqual([{
    approvalId: second.id,
    adapter: "fake",
    reference: `fake-ref:${second.id}`,
  }])
})

test("request racing adapter backfill posts each approval exactly once", async () => {
  const h = serviceHarness({ ids: ["approval-a", "approval-b"], missingPageCap: 1 })
  const port = h.ports[0]!
  const first = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  const firstStarted = deferred<void>()
  const firstRelease = deferred<void>()
  const secondStarted = deferred<void>()
  const secondRelease = deferred<void>()
  port.postHandler = async input => {
    if (input.approval.id === first.id) {
      firstStarted.resolve()
      await firstRelease.promise
    } else {
      secondStarted.resolve()
      await secondRelease.promise
    }
    return `ref:${input.approval.id}`
  }

  const activation = h.service.activateNotificationAdapter("fake")
  await firstStarted.promise
  const secondRequest = h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  await secondStarted.promise
  firstRelease.resolve()
  await Promise.resolve()
  await Promise.resolve()
  secondRelease.resolve()

  const second = await secondRequest
  await activation
  expect(port.postCalls.filter(call => call.approval.id === first.id)).toHaveLength(1)
  expect(port.postCalls.filter(call => call.approval.id === second.id)).toHaveLength(1)
  expect(h.repo.listNotifications()).toHaveLength(2)
})

test("notification failures never change canonical state or leak raw errors", async () => {
  const h = serviceHarness()
  const port = h.ports[0]!
  port.postHandler = async () => { throw new Error("raw secret notifier failure") }
  await h.service.activateNotificationAdapter("fake")
  const record = await h.service.request(outboundDescriptor(), async () => ({
    outcome: "succeeded",
    detail: { status: 204, attempts: 1 },
  }))

  expect(record.state).toBe("pending")
  expect(h.repo.listNotifications(record.id)).toEqual([])
  await expect(h.service.decide(web("operator"), "workspace", decision(record))).resolves.toMatchObject({
    approval: { state: "granted", execution: "succeeded" },
  })
  expect(JSON.stringify(h.auditRows)).not.toContain("raw secret")
  expect(h.repo.getVisible(record.id)).toMatchObject({ state: "granted", execution: "succeeded" })
})

test("workspace roles see only projected shells while hidden identities see not_found", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  const viewerSession: ApprovalOperationsSession = h.service.session(web("viewer"), "workspace")
  const operatorSession = h.service.session(web("operator"), "workspace")
  expect(viewerSession).toEqual({
    feature: true,
    coreEnabled: true,
    role: "viewer",
    canDecide: false,
    pendingCount: 1,
  })
  expect(operatorSession).toMatchObject({ role: "operator", canDecide: true, pendingCount: 1 })

  const viewerPage = h.service.list(web("viewer"), "workspace", { group: "pending", limit: 50 })
  const operatorPage = h.service.list(web("operator"), "workspace", { group: "pending", limit: 50 })
  expect(viewerPage).toEqual(operatorPage)
  expect(viewerPage).toMatchObject({
    pendingCount: 1,
    querySummary: { count: 1, highestRisk: "elevated", firstId: record.id },
    items: [{ id: record.id, version: "2", state: "pending" }],
  })
  expect(JSON.stringify(viewerPage)).not.toContain("effectFingerprint")
  expect(JSON.stringify(viewerPage)).not.toContain("payloadFingerprint")
  expect(JSON.stringify(viewerPage)).not.toContain("conversation-1")

  await expectOperationsError(
    () => h.service.list(web("hidden"), "workspace", { group: "pending" }),
    "not_found",
    404,
  )
  await expectOperationsError(
    () => h.service.get(web("hidden"), "workspace", record.id),
    "not_found",
    404,
  )
  await expectOperationsError(
    () => h.service.get(web("hidden"), "legacy", record.id),
    "not_found",
    404,
  )
})

test("legacy reads ignore the workspace feature but still require core enablement", async () => {
  const h = serviceHarness({
    workspace: {
      features: { approvals: false },
      viewers: ["viewer"],
      operators: ["operator"],
    },
  })
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  await expectOperationsError(
    () => h.service.list(web("operator"), "workspace", { group: "pending" }),
    "not_found",
    404,
  )
  expect(h.service.list(web("viewer"), "legacy", { group: "pending" }).items)
    .toMatchObject([{ id: record.id }])
  expect(h.service.get(web("operator"), "legacy", record.id).permissions.canDecide).toBe(true)

  h.approvals.enabled = false
  expect(h.service.session(web("operator"), "workspace")).toMatchObject({
    feature: false,
    coreEnabled: false,
    canDecide: false,
    pendingCount: 0,
  })
  await expectOperationsError(
    () => h.service.list(web("operator"), "legacy", { group: "pending" }),
    "not_found",
    404,
  )
})

test("web and adapter decision authorization are surface-specific and every denial is safely audited", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  expect(h.service.get(web("excluded"), "workspace", record.id).permissions.canDecide).toBe(false)
  await expectOperationsError(
    () => h.service.decide(web("excluded"), "workspace", decision(record)),
    "forbidden",
    403,
  )
  await expectOperationsError(
    () => h.service.decide(discord("not-an-approver"), "adapter", decision(record)),
    "forbidden",
    403,
  )
  await expectOperationsError(
    () => h.service.decide(web("discord-approver"), "adapter", decision(record)),
    "forbidden",
    403,
  )

  const forbiddenRows = h.auditRows.filter(row => row.outcome === "deny")
  expect(forbiddenRows).toHaveLength(3)
  expect(forbiddenRows.every(row => row.corr === record.id)).toBe(true)
  expect(forbiddenRows.map(row => row.actor)).toEqual([
    "web:excluded",
    "discord:not-an-approver",
    "web:discord-approver",
  ])
  expect(JSON.stringify(forbiddenRows)).not.toContain("effectFingerprint")
  expect(JSON.stringify(forbiddenRows)).not.toContain("tiny secret body")

  await expect(h.service.decide(
    discord("discord-approver"),
    "adapter",
    decision(record, { decision: "deny", idempotencyKey: "discord-key" }),
  )).resolves.toMatchObject({ approval: { state: "denied", execution: "not_applicable" } })
})

test("authorization is rechecked before a durable idempotent replay", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  const input = decision(record, { decision: "deny", idempotencyKey: "replay-key" })
  await expect(h.service.decide(web("operator"), "workspace", input)).resolves.toMatchObject({
    approval: { state: "denied" },
  })

  h.approvals.webApprovers = ["somebody-else"]
  await expectOperationsError(
    () => h.service.decide(web("operator"), "workspace", input),
    "forbidden",
    403,
  )
  expect(h.auditRows.filter(row => row.outcome === "deny" && row.corr === record.id)).toHaveLength(1)
})

test("conversation IDs and filters are projected only after conversation authorization", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  const globalViewer = h.service.get(web("viewer"), "workspace", record.id)
  const participant = h.service.get(web("participant"), "workspace", record.id)
  expect(globalViewer).not.toHaveProperty("conversationId")
  expect(participant.conversationId).toBe("conversation-1")

  const callsBeforeDeniedFilter = h.listCalls()
  await expectOperationsError(
    () => h.service.list(web("viewer"), "workspace", {
      group: "pending",
      conversationId: "conversation-1",
    }),
    "not_found",
    404,
  )
  expect(h.listCalls()).toBe(callsBeforeDeniedFilter)

  const participantPage = h.service.list(web("participant"), "workspace", {
    group: "pending",
    conversationId: "conversation-1",
  })
  expect(participantPage.items).toMatchObject([{ id: record.id, conversationId: "conversation-1" }])
  expect(h.conversationChecks()).toContainEqual({
    principal: web("participant"),
    conversationId: "conversation-1",
  })
})

test("detail audit activity is allowlisted and every persisted detail is reprojected after reopen", async () => {
  const file = temporaryDatabasePath()
  const first = serviceHarness({ databaseFile: file, ids: ["approval-reopen"] })
  const record = await first.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  first.auditRows.push({
    ts: 1_010,
    kind: "approval",
    actor: "hub",
    action: "raw-detail-fixture",
    outcome: "ok",
    corr: record.id,
    detail: { secret: "never expose this audit detail" },
  })
  const persisted = first.repo.getVisible(record.id)!
  first.db.query("UPDATE approval_records SET detail_json=? WHERE id=?").run(
    JSON.stringify({ ...(persisted.detail as Record<string, unknown>), injected: "drop-me" }),
    record.id,
  )
  first.db.close()
  openDatabases.delete(first.db)

  const second = serviceHarness({ databaseFile: file })
  second.auditRows.push(...first.auditRows)
  const view = second.service.get(web("operator"), "workspace", record.id)
  expect(view.detail).toEqual(persisted.detail)
  expect(view.audit.some(row => row.action === "raw-detail-fixture")).toBe(true)
  expect(view.audit.every(row => Object.keys(row).sort().join(",") === "action,actor,outcome,ts")).toBe(true)
  expect(JSON.stringify(view.audit)).not.toContain("never expose")
  expect(JSON.stringify(view)).not.toContain("drop-me")

  second.db.query("UPDATE approval_records SET detail_json=? WHERE id=?").run(
    JSON.stringify({ routeId: "corrupt secret value" }),
    record.id,
  )
  const error = await expectOperationsError(
    () => second.service.get(web("operator"), "workspace", record.id),
    "approval_unavailable",
    500,
  )
  expect(JSON.stringify(error)).not.toContain("corrupt secret value")

  second.db.query("UPDATE approval_records SET kind=?, detail_json=? WHERE id=?").run(
    "missing-policy",
    JSON.stringify(persisted.detail),
    record.id,
  )
  await expectOperationsError(
    () => second.service.list(web("operator"), "workspace", { group: "pending" }),
    "approval_unavailable",
    500,
  )
})

test("repository cursor and corruption failures map to typed transport-safe errors", async () => {
  const h = serviceHarness()
  await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  await expectOperationsError(
    () => h.service.list(web("operator"), "workspace", {
      group: "pending",
      cursor: "not-a-valid-cursor",
    }),
    "invalid_cursor",
    400,
  )
  await expectOperationsError(
    () => h.service.get(web("operator"), "workspace", "missing"),
    "not_found",
    404,
  )
})

test("decision validates persisted kind policy and detail before reserving or consuming", async () => {
  const h = serviceHarness({ ids: ["corrupt-detail", "missing-policy"] })
  let fireCalls = 0
  const fire = async (): Promise<ApprovalExecutionResult> => {
    fireCalls += 1
    return { outcome: "succeeded" }
  }
  const corruptDetail = await h.service.request(outboundDescriptor(), fire)
  const missingPolicy = await h.service.request(outboundDescriptor(), fire)
  h.db.query("UPDATE approval_records SET detail_json=? WHERE id=?").run(
    JSON.stringify({ routeId: "missing required fields" }),
    corruptDetail.id,
  )
  h.db.query("UPDATE approval_records SET kind=? WHERE id=?").run("unknown-kind", missingPolicy.id)

  await expectOperationsError(
    () => h.service.decide(web("operator"), "workspace", decision(corruptDetail)),
    "approval_unavailable",
    500,
  )
  await expectOperationsError(
    () => h.service.decide(web("operator"), "workspace", decision(missingPolicy)),
    "approval_unavailable",
    500,
  )

  expect(h.repo.getVisible(corruptDetail.id)).toMatchObject({ state: "pending", version: 2 })
  expect(h.repo.getVisible(missingPolicy.id)).toMatchObject({ state: "pending", version: 2 })
  expect(h.held.has(corruptDetail.id)).toBe(true)
  expect(h.held.has(missingPolicy.id)).toBe(true)
  expect(fireCalls).toBe(0)
})

test("notification projections exclude browser-only and internal fields", async () => {
  const h = serviceHarness()
  await h.service.activateNotificationAdapter("fake")
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  const serialized = JSON.stringify(h.ports[0]!.postCalls[0])
  expect(serialized).toContain(record.id)
  expect(serialized).not.toContain("conversation-1")
  expect(serialized).not.toContain("permissions")
  expect(serialized).not.toContain("audit")
  expect(serialized).not.toContain("detail")
  expect(serialized).not.toContain("effectFingerprint")
  expect(serialized).not.toContain("decisionKey")
  expect(serialized).not.toContain("reference")
})

test("identical concurrent decisions share one promise, expose pending before fire, and execute once", async () => {
  const h = serviceHarness()
  const port = h.ports[0]!
  await h.service.activateNotificationAdapter("fake")
  const fireStarted = deferred<void>()
  const fireResult = deferred<ApprovalExecutionResult>()
  let fireCalls = 0
  const record = await h.service.request(outboundDescriptor(), async () => {
    fireCalls += 1
    fireStarted.resolve()
    return fireResult.promise
  })
  const input = decision(record, { idempotencyKey: "one-key" })

  const first = h.service.decide(web("operator"), "workspace", input)
  const second = h.service.decide(web("operator"), "workspace", input)
  expect(first).toBe(second)
  const conflict = expectOperationsError(
    () => h.service.decide(web("operator"), "workspace", { ...input, decision: "deny" }),
    "idempotency_conflict",
    409,
  )
  await fireStarted.promise

  expect(fireCalls).toBe(1)
  expect(h.repo.getVisible(record.id)).toMatchObject({ state: "granted", execution: "pending", version: 3 })
  expect(port.updateCalls.at(-1)?.approval).toMatchObject({
    state: "granted",
    execution: "pending",
    version: "3",
  })
  expect(h.eventRows).toHaveLength(2)
  expect(h.auditRows.at(-1)).toMatchObject({ corr: record.id, outcome: "pending" })

  fireResult.resolve({ outcome: "succeeded", detail: { status: 204, attempts: 1 } })
  const [firstResult, secondResult] = await Promise.all([first, second])
  await conflict
  expect(firstResult).toEqual(secondResult)
  expect(firstResult).toMatchObject({
    approval: { state: "granted", execution: "succeeded", version: "4" },
  })
  expect(port.updateCalls.at(-1)?.approval).toMatchObject({ state: "granted", execution: "succeeded" })
  expect(port.updateCalls).toHaveLength(2)
  expect(h.eventRows).toHaveLength(3)
})

test("decision input uses bounded opaque keys and non-zero safe-integer version strings", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  for (const input of [
    decision(record, { expectedVersion: "" }),
    decision(record, { expectedVersion: "0" }),
    decision(record, { expectedVersion: "2.0" }),
    decision(record, { expectedVersion: String(Number.MAX_SAFE_INTEGER + 1) }),
    decision(record, { idempotencyKey: "" }),
    decision(record, { idempotencyKey: "x".repeat(257) }),
  ]) {
    await expectOperationsError(
      () => h.service.decide(web("operator"), "workspace", input),
      "invalid_request",
      400,
    )
  }
  expect(h.repo.getVisible(record.id)).toMatchObject({ state: "pending", version: 2 })
})

test("a definitive effect failure is a successful grant with a sanitized final result", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({
    outcome: "failed",
    detail: {
      status: 503,
      attempts: 3,
      failureCode: "http_error",
      body: "drop this raw body",
    },
  }))

  const result = await h.service.decide(web("operator"), "workspace", decision(record))

  expect(result).toMatchObject({
    approval: {
      state: "granted",
      execution: "failed",
      executionDetail: { status: 503, attempts: 3, failureCode: "http_error" },
    },
  })
  expect(JSON.stringify(result)).not.toContain("drop this raw body")
})

test("denial discards the held effect without firing it", async () => {
  const h = serviceHarness()
  let fireCalls = 0
  const record = await h.service.request(outboundDescriptor(), async () => {
    fireCalls += 1
    return { outcome: "succeeded" }
  })

  const result = await h.service.decide(web("operator"), "workspace", decision(record, { decision: "deny" }))

  expect(result.approval).toMatchObject({ state: "denied", execution: "not_applicable" })
  expect(fireCalls).toBe(0)
  expect(h.held.has(record.id)).toBe(false)
})

test("missing and mismatched held effects finalize grants as interrupted without firing", async () => {
  const h = serviceHarness({ ids: ["missing-effect", "mismatched-effect"] })
  let fireCalls = 0
  const fire = async (): Promise<ApprovalExecutionResult> => {
    fireCalls += 1
    return { outcome: "succeeded" }
  }
  const missing = await h.service.request(outboundDescriptor(), fire)
  h.held.discard(missing.id)
  const missingResult = await h.service.decide(web("operator"), "workspace", decision(missing))

  const mismatched = await h.service.request(outboundDescriptor(), fire)
  const held = h.held.consume(mismatched.id)!
  h.held.activate(mismatched.id, "0".repeat(64), held.fire)
  const mismatchedResult = await h.service.decide(web("operator"), "workspace", decision(mismatched))

  expect(missingResult.approval).toMatchObject({
    state: "granted",
    execution: "interrupted",
    outcomeReason: "execution_outcome_unknown",
  })
  expect(mismatchedResult.approval).toMatchObject({
    state: "granted",
    execution: "interrupted",
    outcomeReason: "execution_outcome_unknown",
  })
  expect(fireCalls).toBe(0)
})

test("a thrown effect becomes a sanitized failed/effect_rejected execution", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => {
    throw new Error("raw closure secret")
  })

  const result = await h.service.decide(web("operator"), "workspace", decision(record))

  expect(result.approval).toMatchObject({
    state: "granted",
    execution: "failed",
    executionDetail: { failureCode: "effect_rejected" },
  })
  expect(JSON.stringify(result)).not.toContain("raw closure secret")
  expect(JSON.stringify(h.auditRows)).not.toContain("raw closure secret")
})

test("a post-grant finalization failure is completed as interrupted without a 500", async () => {
  const h = serviceHarness({ failFirstFinalization: true })
  const record = await h.service.request(outboundDescriptor(), async () => ({
    outcome: "succeeded",
    detail: { status: 204, attempts: 1 },
  }))

  const result = await h.service.decide(web("operator"), "workspace", decision(record))

  expect(result.approval).toMatchObject({
    state: "granted",
    execution: "interrupted",
    outcomeReason: "execution_outcome_unknown",
  })
  expect(JSON.stringify(result)).not.toContain("raw finalization failure")
  expect(JSON.stringify(h.auditRows)).not.toContain("raw finalization failure")
  expect(h.auditRows.at(-1)).toMatchObject({
    action: "approval_execution_interrupted",
    outcome: "error",
  })
})

test("expiry is single-shot, discards without fire, and refreshes canonical surfaces", async () => {
  const h = serviceHarness()
  const port = h.ports[0]!
  await h.service.activateNotificationAdapter("fake")
  let fireCalls = 0
  const record = await h.service.request(outboundDescriptor(), async () => {
    fireCalls += 1
    return { outcome: "succeeded" }
  })
  h.setNow(record.expiresAt)

  const expired = await h.service.expireDue()

  expect(expired).toMatchObject([{ id: record.id, state: "expired", outcomeReason: "expired" }])
  expect(await h.service.expireDue()).toEqual([])
  expect(h.held.has(record.id)).toBe(false)
  expect(fireCalls).toBe(0)
  expect(port.updateCalls.at(-1)?.approval).toMatchObject({ state: "expired" })
  expect(h.eventRows.at(-1)).toMatchObject({ kind: "approval_changed", approvalId: record.id, pendingCount: 0 })
})

test("a decision at exact expiry returns the canonical expiry conflict and performs expiry cleanup", async () => {
  const h = serviceHarness()
  await h.service.activateNotificationAdapter("fake")
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  h.setNow(record.expiresAt)

  const error = await expectOperationsError(
    () => h.service.decide(web("operator"), "workspace", decision(record)),
    "expired",
    409,
  )

  expect(error.canonical).toMatchObject({ state: "expired", outcomeReason: "expired" })
  expect(h.repo.getVisible(record.id)).toMatchObject({ state: "expired" })
  expect(h.held.has(record.id)).toBe(false)
  expect(h.ports[0]!.updateCalls.at(-1)?.approval).toMatchObject({ state: "expired" })
  expect(h.auditRows.at(-1)).toMatchObject({ corr: record.id })
})

test("startup reconciliation interrupts abandoned lifecycle work and never replays closures", async () => {
  const h = serviceHarness({ ids: ["pending-before-restart"] })
  const port = h.ports[0]!
  await h.service.activateNotificationAdapter("fake")
  let fireCalls = 0
  const pending = await h.service.request(outboundDescriptor(), async () => {
    fireCalls += 1
    return { outcome: "succeeded" }
  })
  const registering = registeringRecord(h, "registering-before-restart")
  expect(h.repo.insertRegistering(registering)).toEqual({ kind: "inserted" })
  h.service.deactivateNotificationAdapter("fake")
  h.setNow(1_500)

  const reconciliation = await h.service.reconcileStartup()

  expect(reconciliation.lifecycleInterrupted).toMatchObject([
    { id: pending.id, state: "interrupted", outcomeReason: "restart_interrupted" },
    { id: registering.id, state: "interrupted", outcomeReason: "registration_interrupted" },
  ])
  expect(fireCalls).toBe(0)
  expect(h.held.has(pending.id)).toBe(false)
  expect(port.updateCalls).toEqual([])
  await h.service.activateNotificationAdapter("fake")
  expect(port.updateCalls.at(-1)?.approval).toMatchObject({
    id: pending.id,
    state: "interrupted",
    outcomeReason: "restart_interrupted",
  })
})

test("startup reconciliation marks granted pending execution unknown and completes replay state", async () => {
  const h = serviceHarness()
  let fireCalls = 0
  const record = await h.service.request(outboundDescriptor(), async () => {
    fireCalls += 1
    return { outcome: "succeeded" }
  })
  const reservationInput = {
    approvalId: record.id,
    principal: web("operator"),
    decision: "grant" as const,
    expectedVersion: record.version,
    idempotencyKey: "restart-key",
    requestHash: "restart-request-hash",
    now: 1_100,
  }
  expect(h.repo.reserveDecision(reservationInput)).toMatchObject({
    kind: "won",
    record: { state: "granted", execution: "pending" },
  })
  h.held.discard(record.id)
  h.setNow(1_200)

  const first = await h.service.reconcileStartup()
  const second = await h.service.reconcileStartup()

  expect(first.executionInterrupted).toMatchObject([{
    id: record.id,
    state: "granted",
    execution: "interrupted",
    outcomeReason: "execution_outcome_unknown",
  }])
  expect(second).toMatchObject({ lifecycleInterrupted: [], executionInterrupted: [] })
  expect(h.repo.reserveDecision(reservationInput)).toMatchObject({
    kind: "replay",
    result: { lifecycle: "granted", execution: "interrupted" },
  })
  expect(fireCalls).toBe(0)
})

test("production-shaped IDs remain unique across repository recreation", async () => {
  const file = temporaryDatabasePath()
  const firstId = randomUUID()
  const secondId = randomUUID()
  const first = serviceHarness({ databaseFile: file, ids: [firstId] })
  const firstRecord = await first.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  first.held.discard(firstRecord.id)
  first.db.close()
  openDatabases.delete(first.db)

  const second = serviceHarness({ databaseFile: file, ids: [secondId] })
  await second.service.reconcileStartup()
  const secondRecord = await second.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))

  expect(firstRecord.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(secondRecord.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(secondRecord.id).not.toBe(firstRecord.id)
})

test("notification updates are independent and failures cannot roll back a canonical transition", async () => {
  const failing = new FakeNotificationPort("failing")
  const healthy = new FakeNotificationPort("healthy")
  const h = serviceHarness({ ports: [failing, healthy] })
  await Promise.all([
    h.service.activateNotificationAdapter("failing"),
    h.service.activateNotificationAdapter("healthy"),
  ])
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  failing.updateHandler = async () => { throw new Error("raw update secret") }

  const result = await h.service.decide(
    web("operator"),
    "workspace",
    decision(record, { decision: "deny" }),
  )

  expect(result.approval.state).toBe("denied")
  expect(failing.updateCalls).toHaveLength(1)
  expect(healthy.updateCalls).toHaveLength(1)
  expect(healthy.updateCalls[0]!.approval.state).toBe("denied")
  expect(JSON.stringify(h.auditRows)).not.toContain("raw update secret")
})

test("audit and event listener failures are isolated from canonical transitions", async () => {
  const h = serviceHarness({ auditThrows: true })
  h.events.subscribe(0, () => { throw new Error("raw event listener failure") })

  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  const result = await h.service.decide(
    web("operator"),
    "workspace",
    decision(record, { decision: "deny" }),
  )

  expect(result.approval.state).toBe("denied")
  expect(h.repo.getVisible(record.id)).toMatchObject({ state: "denied" })
})

test("same-card updates cannot let a slow stale view overwrite a finalized view", async () => {
  const discordPort = new FakeNotificationPort("discord")
  const h = serviceHarness({ ports: [discordPort] })
  await h.service.activateNotificationAdapter("discord")
  const fireStarted = deferred<void>()
  const finishFire = deferred<ApprovalExecutionResult>()
  const record = await h.service.request(outboundDescriptor(), async () => {
    fireStarted.resolve()
    return finishFire.promise
  })
  const staleUpdateStarted = deferred<void>()
  const releaseStaleUpdate = deferred<void>()
  const completedExecutions: string[] = []
  let holdPendingUpdate = false
  discordPort.updateHandler = async (_reference, approval) => {
    if (holdPendingUpdate && approval.execution === "pending") {
      staleUpdateStarted.resolve()
      await releaseStaleUpdate.promise
    }
    completedExecutions.push(approval.execution)
  }

  const deciding = h.service.decide(
    web("operator"),
    "workspace",
    decision(record, { idempotencyKey: "web-grant" }),
  )
  await fireStarted.promise
  holdPendingUpdate = true
  const staleRefresh = expectOperationsError(
    () => h.service.decide(
      discord("discord-approver"),
      "adapter",
      decision(record, { idempotencyKey: "adapter-conflict" }),
    ),
    "already_resolved",
    409,
  )
  await staleUpdateStarted.promise

  finishFire.resolve({ outcome: "succeeded", detail: { status: 204, attempts: 1 } })
  await Promise.resolve()
  await Promise.resolve()
  releaseStaleUpdate.resolve()
  const [result] = await Promise.all([deciding, staleRefresh])

  expect(result.approval.execution).toBe("succeeded")
  expect(completedExecutions).toEqual(["pending", "pending", "succeeded"])
})

test("authorized adapter replay refreshes its card while unauthorized replay leaves it unchanged", async () => {
  const discordPort = new FakeNotificationPort("discord")
  const h = serviceHarness({ ports: [discordPort] })
  await h.service.activateNotificationAdapter("discord")
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  const input = decision(record, { decision: "deny", idempotencyKey: "adapter-replay" })

  const first = await h.service.decide(discord("discord-approver"), "adapter", input)
  expect(first.approval.state).toBe("denied")
  expect(discordPort.updateCalls).toHaveLength(1)

  const replay = await h.service.decide(discord("discord-approver"), "adapter", input)
  expect(replay).toEqual(first)
  expect(discordPort.updateCalls).toHaveLength(2)

  await expectOperationsError(
    () => h.service.decide(discord("discord-approver"), "adapter", {
      ...input,
      idempotencyKey: "adapter-conflict",
    }),
    "already_resolved",
    409,
  )
  expect(discordPort.updateCalls).toHaveLength(3)

  await expectOperationsError(
    () => h.service.decide(discord("not-an-approver"), "adapter", input),
    "forbidden",
    403,
  )
  expect(discordPort.updateCalls).toHaveLength(3)
})

test("service subscription preserves the stream cursor contract", async () => {
  const h = serviceHarness()
  const seen: ApprovalOperationsEvent[] = []
  const subscription = h.service.subscribe(0, event => seen.push(event))
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "succeeded" }))
  subscription.unsubscribe()
  await h.service.decide(web("operator"), "workspace", decision(record, { decision: "deny" }))

  expect(seen).toMatchObject([{
    kind: "approval_changed",
    approvalId: record.id,
    pendingCount: 1,
    sequence: 1,
  }])
})
