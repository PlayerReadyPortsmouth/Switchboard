import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvalDecisionKey } from "../hub/approval"
import { DiscordApprovalNotificationPort } from "../hub/approvalDiscordNotifications"
import { ApprovalEventStream } from "../hub/approvalEvents"
import { ApprovalPolicyRegistry, createOutboundApprovalPolicy } from "../hub/approvalPolicy"
import { SqliteApprovalHistoryRepository } from "../hub/approvalRepository"
import {
  ApprovalOperationsService,
} from "../hub/approvalService"
import type {
  ApprovalDecisionResult,
  ApprovalOrigin,
  ApprovalPrincipal,
  ApprovalRecord,
} from "../hub/approvalTypes"
import { HeldApprovalRegistry } from "../hub/heldApprovalRegistry"
import {
  captureOutboundEffect,
  executeOutboundApproval,
} from "../hub/outboundApproval"
import { matchOutbound, renderBody } from "../hub/outbound"
import { OutboundDelivery } from "../hub/outboundDelivery"
import {
  ConversationEventStream,
  ConversationService,
  SqliteConversationRepository,
  TurnCoordinator,
} from "../hub/conversations"
import type { SurfaceDeliveryResult } from "../hub/surfaces"
import type { AgentReply, AuditInput, CardSpec, OutboundRoute } from "../hub/types"

const webOperator: ApprovalPrincipal = { surface: "web", id: "operator" }
const webOwner: ApprovalPrincipal = { surface: "web", id: "owner" }
const discordApprover: ApprovalPrincipal = { surface: "discord", id: "discord-approver" }

function route(overrides: Partial<OutboundRoute> = {}): OutboundRoute {
  return {
    id: "route-1",
    url: "https://hooks.example.test/outbound",
    method: "POST",
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function promiseState(promise: Promise<unknown>): Promise<"pending" | "fulfilled" | "rejected"> {
  return await Promise.race([
    promise.then(() => "fulfilled" as const, () => "rejected" as const),
    Promise.resolve("pending" as const),
  ])
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error(message)
}

async function removeTemp(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) throw error
      await Bun.sleep(10)
    }
  }
}

class FakeDiscordApprovalGateway {
  readonly sent: Array<{ chatId: string; card: CardSpec }> = []
  readonly edited: Array<{ chatId: string; messageId: string; card: CardSpec }> = []
  private state: (state: "ready" | "disconnected") => void = () => {}
  failEdits = false

  onConnectionState(callback: (state: "ready" | "disconnected") => void): void {
    this.state = callback
  }

  emit(state: "ready" | "disconnected"): void {
    this.state(state)
  }

  async sendCard(chatId: string, card: CardSpec): Promise<string> {
    this.sent.push({ chatId, card })
    return `message-${this.sent.length}`
  }

  async editCardOrThrow(chatId: string, messageId: string, card: CardSpec): Promise<void> {
    this.edited.push({ chatId, messageId, card })
    if (this.failEdits) throw new Error("raw Discord transport detail")
  }
}

interface CompositionOptions {
  databaseFile?: string
  gateway?: FakeDiscordApprovalGateway
  approvalChannelId?: string
  approvalsEnabled?: boolean
  ttlMs?: number
  initialNow?: number
}

function compose(options: CompositionOptions = {}) {
  const db = options.databaseFile
    ? new Database(options.databaseFile, { create: true })
    : new Database(":memory:")
  // This constructor is the one migration/user_version owner for both schemas.
  const conversationRepo = new SqliteConversationRepository(db)
  const approvalRepo = new SqliteApprovalHistoryRepository(db)
  const held = new HeldApprovalRegistry()
  const policies = new ApprovalPolicyRegistry()
  policies.register(createOutboundApprovalPolicy(new Uint8Array(32).fill(7)))
  const events = new ApprovalEventStream()
  const auditRows: AuditInput[] = []
  const fetches: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  let now = options.initialNow ?? 100
  let fetchImpl: () => Promise<{ status: number }> = async () => ({ status: 204 })
  const delivery = new OutboundDelivery({
    fetch: async (url, init) => {
      fetches.push({ url, body: init.body, headers: { ...init.headers } })
      return await fetchImpl()
    },
    appendLog: () => {},
    appendDeadLetter: () => {},
    sleep: async () => {},
    now: () => now,
    secretFor: () => undefined,
    retries: 1,
  })
  const notification = options.gateway
    ? new DiscordApprovalNotificationPort(options.gateway, {
        ...(options.approvalChannelId === undefined ? {} : { channelId: options.approvalChannelId }),
      })
    : undefined
  const approvals = {
    enabled: options.approvalsEnabled ?? true,
    approvers: [discordApprover.id],
    webApprovers: [webOperator.id],
  }
  const service = new ApprovalOperationsService({
    repository: approvalRepo,
    held,
    policies,
    events,
    workspace: {
      features: { approvals: true },
      viewers: [webOwner.id],
      operators: [webOperator.id],
    },
    approvals,
    approversBySurface: { discord: approvals.approvers },
    audit: row => auditRows.push(row),
    relatedAudit: () => [],
    canViewConversation: (principal, conversationId) => (
      principal.surface === "web"
      && conversationRepo.getParticipant(conversationId, principal.id) !== null
    ),
    now: () => now,
    id: () => crypto.randomUUID(),
    ttlMs: options.ttlMs ?? 1_000,
    ...(notification === undefined ? {} : { notifications: [notification] }),
  })

  const request = async (
    outboundRoute: OutboundRoute,
    body: string,
    requestedBy: ApprovalPrincipal,
    origin?: ApprovalOrigin,
  ): Promise<ApprovalRecord> => {
    const snapshot = captureOutboundEffect(outboundRoute, body)
    return await service.request({
      kind: "outbound",
      target: snapshot.route.id,
      requestedBy,
      ...(origin === undefined ? {} : { origin }),
      summary: `${snapshot.route.method ?? "POST"} → ${snapshot.route.id}`,
      detail: snapshot,
    }, correlationId => executeOutboundApproval({
      route: snapshot.route,
      body: snapshot.body,
      actor: `${requestedBy.surface}:${requestedBy.id}`,
      correlationId,
      deliver: (capturedRoute, capturedBody) => delivery.deliver(capturedRoute, capturedBody),
      audit: row => auditRows.push(row),
    }))
  }

  const dispatch = async (
    outboundRoute: OutboundRoute,
    body: string,
    requestedBy: ApprovalPrincipal,
    origin?: ApprovalOrigin,
  ) => {
    if (approvals.enabled && outboundRoute.requireApproval) {
      return { kind: "approval" as const, approval: await request(outboundRoute, body, requestedBy, origin) }
    }
    const snapshot = captureOutboundEffect(outboundRoute, body)
    return {
      kind: "direct" as const,
      execution: await executeOutboundApproval({
        route: snapshot.route,
        body: snapshot.body,
        actor: `${requestedBy.surface}:${requestedBy.id}`,
        deliver: (capturedRoute, capturedBody) => delivery.deliver(capturedRoute, capturedBody),
        audit: row => auditRows.push(row),
      }),
    }
  }

  return {
    db,
    conversationRepo,
    approvalRepo,
    service,
    held,
    auditRows,
    fetches,
    request,
    dispatch,
    setNow(value: number) { now = value },
    setFetch(value: () => Promise<{ status: number }>) { fetchImpl = value },
  }
}

function decision(
  approval: ApprovalRecord,
  principal: ApprovalPrincipal,
  decisionValue: "grant" | "deny" = "grant",
  interactionId?: string,
) {
  return {
    approvalId: approval.id,
    decision: decisionValue,
    expectedVersion: String(approval.version),
    idempotencyKey: principal.surface === "discord"
      ? approvalDecisionKey(
          interactionId,
          approval.id,
          String(approval.version),
          decisionValue,
          principal,
        )
      : `web:${principal.id}:${approval.id}:${approval.version}:${decisionValue}`,
  }
}

function verifiedCanonicalOrigin(
  repo: SqliteConversationRepository,
  conversationId: string,
): ApprovalOrigin {
  const fallback = repo.listTransportLinks(conversationId)
    .filter(link => link.adapter === "discord" && link.enabled)
    .sort((left, right) => left.id.localeCompare(right.id))[0]
  return {
    conversationId,
    ...(fallback === undefined
      ? {}
      : { surface: "discord", externalLocation: fallback.externalLocationId }),
  }
}

async function acceptCanonicalAgentReply(
  h: ReturnType<typeof compose>,
  coordinator: TurnCoordinator,
  reply: AgentReply,
  routes: OutboundRoute[],
): Promise<Awaited<ReturnType<TurnCoordinator["acceptAgentReply"]>>> {
  if (reply.kind !== "reply" || !reply.text) return await coordinator.acceptAgentReply(reply)
  const conversation = h.conversationRepo.getConversation(reply.chatId)
  if (!conversation) return await coordinator.acceptAgentReply(reply)
  const matches = matchOutbound(reply.text, routes).map(({ route: matchedRoute, groups }) => ({
    route: matchedRoute,
    snapshot: captureOutboundEffect(
      matchedRoute,
      renderBody(matchedRoute.template, { groups }),
    ),
  }))
  const accepted = await coordinator.acceptAgentReply(reply, {
    suppressSurfaceDelivery: matches.some(match => match.route.consume === true),
  })
  if (accepted && !("closed" in accepted) && accepted.inserted) {
    const origin = verifiedCanonicalOrigin(h.conversationRepo, conversation.id)
    await Promise.all(matches.map(match => h.request(
      match.snapshot.route,
      match.snapshot.body,
      { surface: "agent", id: reply.agent },
      origin,
    )))
  }
  return accepted
}

function wireDiscordLifecycle(
  h: ReturnType<typeof compose>,
  gateway: FakeDiscordApprovalGateway,
): Promise<void>[] {
  const activations: Promise<void>[] = []
  gateway.onConnectionState(state => {
    if (state === "disconnected") {
      h.service.deactivateNotificationAdapter("discord")
      return
    }
    const activation = h.service.activateNotificationAdapter("discord").catch(() => {
      h.auditRows.push({
        kind: "approval",
        actor: "hub",
        action: "approval_notification_activation_failed",
        outcome: "error",
        target: "discord",
      })
    })
    activations.push(activation)
  })
  return activations
}

test("production source composes one reconciled SQLite approval lifecycle before every producer", async () => {
  const source = readFileSync(join(import.meta.dir, "..", "hub", "index.ts"), "utf8")
  const audit = source.indexOf("const audit = new AuditLog")
  const database = source.indexOf("const conversationDb = new Database")
  const approvalRepository = source.indexOf("new SqliteApprovalHistoryRepository")
  const reconcile = source.indexOf("await approvalService.reconcileStartup()")
  const transport = source.indexOf("for (const [name, cfg] of Object.entries(agents))")
  const webhook = source.indexOf("const listener = startWebhookListener")
  const cron = source.indexOf("const cronTick = startCron")

  expect((source.match(/new Database\(/g) ?? [])).toHaveLength(1)
  expect((source.match(/new SqliteConversationRepository\(/g) ?? [])).toHaveLength(1)
  expect((source.match(/new SqliteApprovalHistoryRepository\(/g) ?? [])).toHaveLength(1)
  expect(audit).toBeLessThan(database)
  expect(database).toBeLessThan(approvalRepository)
  expect(approvalRepository).toBeLessThan(reconcile)
  expect(reconcile).toBeLessThan(transport)
  expect(reconcile).toBeLessThan(webhook)
  expect(reconcile).toBeLessThan(cron)
  expect(source).not.toContain("new ApprovalRegistry")
  expect(source).not.toContain("approvalRegistry.")
  expect(source).not.toContain("approvalCards")

  const h = compose()
  try {
    expect(h.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
    const tables = h.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversations','approval_records') ORDER BY name",
    ).all().map(row => row.name)
    expect(tables).toEqual(["approval_records", "conversations"])
  } finally {
    h.db.close(false)
  }
})

test("gated routes wait for a web grant while disabled-core and ungated routes remain direct", async () => {
  const h = compose()
  const disabled = compose({ approvalsEnabled: false })
  try {
    expect((await h.dispatch(route({ id: "ungated" }), "direct", { surface: "agent", id: "qa" })).kind).toBe("direct")
    expect(h.fetches).toHaveLength(1)
    expect((await disabled.dispatch(route({ id: "disabled", requireApproval: true }), "disabled", { surface: "agent", id: "qa" })).kind).toBe("direct")
    expect(disabled.fetches).toHaveLength(1)

    const gated = await h.dispatch(
      route({ id: "gated", requireApproval: true }),
      "held body",
      { surface: "agent", id: "qa" },
    )
    if (gated.kind !== "approval") throw new Error("expected an approval")
    expect(gated.approval.state).toBe("pending")
    expect(h.fetches).toHaveLength(1)
    expect(h.service.get(webOperator, "workspace", gated.approval.id).state).toBe("pending")

    const fetch = deferred<{ status: number }>()
    h.setFetch(() => fetch.promise)
    const grant = h.service.decide(webOperator, "workspace", decision(gated.approval, webOperator))
    await waitFor(() => h.fetches.length === 2, "approved delivery did not start")
    expect(await promiseState(grant)).toBe("pending")
    fetch.resolve({ status: 204 })
    await expect(grant).resolves.toMatchObject({
      approval: { state: "granted", execution: "succeeded", executionDetail: { status: 204, attempts: 1 } },
    })
    expect(h.fetches).toHaveLength(2)
  } finally {
    h.db.close(false)
    disabled.db.close(false)
  }
})

test("canonical commit precedes approval registration and only server-owned links add provenance", async () => {
  const h = compose()
  let now = 1_000
  let id = 0
  const conversationEvents = new ConversationEventStream(() => [])
  const conversationService = new ConversationService(
    h.conversationRepo,
    () => ++now,
    () => `conversation-${++id}`,
    conversationEvents,
  )
  const conversation = conversationService.create("owner", { title: "Canonical", primaryAgent: "qa" })
  h.conversationRepo.createTransportLink({
    id: "discord-link",
    conversationId: conversation.id,
    adapter: "discord",
    externalLocationId: "origin-room",
    label: null,
    syncMode: "two_way",
    enabled: true,
  }, ++now)
  let surfaceDeliveries = 0
  const coordinator = new TurnCoordinator(
    conversationService,
    h.conversationRepo,
    { dispatch: () => true },
    conversationEvents,
    {
      async deliver(_message, links): Promise<SurfaceDeliveryResult[]> {
        surfaceDeliveries += links.length
        return links.map((link, index) => ({
          deliveryId: `delivery-${index}`,
          adapter: link.adapter,
          ok: true,
        }))
      },
    },
    () => ++now,
    () => `turn-${++id}`,
  )
  const gatedConsume = route({
    id: "canonical-trigger",
    pattern: "approve (.+)",
    template: "{\"value\":\"$1\"}",
    requireApproval: true,
    consume: true,
  })
  const reply: AgentReply = {
    agent: "qa",
    kind: "reply",
    chatId: conversation.id,
    correlationId: "canonical-reply",
    text: "approve exact",
  }

  try {
    const accepted = await acceptCanonicalAgentReply(h, coordinator, reply, [gatedConsume])
    expect(accepted && !("closed" in accepted) && accepted.inserted).toBe(true)
    expect(h.conversationRepo.listMessages(conversation.id).map(message => message.content)).toEqual(["approve exact"])
    expect(surfaceDeliveries).toBe(0)
    expect(h.approvalRepo.pendingCount()).toBe(1)
    const canonical = h.service.list(webOwner, "workspace", { group: "pending" }).items[0]!
    expect(canonical.conversationId).toBe(conversation.id)
    expect(h.fetches).toEqual([])

    const duplicate = await acceptCanonicalAgentReply(h, coordinator, reply, [gatedConsume])
    expect(duplicate && !("closed" in duplicate) && duplicate.inserted).toBe(false)
    expect(h.approvalRepo.pendingCount()).toBe(1)

    const originalAppend = conversationService.appendAgentMessage.bind(conversationService)
    ;(conversationService as unknown as { appendAgentMessage: typeof originalAppend }).appendAgentMessage = () => {
      throw new Error("commit failed")
    }
    await expect(acceptCanonicalAgentReply(h, coordinator, {
      ...reply,
      correlationId: "failed-canonical-reply",
    }, [gatedConsume])).rejects.toThrow("commit failed")
    ;(conversationService as unknown as { appendAgentMessage: typeof originalAppend }).appendAgentMessage = originalAppend
    expect(h.approvalRepo.pendingCount()).toBe(1)

    const legacyLink = h.conversationRepo.resolveTransportLink("discord", "origin-room")
    const legacy = await h.request(
      route({ id: "legacy-trigger", requireApproval: true }),
      "legacy",
      { surface: "agent", id: "qa" },
      {
        ...(legacyLink === null ? {} : { conversationId: legacyLink.conversationId }),
        surface: "discord",
        externalLocation: "origin-room",
      },
    )
    const tool = await h.request(
      route({ id: "tool-trigger", requireApproval: true }),
      "tool",
      { surface: "agent", id: "qa" },
    )
    const event = await h.request(
      route({ id: "hub-event", requireApproval: true }),
      "event",
      { surface: "hub", id: "hub" },
    )
    expect(h.service.get(webOwner, "workspace", legacy.id).conversationId).toBe(conversation.id)
    expect(h.service.get(webOwner, "workspace", tool.id).conversationId).toBeUndefined()
    expect(h.service.get(webOwner, "workspace", event.id).conversationId).toBeUndefined()
  } finally {
    await coordinator.drainDeliveries()
    h.db.close(false)
  }
})

test("web and Discord decisions race through one SQLite winner and non-approvers are safely denied", async () => {
  const h = compose({ ttlMs: 10 })
  try {
    const raced = await h.request(route({ id: "raced", requireApproval: true }), "race", { surface: "agent", id: "qa" })
    const results = await Promise.allSettled([
      h.service.decide(webOperator, "workspace", decision(raced, webOperator)),
      h.service.decide(discordApprover, "adapter", decision(raced, discordApprover, "grant", "interaction-1")),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    expect(h.fetches).toHaveLength(1)
    expect(h.approvalRepo.getVisible(raced.id)).toMatchObject({ state: "granted", execution: "succeeded" })

    const denied = await h.request(route({ id: "denied-attempt", requireApproval: true }), "deny", { surface: "agent", id: "qa" })
    const outsider = { surface: "discord", id: "outsider" }
    await expect(Promise.resolve().then(() => (
      h.service.decide(outsider, "adapter", decision(denied, outsider, "grant", "interaction-2"))
    )))
      .rejects.toMatchObject({ code: "forbidden" })
    expect(h.approvalRepo.getVisible(denied.id)?.state).toBe("pending")
    expect(h.auditRows).toContainEqual(expect.objectContaining({
      kind: "approval",
      actor: "discord:outsider",
      action: "approval_decision_forbidden",
      outcome: "deny",
      corr: denied.id,
    }))

    const boundary = await h.request(route({ id: "boundary", requireApproval: true }), "boundary", { surface: "agent", id: "qa" })
    h.setNow(boundary.expiresAt)
    const boundaryResults = await Promise.allSettled([
      h.service.decide(webOperator, "workspace", decision(boundary, webOperator)),
      h.service.expireDue(),
    ])
    expect(boundaryResults.some(result => result.status === "fulfilled")).toBe(true)
    const terminal = h.approvalRepo.getVisible(boundary.id)!
    expect(["expired", "granted"]).toContain(terminal.state)
    expect(terminal.state === "granted" ? terminal.execution !== "pending" : terminal.execution === "not_applicable").toBe(true)
    expect(h.fetches.length).toBeLessThanOrEqual(2)
  } finally {
    h.db.close(false)
  }
})

test("Discord readiness defers origin cards and backfills once across disconnect and resume", async () => {
  const gateway = new FakeDiscordApprovalGateway()
  const h = compose({ gateway })
  const activations = wireDiscordLifecycle(h, gateway)
  try {
    const beforeLogin = await h.request(
      route({ id: "before-login", requireApproval: true }),
      "one",
      { surface: "agent", id: "qa" },
      { surface: "discord", externalLocation: "origin-before-login" },
    )
    expect(beforeLogin.state).toBe("pending")
    expect(gateway.sent).toEqual([])

    gateway.emit("ready")
    await activations.at(-1)
    expect(gateway.sent.map(item => item.chatId)).toEqual(["origin-before-login"])
    gateway.emit("ready")
    await activations.at(-1)
    expect(gateway.sent).toHaveLength(1)

    gateway.emit("disconnected")
    const disconnected = await h.request(
      route({ id: "while-disconnected", requireApproval: true }),
      "two",
      { surface: "agent", id: "qa" },
      { surface: "discord", externalLocation: "origin-while-disconnected" },
    )
    expect(disconnected.state).toBe("pending")
    expect(gateway.sent).toHaveLength(1)

    gateway.emit("ready")
    await activations.at(-1)
    expect(gateway.sent.map(item => item.chatId)).toEqual([
      "origin-before-login",
      "origin-while-disconnected",
    ])
    expect(h.approvalRepo.listNotifications()).toHaveLength(2)
  } finally {
    h.db.close(false)
  }
})

test("restart interrupts lifecycle and execution rows, refreshes stale cards safely, and never replays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-phase4-approval-"))
  const file = join(dir, "state.sqlite")
  const firstGateway = new FakeDiscordApprovalGateway()
  const first = compose({ databaseFile: file, gateway: firstGateway })
  const firstActivations = wireDiscordLifecycle(first, firstGateway)
  const delivery = deferred<{ status: number }>()
  let pending!: ApprovalRecord
  let executing!: ApprovalRecord
  let decisionPromise!: Promise<ApprovalDecisionResult>
  try {
    await first.service.reconcileStartup()
    firstGateway.emit("ready")
    await firstActivations.at(-1)
    pending = await first.request(
      route({ id: "pending-at-crash", requireApproval: true }),
      "pending",
      { surface: "agent", id: "qa" },
      { surface: "discord", externalLocation: "origin" },
    )
    executing = await first.request(
      route({ id: "executing-at-crash", requireApproval: true }),
      "executing",
      { surface: "agent", id: "qa" },
      { surface: "discord", externalLocation: "origin" },
    )
    first.setFetch(() => delivery.promise)
    decisionPromise = first.service.decide(webOperator, "workspace", decision(executing, webOperator))
    void decisionPromise.catch(() => {})
    await waitFor(
      () => first.approvalRepo.getVisible(executing.id)?.execution === "pending" && first.fetches.length === 1,
      "execution never reached the crash boundary",
    )
    first.db.close(false)

    const secondGateway = new FakeDiscordApprovalGateway()
    secondGateway.failEdits = true
    const second = compose({ databaseFile: file, gateway: secondGateway })
    try {
      const reconciliation = await second.service.reconcileStartup()
      expect(reconciliation.lifecycleInterrupted.map(record => record.id)).toContain(pending.id)
      expect(reconciliation.executionInterrupted.map(record => record.id)).toContain(executing.id)
      expect(second.approvalRepo.getVisible(pending.id)).toMatchObject({ state: "interrupted", execution: "not_applicable" })
      expect(second.approvalRepo.getVisible(executing.id)).toMatchObject({ state: "granted", execution: "interrupted" })
      expect(second.fetches).toEqual([])

      await expect(second.service.activateNotificationAdapter("discord")).resolves.toBeUndefined()
      expect(secondGateway.sent).toEqual([])
      expect(secondGateway.edited.length).toBeGreaterThan(0)
      expect(second.auditRows).toContainEqual(expect.objectContaining({
        kind: "approval",
        action: "approval_notification_update_failed",
        outcome: "error",
        target: "discord",
      }))
      expect(JSON.stringify(second.auditRows)).not.toContain("raw Discord transport detail")
    } finally {
      second.db.close(false)
    }

    delivery.resolve({ status: 204 })
    await decisionPromise.catch(() => undefined)
  } finally {
    try { first.db.close(false) } catch {}
    await removeTemp(dir)
  }
})

test("stable Discord keys bind the parsed version and all decision inputs", () => {
  const first = approvalDecisionKey(undefined, "approval-1", "2", "grant", discordApprover)
  expect(first).toBe(approvalDecisionKey(undefined, "approval-1", "2", "grant", discordApprover))
  expect(first).not.toBe(approvalDecisionKey(undefined, "approval-1", "3", "grant", discordApprover))
  expect(first).not.toBe(approvalDecisionKey(undefined, "approval-1", "2", "deny", discordApprover))
  expect(first).toBe(`discord:fallback:${createHash("sha256").update(JSON.stringify([
    "approval-1", "2", "grant", "discord", "discord-approver",
  ])).digest("hex")}`)
})
