import { test, expect } from "bun:test"
import { handleWebRequest, startWebServer } from "../hub/webServer"
import type { WebInput, DashboardJson } from "../hub/web"
import type { WebDeps } from "../hub/webServer"
import type { AgentConfig } from "../hub/types"
import type { WorkspaceAssetHandler } from "../hub/webAssets"
import { AgentOperationsError } from "../hub/operations/agentService"
import { ApprovalOperationsError, ApprovalOperationsService } from "../hub/approvalService"
import type { ApprovalDetailView, ApprovalListPage, ApprovalSummaryView } from "../hub/approvalTypes"
import type { ApprovalOperationsEvent } from "../hub/approvalEvents"

const baseInput = (): WebInput => ({
  now: 1000, startedAt: 0,
  status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
  audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
  recent: [], pendingApprovals: 2,
})

const approvalSummary = (overrides: Partial<ApprovalSummaryView> = {}): ApprovalSummaryView => ({
  id: "approval-1",
  version: "2",
  kind: "outbound",
  target: "route-a",
  summary: "Deploy route A",
  risk: "elevated",
  requestedBy: { surface: "agent", id: "qa" },
  createdAt: 100,
  expiresAt: 200,
  terminalAt: null,
  state: "pending",
  execution: "not_applicable",
  ...overrides,
})

const approvalDetail = (overrides: Partial<ApprovalDetailView> = {}): ApprovalDetailView => ({
  ...approvalSummary(),
  detail: { method: "POST" },
  executionDetail: null,
  decisionBy: null,
  decisionAt: null,
  outcomeReason: null,
  executionStartedAt: null,
  executionFinishedAt: null,
  audit: [],
  permissions: { canDecide: true },
  ...overrides,
})

const approvalPage = (overrides: Partial<ApprovalListPage> = {}): ApprovalListPage => ({
  items: [approvalSummary()],
  nextCursor: null,
  pendingCount: 2,
  querySummary: { count: 2, highestRisk: "elevated", nearestExpiry: 200, firstId: "approval-1" },
  ...overrides,
})

type FakeApprovalOperations = Pick<ApprovalOperationsService, "session" | "list" | "get" | "decide" | "subscribe">

function fakeApprovalOperations(overrides: Partial<FakeApprovalOperations> = {}): FakeApprovalOperations {
  return {
    session: () => ({ feature: true, coreEnabled: true, role: "operator", canDecide: true, pendingCount: 2 }),
    list: () => approvalPage(),
    get: () => approvalDetail(),
    decide: async () => ({ approval: approvalDetail({
      version: "3", terminalAt: 150, state: "granted", execution: "succeeded",
      decisionBy: { surface: "web", id: "operator@example.com" }, decisionAt: 150,
      executionStartedAt: 150, executionFinishedAt: 151,
    }) }),
    subscribe: () => ({ unsubscribe() {} }),
    ...overrides,
  }
}

function fakeDeps(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    collect: baseInput,
    requireUser: (req) => req.headers.get("x-switchboard-user"),
    approvalOperations: fakeApprovalOperations(),
    listChannels: () => [],
    fetchChannelHistory: async () => [],
    fetchChannelTimeline: async () => [],
    subscribeChannel: () => () => {},
    sendChannelMessage: async () => {},
    runCommand: async () => null,
    agentOperations: {
      list: () => [],
      get: () => { throw new AgentOperationsError(404, "not_found") },
      listLegacyConfigs: () => ({}),
      previewLegacyConfig: async () => ({ id: "prev-1", before: null, after: null, classification: { tier: "safe", fullRestart: [] } }),
      confirmLegacyConfig: async () => { throw new AgentOperationsError(409, "preview_not_found") },
      previewConfig: async () => ({ id: "prev-1", before: null, after: null, classification: { tier: "safe", fullRestart: [] }, expiresAt: 1_000 }),
      confirmConfig: async () => ({ state: "applied", restarted: [], fullRestart: [] }),
      previewAction: () => ({ id: "action-1", actor: "a@b.com", agent: "qa", action: "reset", statusVersion: "v1", impact: { busy: false, queueDepth: 0 }, expiresAt: 1_000 }),
      confirmAction: async () => ({ state: "applied", agent: "qa", action: "reset" }),
      subscribe: () => ({ unsubscribe() {} }),
    },
    agentSessionAccess: () => ({ feature: true, role: "operator" }),
    listHubConfig: async () => ({ routerModel: "claude-haiku-4-5" }),
    previewHubConfigChange: async () => ({ id: "hubprev-1", before: {}, after: {}, classification: { tier: "safe", fullRestart: [] } }),
    confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }),
    ...overrides,
  }
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "GET", headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
const del = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "DELETE", headers })
const auth = { "x-switchboard-user": "operator@example.com" }

test("web server exposes asynchronous stop completion", () => {
  const start: (port: number, deps: WebDeps, host?: string) => { stop: () => Promise<void> } | null = startWebServer
  expect(start).toBe(startWebServer)
})

test("GET / without built workspace → 503", async () => {
  const res = await handleWebRequest(get("/"), fakeDeps())
  expect(res.status).toBe(503)
})

test("root uses workspace assets and legacy keeps the embedded dashboard", async () => {
  const workspace: WorkspaceAssetHandler = async path => path === "/" ? new Response("workspace") : null
  expect(await (await handleWebRequest(new Request("http://x/"), fakeDeps(), workspace)).text()).toBe("workspace")
  expect(await (await handleWebRequest(new Request("http://x/legacy"), fakeDeps(), workspace)).text()).toContain("Switchboard")
})

test("unauthenticated status exposes only the aggregate approval count", async () => {
  const response = await handleWebRequest(get("/api/status"), fakeDeps())
  expect(response.status).toBe(200)
  const body = await response.json() as DashboardJson & Record<string, unknown>
  expect(body.status).toBe("ok")
  expect(body.pendingApprovals).toBe(2)
  expect(body).not.toHaveProperty("pendingApprovalList")
  expect(JSON.stringify(body)).not.toContain("approval-1")
})

test("POST / → 405, unknown non-API GET → 503", async () => {
  expect((await handleWebRequest(post("/", {}, { "x-switchboard-user": "a@b.com" }), fakeDeps())).status).toBe(405)
  expect((await handleWebRequest(get("/nope"), fakeDeps())).status).toBe(503)
})

test("approval routes authenticate before method dispatch", async () => {
  const guarded = [
    ["/api/operations/approvals", "DELETE"],
    ["/api/operations/approvals/approval-1", "POST"],
    ["/api/operations/approvals/approval-1/decision", "GET"],
    ["/api/operations/approvals/events", "POST"],
    ["/api/approvals", "DELETE"],
    ["/api/approvals/approval-1", "GET"],
  ] as const
  for (const [path, method] of guarded) {
    const hidden = await handleWebRequest(new Request(`http://hub${path}`, { method }), fakeDeps())
    expect(hidden.status).toBe(400)
    expect(hidden.headers.get("cache-control")).toBe("no-store")
    expect(await hidden.json()).toEqual({ error: "missing_identity" })
    const known = await handleWebRequest(new Request(`http://hub${path}`, { method, headers: auth }), fakeDeps())
    expect(known.status).toBe(405)
  }
})

test("workspace and compatibility lists use trusted web principals and distinct contexts", async () => {
  const sessions: unknown[] = []
  const lists: unknown[] = []
  const operations = fakeApprovalOperations({
    session: (principal, context) => {
      sessions.push(principal, context)
      return principal.id === "hidden@example.com"
        ? { feature: false, coreEnabled: true, role: "hidden", canDecide: false, pendingCount: 0 }
        : { feature: false, coreEnabled: true, role: "operator", canDecide: true, pendingCount: 2 }
    },
    list: (principal, context, query) => {
      lists.push(principal, context, query)
      return approvalPage()
    },
  })
  const deps = fakeDeps({ approvalOperations: operations })

  const disabledWorkspace = await handleWebRequest(get("/api/operations/approvals?group=pending", auth), deps)
  expect(disabledWorkspace.status).toBe(404)
  expect(disabledWorkspace.headers.get("cache-control")).toBe("no-store")
  const legacy = await handleWebRequest(get("/api/approvals", auth), deps)
  expect(legacy.status).toBe(200)
  expect(legacy.headers.get("cache-control")).toBe("no-store")
  const hiddenLegacy = await handleWebRequest(get("/api/approvals", { "x-switchboard-user": "hidden@example.com" }), deps)
  expect(hiddenLegacy.status).toBe(404)
  expect(sessions).toEqual([
    { surface: "web", id: "operator@example.com" }, "workspace",
    { surface: "web", id: "operator@example.com" }, "legacy",
    { surface: "web", id: "hidden@example.com" }, "legacy",
  ])
  expect(lists).toEqual([
    { surface: "web", id: "operator@example.com" }, "legacy", { group: "pending" },
  ])
})

test("operations list decodes the complete filter contract exactly", async () => {
  const seen: unknown[] = []
  const deps = fakeDeps({ approvalOperations: fakeApprovalOperations({
    list: (principal, context, query) => { seen.push(principal, context, query); return approvalPage({ querySummary: null }) },
  }) })
  const response = await handleWebRequest(get(
    "/api/operations/approvals?group=history&state=denied&risk=elevated&kind=outbound%2Fweb&requester=agent%3Aqa%40example.com&conversationId=conversation%2F1&createdFrom=-1&createdTo=2&decisionFrom=3&decisionTo=4&search=%3Cscript%3E&cursor=opaque%2Bcursor&limit=1",
    auth,
  ), deps)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(seen).toEqual([
    { surface: "web", id: "operator@example.com" },
    "workspace",
    {
      group: "history", state: "denied", risk: "elevated", kind: "outbound/web",
      requester: "agent:qa@example.com", conversationId: "conversation/1",
      createdFrom: -1, createdTo: 2, decisionFrom: 3, decisionTo: 4,
      search: "<script>", cursor: "opaque+cursor", limit: 1,
    },
  ])
})

test("pending list returns the query-scoped aggregate while history returns null", async () => {
  const aggregate = { count: 8, highestRisk: "destructive" as const, nearestExpiry: 123, firstId: "approval-first" }
  const deps = fakeDeps({ approvalOperations: fakeApprovalOperations({
    list: (_principal, _context, query) => approvalPage({
      items: [approvalSummary()],
      querySummary: query.group === "pending" ? aggregate : null,
    }),
  }) })
  const pending = await handleWebRequest(get("/api/operations/approvals?group=pending&limit=1", auth), deps)
  expect((await pending.json()).querySummary).toEqual(aggregate)
  const history = await handleWebRequest(get("/api/operations/approvals?group=history&state=granted&limit=1", auth), deps)
  expect((await history.json()).querySummary).toBeNull()
})

test("approval filters, cursors, duplicate keys, and URI decoding fail safely", async () => {
  const invalid = [
    "/api/operations/approvals",
    "/api/operations/approvals?group=unknown",
    "/api/operations/approvals?group=pending&state=granted",
    "/api/operations/approvals?group=history&state=pending",
    "/api/operations/approvals?group=pending&risk=critical",
    "/api/operations/approvals?group=pending&requester=missing-surface",
    "/api/operations/approvals?group=pending&createdFrom=1.5",
    "/api/operations/approvals?group=pending&createdFrom=2&createdTo=1",
    "/api/operations/approvals?group=pending&limit=0",
    "/api/operations/approvals?group=pending&group=history",
    "/api/operations/approvals?group=pending&unknown=value",
    "/api/operations/approvals?group=pending&kind=%E0%A4%A",
  ]
  for (const path of invalid) {
    const response = await handleWebRequest(get(path, auth), fakeDeps())
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: "invalid_request", recovery: "none" })
  }

  const malformedCursor = await handleWebRequest(get("/api/operations/approvals?group=pending&cursor=bad", auth), fakeDeps({
    approvalOperations: fakeApprovalOperations({ list: () => { throw new ApprovalOperationsError(400, "invalid_cursor", "none") } }),
  }))
  expect(malformedCursor.status).toBe(400)
  expect(await malformedCursor.json()).toEqual({ error: "invalid_cursor", recovery: "none" })

  const malformedId = await handleWebRequest(get("/api/operations/approvals/%E0%A4%A", auth), fakeDeps())
  expect(malformedId.status).toBe(400)
  expect(await malformedId.json()).toEqual({ error: "invalid_request", recovery: "none" })
})

test("hidden approval callers receive 404 before query, URI, body, or SSE cursor probing", async () => {
  const calls: string[] = []
  const approvalOperations = fakeApprovalOperations({
    session: () => ({ feature: false, coreEnabled: false, role: "hidden", canDecide: false, pendingCount: 0 }),
    list: () => { calls.push("list"); return approvalPage() },
    get: () => { calls.push("get"); return approvalDetail() },
    decide: async () => { calls.push("decide"); return { approval: approvalDetail() } },
    subscribe: () => { calls.push("subscribe"); return { unsubscribe() {} } },
  })
  const deps = fakeDeps({ approvalOperations })
  const hidden = { "x-switchboard-user": "hidden@example.com" }
  const requests = [
    get("/api/operations/approvals?group=invalid", hidden),
    get("/api/operations/approvals/%E0%A4%A", hidden),
    new Request("http://hub/api/operations/approvals/approval-1/decision", {
      method: "POST", headers: { ...hidden, "content-type": "text/plain" }, body: "bad",
    }),
    get("/api/operations/approvals/events?after=invalid", hidden),
    get("/api/approvals?unknown=value", hidden),
  ]
  for (const request of requests) {
    const response = await handleWebRequest(request, deps)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "not_found", recovery: "none" })
  }
  expect(calls).toEqual([])
})

test("approval detail decodes the ID and returns canonical no-store JSON", async () => {
  const seen: unknown[] = []
  const detail = approvalDetail({ id: "approval/1" })
  const response = await handleWebRequest(get("/api/operations/approvals/approval%2F1", auth), fakeDeps({
    approvalOperations: fakeApprovalOperations({ get: (principal, context, id) => { seen.push(principal, context, id); return detail } }),
  }))
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual(detail)
  expect(seen).toEqual([{ surface: "web", id: "operator@example.com" }, "workspace", "approval/1"])
})

test("workspace and compatibility decisions forward trusted principal, opaque version, and key", async () => {
  const seen: unknown[] = []
  const operations = fakeApprovalOperations({
    decide: async (principal, context, input) => { seen.push(principal, context, input); return { approval: approvalDetail({ id: input.approvalId }) } },
  })
  const deps = fakeDeps({ approvalOperations: operations })
  const workspace = await handleWebRequest(post(
    "/api/operations/approvals/approval%2F1/decision",
    { decision: "grant", expectedVersion: "opaque-v2", actor: "attacker@example.com" },
    { ...auth, "Idempotency-Key": "attempt-1" },
  ), deps)
  const legacy = await handleWebRequest(post(
    "/api/approvals/approval%2F1",
    { decision: "deny", expectedVersion: "opaque-v3" },
    { ...auth, "Idempotency-Key": "attempt-2" },
  ), deps)
  expect(workspace.status).toBe(200)
  expect(legacy.status).toBe(200)
  expect(workspace.headers.get("cache-control")).toBe("no-store")
  expect(seen).toEqual([
    { surface: "web", id: "operator@example.com" }, "workspace",
    { approvalId: "approval/1", decision: "grant", expectedVersion: "opaque-v2", idempotencyKey: "attempt-1" },
    { surface: "web", id: "operator@example.com" }, "legacy",
    { approvalId: "approval/1", decision: "deny", expectedVersion: "opaque-v3", idempotencyKey: "attempt-2" },
  ])
})

test("approval decisions require JSON, a grant/deny decision, opaque version, and nonblank key", async () => {
  const requests = [
    post("/api/operations/approvals/approval-1/decision", { decision: "grant", expectedVersion: "2" }, auth),
    post("/api/operations/approvals/approval-1/decision", { decision: "grant", expectedVersion: "2" }, { ...auth, "Idempotency-Key": "   " }),
    post("/api/operations/approvals/approval-1/decision", { decision: "grant" }, { ...auth, "Idempotency-Key": "key" }),
    post("/api/operations/approvals/approval-1/decision", { decision: "grant", expectedVersion: " " }, { ...auth, "Idempotency-Key": "key" }),
    post("/api/operations/approvals/approval-1/decision", { decision: "approve", expectedVersion: "2" }, { ...auth, "Idempotency-Key": "key" }),
    new Request("http://hub/api/operations/approvals/approval-1/decision", { method: "POST", headers: { ...auth, "Idempotency-Key": "key", "content-type": "text/plain" }, body: "{}" }),
    new Request("http://hub/api/operations/approvals/approval-1/decision", { method: "POST", headers: { ...auth, "Idempotency-Key": "key", "content-type": "application/json" }, body: "{" }),
  ]
  for (const request of requests) {
    const response = await handleWebRequest(request, fakeDeps())
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: "invalid_request", recovery: "none" })
  }
})

test("approval decisions authorize visible viewers before parsing attacker-controlled input", async () => {
  const gets: unknown[] = []
  const audits: unknown[] = []
  const service = new ApprovalOperationsService({
    repository: {
      getVisible: () => ({
        id: "approval-1", version: 2, kind: "outbound", target: "route-a", summary: "Deploy route A",
        detail: { method: "POST" }, requestedBy: { surface: "agent", id: "qa" }, originConversationId: null,
        risk: "elevated", effectFingerprint: "f".repeat(64), createdAt: 100, expiresAt: 200,
        terminalAt: null, state: "pending", decisionBy: null, decisionAt: null, decisionKey: null,
        outcomeReason: null, execution: "not_applicable", executionDetail: null, executionStartedAt: null,
        executionFinishedAt: null, correlationId: "corr-approval-1",
      }),
      pendingCount: () => 2,
    } as any,
    held: {} as any,
    policies: {} as any,
    events: {} as any,
    workspace: { features: { approvals: true }, viewers: ["operator@example.com"], operators: [] },
    approvals: { enabled: true },
    approversBySurface: {},
    audit: input => { audits.push(input) },
    relatedAudit: () => [],
    canViewConversation: () => false,
    now: () => 100,
    id: () => "unused",
    ttlMs: 1_000,
  })
  const approvalOperations = fakeApprovalOperations({
    session: () => ({ feature: true, coreEnabled: true, role: "viewer", canDecide: false, pendingCount: 2 }),
    get: (principal, context, id) => {
      gets.push([principal, context, id])
      return approvalDetail({ permissions: { canDecide: false } })
    },
    decide: service.decide.bind(service),
  })
  for (const path of [
    "/api/operations/approvals/approval-1/decision",
    "/api/approvals/approval-1",
  ]) {
    const requests = [
      new Request(`http://hub${path}`, { method: "POST", headers: auth, body: "{}" }),
      post(path, { decision: "grant", expectedVersion: "2" }, auth),
      new Request(`http://hub${path}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": "key" },
        body: "{",
      }),
    ]
    for (const request of requests) {
      const response = await handleWebRequest(request, fakeDeps({ approvalOperations }))
      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ error: "forbidden", recovery: "none" })
    }
  }
  expect(gets).toHaveLength(6)
  expect(audits).toEqual(Array.from({ length: 6 }, () => ({
    kind: "approval",
    actor: "web:operator@example.com",
    action: "approval_decision_forbidden",
    outcome: "deny",
    corr: "corr-approval-1",
  })))
})

test("approval decision errors are safe, typed, and expose canonical state only when authorized", async () => {
  const canonical = approvalDetail({ version: "3", state: "denied", terminalAt: 150 })
  const cases = [
    [new ApprovalOperationsError(403, "forbidden", "none"), 403, { error: "forbidden", recovery: "none" }],
    [new ApprovalOperationsError(404, "not_found", "none"), 404, { error: "not_found", recovery: "none" }],
    [new ApprovalOperationsError(409, "stale_version", "reload", canonical), 409, { error: "stale_version", recovery: "reload", canonical }],
    [new ApprovalOperationsError(409, "idempotency_conflict", "reload"), 409, { error: "idempotency_conflict", recovery: "reload" }],
    [new ApprovalOperationsError(409, "expired", "reload", canonical), 409, { error: "expired", recovery: "reload", canonical }],
    [new ApprovalOperationsError(409, "already_resolved", "reload", canonical), 409, { error: "already_resolved", recovery: "reload", canonical }],
  ] as const
  for (const [error, status, body] of cases) {
    const response = await handleWebRequest(post(
      "/api/operations/approvals/approval-1/decision",
      { decision: "grant", expectedVersion: "2" },
      { ...auth, "Idempotency-Key": "key" },
    ), fakeDeps({ approvalOperations: fakeApprovalOperations({ decide: async () => { throw error } }) }))
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual(body)
  }
})

test("winning grants return definitive failed and interrupted execution as HTTP 200", async () => {
  for (const execution of ["failed", "interrupted"] as const) {
    const canonical = approvalDetail({
      version: "3", state: "granted", terminalAt: 150, execution,
      executionDetail: execution === "failed" ? { failureCode: "delivery_failed" } : null,
    })
    const response = await handleWebRequest(post(
      "/api/operations/approvals/approval-1/decision",
      { decision: "grant", expectedVersion: "2" },
      { ...auth, "Idempotency-Key": `key-${execution}` },
    ), fakeDeps({ approvalOperations: fakeApprovalOperations({ decide: async () => ({ approval: canonical }) }) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ approval: canonical })
  }
})

test("unexpected approval failures return a fixed safe 500 without exception details", async () => {
  const response = await handleWebRequest(get("/api/operations/approvals?group=pending", auth), fakeDeps({
    approvalOperations: fakeApprovalOperations({ list: () => { throw new Error("database password leaked") } }),
  }))
  expect(response.status).toBe(500)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = await response.text()
  expect(JSON.parse(body)).toEqual({ error: "approval_unavailable", recovery: "reload" })
  expect(body).not.toContain("password")
})

test("DELETE /api/channels with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/channels", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})

test("GET /api/channels → 200 JSON list", async () => {
  const deps = fakeDeps({ listChannels: () => [{ channelId: "c1", agent: "qa" }] })
  const res = await handleWebRequest(get("/api/channels", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ channelId: "c1", agent: "qa" }])
})

test("GET /api/channel/:id/history → 200 JSON list", async () => {
  const deps = fakeDeps({ fetchChannelHistory: async (id) => { expect(id).toBe("c1"); return [{ kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" }] } })
  const res = await handleWebRequest(get("/api/channel/c1/history", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" }])
})

test("GET /api/channel/:id/timeline → 200 JSON list of TraceRecords", async () => {
  const deps = fakeDeps({
    fetchChannelTimeline: async (id) => { expect(id).toBe("c1"); return [{ v: 1, ts: "2026-07-01T00:00:00.000Z", agent: "qa", chat: "c1", kind: "tool_use", tools: [{ id: "t1", name: "Read" }], bytes: 0 }] },
  })
  const res = await handleWebRequest(get("/api/channel/c1/timeline", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ v: 1, ts: "2026-07-01T00:00:00.000Z", agent: "qa", chat: "c1", kind: "tool_use", tools: [{ id: "t1", name: "Read" }], bytes: 0 }])
})

test("GET /api/channel/:id/timeline without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/channel/c1/timeline"), fakeDeps())
  expect(res.status).toBe(400)
})

test("DELETE /api/channel/:id/timeline with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/channel/c1/timeline", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})

test("POST /api/channel/:id/message → 200, calls sendChannelMessage", async () => {
  const called: { v: [string, string, string] | null } = { v: null }
  const deps = fakeDeps({ sendChannelMessage: async (id, email, text) => { called.v = [id, email, text] } })
  const res = await handleWebRequest(post("/api/channel/c1/message", { text: "hello" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called.v).toEqual(["c1", "a@b.com", "hello"])
})

test("POST /api/command/:name → 200 with text, unknown command → 404", async () => {
  const deps = fakeDeps({ runCommand: async (name) => (name === "audit" ? "📜 audit: no matching events." : null) })
  const ok = await handleWebRequest(post("/api/command/audit", { channelId: "c1" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ text: "📜 audit: no matching events." })
  const bad = await handleWebRequest(post("/api/command/nope", { channelId: "c1" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(bad.status).toBe(404)
})

test("GET /api/agents → 200 JSON registry", async () => {
  const agentCfg: AgentConfig = { emoji: "🤖", description: "d", mode: "persistent", access: { roles: ["*"] }, runtime: { cwd: "~" } }
  const deps = fakeDeps({ agentOperations: { ...fakeDeps().agentOperations, listLegacyConfigs: () => ({ qa: agentCfg }) } })
  const res = await handleWebRequest(get("/api/agents", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ qa: agentCfg })
})

test("GET /api/agents without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/agents"), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/agents/:name/preview → 200, forwards name, config, and authenticated actor", async () => {
  // Wrapped in an object (not a bare `let`) so TS's control-flow narrowing doesn't
  // collapse the read below to the closure-unreachable `null` initializer type.
  const called: { v: [string, unknown, string] | null } = { v: null }
  const deps = fakeDeps({
    agentOperations: { ...fakeDeps().agentOperations, previewLegacyConfig: async (actor, name, config) => {
      called.v = [name, config, actor]
      return { id: "prev-1", before: null, after: config as any, classification: { tier: "restart", fullRestart: ["+agent:qa"] } }
    } },
  })
  const res = await handleWebRequest(post("/api/agents/qa/preview", { config: { emoji: "🤖" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called.v).toEqual(["qa", { emoji: "🤖" }, "a@b.com"])
  expect(await res.json()).toEqual({ id: "prev-1", before: null, after: { emoji: "🤖" }, classification: { tier: "restart", fullRestart: ["+agent:qa"] } })
})

test("POST /api/agents/:name/preview → maps service shape errors", async () => {
  const deps = fakeDeps({
    agentOperations: { ...fakeDeps().agentOperations, previewLegacyConfig: async () => { throw new AgentOperationsError(400, "invalid_config") } },
  })
  const res = await handleWebRequest(post("/api/agents/qa/preview", { config: { emoji: "🤖" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "invalid_config" })
})

test("POST /api/agents/:name/confirm → 200 on applied, forwards id, hard, and the caller's email as actor", async () => {
  const called: { v: [string, string, boolean, string] | null } = { v: null }
  const deps = fakeDeps({
    agentOperations: { ...fakeDeps().agentOperations, confirmLegacyConfig: async (actor, name, id, hard) => { called.v = [name, id, hard, actor]; return { state: "applied", restarted: [], fullRestart: [] } } },
  })
  const res = await handleWebRequest(post("/api/agents/qa/confirm", { id: "prev-1", hard: true }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called.v).toEqual(["qa", "prev-1", true, "a@b.com"])
  expect(await res.json()).toEqual({ state: "applied", restarted: [], fullRestart: [] })
})

test("POST /api/agents/:name/confirm → 409 on not_found or conflict", async () => {
  const notFound = fakeDeps({ agentOperations: { ...fakeDeps().agentOperations, confirmLegacyConfig: async () => { throw new AgentOperationsError(409, "preview_not_found") } } })
  const res1 = await handleWebRequest(post("/api/agents/qa/confirm", { id: "x", hard: false }, { "x-switchboard-user": "a@b.com" }), notFound)
  expect(res1.status).toBe(409)

  const conflict = fakeDeps({ agentOperations: { ...fakeDeps().agentOperations, confirmLegacyConfig: async () => { throw new AgentOperationsError(409, "stale_preview") } } })
  const res2 = await handleWebRequest(post("/api/agents/qa/confirm", { id: "x", hard: false }, { "x-switchboard-user": "a@b.com" }), conflict)
  expect(res2.status).toBe(409)
})

test("DELETE /api/agents with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/agents", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})

test("agent operations routes dispatch list, detail, config, and action requests", async () => {
  const calls: unknown[] = []
  const operations = {
    ...fakeDeps().agentOperations,
    list: (actor: string) => { calls.push(["list", actor]); return [{ name: "qa" } as any] },
    get: (actor: string, name: string) => { calls.push(["get", actor, name]); return { name } as any },
    previewConfig: async (actor: string, name: string, config: any, expectedVersion?: string) => { calls.push(["config-preview", actor, name, config, expectedVersion]); return { id: "cp", before: null, after: config, classification: { tier: "safe" as const, fullRestart: [] }, expiresAt: 2 } },
    confirmConfig: async (actor: string, name: string, id: string, hard: boolean) => { calls.push(["config-confirm", actor, name, id, hard]); return { state: "applied" as const, restarted: [], fullRestart: [] } },
    previewAction: (actor: string, name: string, action: "reset" | "restart") => { calls.push(["action-preview", actor, name, action]); return { id: "ap", actor, agent: name, action, statusVersion: "v", impact: { busy: false, queueDepth: 0 }, expiresAt: 2 } },
    confirmAction: async (actor: string, name: string, id: string, key: string) => { calls.push(["action-confirm", actor, name, id, key]); return { state: "applied" as const, agent: name, action: "reset" as const } },
  }
  const deps = fakeDeps({ agentOperations: operations })
  const auth = { "x-switchboard-user": "a@b.com" }

  const list = await handleWebRequest(get("/api/operations/agents", auth), deps)
  expect((await list.json())[0].name).toBe("qa")
  expect((await (await handleWebRequest(get("/api/operations/agents/qa", auth), deps)).json()).name).toBe("qa")
  expect((await handleWebRequest(post("/api/operations/agents/qa/config/preview", { config: null, expectedVersion: "version-7" }, auth), deps)).status).toBe(200)
  expect((await handleWebRequest(post("/api/operations/agents/qa/config/confirm", { id: "cp", hard: true }, auth), deps)).status).toBe(200)
  expect((await handleWebRequest(post("/api/operations/agents/qa/actions/preview", { action: "reset" }, auth), deps)).status).toBe(200)
  const confirmRequest = post("/api/operations/agents/qa/actions/confirm", { id: "ap" }, { ...auth, "idempotency-key": "idem-1" })
  expect(confirmRequest.headers.get("idempotency-key")).toBeTruthy()
  expect((await handleWebRequest(confirmRequest, deps)).status).toBe(200)
  expect(calls).toEqual([
    ["list", "a@b.com"], ["get", "a@b.com", "qa"],
    ["config-preview", "a@b.com", "qa", null, "version-7"], ["config-confirm", "a@b.com", "qa", "cp", true],
    ["action-preview", "a@b.com", "qa", "reset"], ["action-confirm", "a@b.com", "qa", "ap", "idem-1"],
  ])
})

test("operations config preview rejects omitted and blank expected versions", async () => {
  const auth = { "x-switchboard-user": "a@b.com" }
  const omitted = await handleWebRequest(post("/api/operations/agents/qa/config/preview", { config: null }, auth), fakeDeps())
  const blank = await handleWebRequest(post("/api/operations/agents/qa/config/preview", { config: null, expectedVersion: "  " }, auth), fakeDeps())
  expect(omitted.status).toBe(400)
  expect(await omitted.json()).toEqual({ error: "missing_expected_version" })
  expect(blank.status).toBe(400)
  expect(await blank.json()).toEqual({ error: "invalid_expected_version" })
})

test("agent operations map authorization errors and hide routes before identity", async () => {
  const forbidden = await handleWebRequest(post("/api/operations/agents/qa/actions/preview", { action: "reset" }, { "x-switchboard-user": "viewer@example.com" }), fakeDeps({
    agentOperations: { ...fakeDeps().agentOperations, previewAction: () => { throw new AgentOperationsError(403, "forbidden") } },
  }))
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({ error: "forbidden" })
  const hidden = await handleWebRequest(get("/api/operations/agents/qa", { "x-switchboard-user": "hidden@example.com" }), fakeDeps({
    agentOperations: { ...fakeDeps().agentOperations, get: () => { throw new AgentOperationsError(404, "not_found") } },
  }))
  expect(hidden.status).toBe(404)
  expect((await handleWebRequest(del("/api/operations/agents/qa"), fakeDeps())).status).toBe(400)
  expect((await handleWebRequest(del("/api/operations/agents/qa", { "x-switchboard-user": "a@b.com" }), fakeDeps())).status).toBe(405)
})

test("agent operations reject malformed names and missing action idempotency keys", async () => {
  const auth = { "x-switchboard-user": "a@b.com" }
  expect((await handleWebRequest(get("/api/operations/agents/%E0%A4%A", auth), fakeDeps())).status).toBe(400)
  const missing = await handleWebRequest(post("/api/operations/agents/qa/actions/confirm", { id: "ap" }, auth), fakeDeps())
  expect(missing.status).toBe(400)
  expect(await missing.json()).toEqual({ error: "missing_idempotency_key" })
})

test("GET agent operation events emits SSE IDs, honors after, and unsubscribes on cancel", async () => {
  let seenAfter = -1
  let unsubscribed = false
  const deps = fakeDeps({ agentOperations: {
    ...fakeDeps().agentOperations,
    subscribe: (after, callback) => {
      seenAfter = after
      callback({ kind: "agents_snapshot", ts: 10, sequence: 5 })
      return { unsubscribe: () => { unsubscribed = true } }
    },
  } })
  const events = await handleWebRequest(get("/api/operations/agents/events?after=4", { "x-switchboard-user": "a@b.com" }), deps)
  expect(events.headers.get("content-type")).toContain("text/event-stream")
  const reader = events.body!.getReader()
  const frame = new TextDecoder().decode((await reader.read()).value)
  expect(frame).toContain("id: 5\ndata:")
  expect(seenAfter).toBe(4)
  await reader.cancel()
  expect(unsubscribed).toBeTrue()

  const resumed = await handleWebRequest(get("/api/operations/agents/events", { "x-switchboard-user": "a@b.com", "last-event-id": "8" }), deps)
  expect(resumed.status).toBe(200)
  expect(seenAfter).toBe(8)
  await resumed.body!.cancel()
})

test("approval SSE authenticates and authorizes before subscribing", async () => {
  let sessions = 0
  let subscriptions = 0
  const operations = fakeApprovalOperations({
    session: () => { sessions += 1; throw new ApprovalOperationsError(404, "not_found", "none") },
    subscribe: () => { subscriptions += 1; return { unsubscribe() {} } },
  })
  const deps = fakeDeps({ approvalOperations: operations })
  const unauthenticated = await handleWebRequest(get("/api/operations/approvals/events"), deps)
  expect(unauthenticated.status).toBe(400)
  expect(sessions).toBe(0)
  expect(subscriptions).toBe(0)

  const hidden = await handleWebRequest(get("/api/operations/approvals/events", auth), deps)
  expect(hidden.status).toBe(404)
  expect(sessions).toBe(1)
  expect(subscriptions).toBe(0)
})

test("approval SSE prefers query after, validates safe cursors, frames safe events, and cancels", async () => {
  let seenAfter = -1
  let sessionInput: unknown[] = []
  let unsubscribed = false
  const operations = fakeApprovalOperations({
    session: (principal, context) => {
      sessionInput = [principal, context]
      return { feature: true, coreEnabled: false, role: "viewer", canDecide: false, pendingCount: 1 }
    },
    subscribe: (after, callback) => {
      seenAfter = after
      callback({
        kind: "approval_changed", approvalId: "approval-1", pendingCount: 1,
        ts: 10, sequence: 5, conversationId: "secret-conversation", detail: { secret: true },
      } as unknown as ApprovalOperationsEvent)
      return { unsubscribe: () => { unsubscribed = true } }
    },
  })
  const response = await handleWebRequest(get(
    "/api/operations/approvals/events?after=4",
    { ...auth, "last-event-id": "invalid-but-ignored" },
  ), fakeDeps({ approvalOperations: operations }))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(response.headers.get("cache-control")).toBe("no-cache")
  expect(response.headers.get("x-accel-buffering")).toBe("no")
  expect(sessionInput).toEqual([{ surface: "web", id: "operator@example.com" }, "workspace"])
  expect(seenAfter).toBe(4)
  const reader = response.body!.getReader()
  const frame = new TextDecoder().decode((await reader.read()).value)
  expect(frame).toBe(`id: 5\ndata: ${JSON.stringify({ kind: "approval_changed", approvalId: "approval-1", pendingCount: 1, ts: 10, sequence: 5 })}\n\n`)
  expect(frame).not.toContain("conversation")
  expect(frame).not.toContain("detail")
  await reader.cancel()
  expect(unsubscribed).toBe(true)

  const invalid = ["", "-1", "1.5", "9007199254740992"]
  for (const after of invalid) {
    const rejected = await handleWebRequest(get(`/api/operations/approvals/events?after=${after}`, auth), fakeDeps())
    expect(rejected.status).toBe(400)
    expect(rejected.headers.get("cache-control")).toBe("no-store")
    expect(await rejected.json()).toEqual({ error: "invalid_request", recovery: "none" })
  }
})

test("approval SSE accepts Last-Event-ID and preserves restart snapshot resets", async () => {
  let after = -1
  const reset: ApprovalOperationsEvent = { kind: "snapshot_required", pendingCount: 4, ts: 20, sequence: 0 }
  const response = await handleWebRequest(get(
    "/api/operations/approvals/events",
    { ...auth, "last-event-id": "8" },
  ), fakeDeps({ approvalOperations: fakeApprovalOperations({
    subscribe: (cursor, callback) => { after = cursor; callback(reset); return { unsubscribe() {} } },
  }) }))
  expect(after).toBe(8)
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(`id: 0\ndata: ${JSON.stringify(reset)}\n\n`)
  await reader.cancel()
})

test("GET /api/hub-config → 200 JSON config", async () => {
  const deps = fakeDeps({ listHubConfig: async () => ({ routerModel: "claude-sonnet-4-6" }) })
  const res = await handleWebRequest(get("/api/hub-config", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ routerModel: "claude-sonnet-4-6" })
})

test("GET /api/hub-config without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/hub-config"), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/hub-config/preview → 200, forwards config", async () => {
  const called: { v: unknown | null } = { v: null }
  const deps = fakeDeps({
    previewHubConfigChange: async (config) => {
      called.v = config
      return { id: "hubprev-1", before: {}, after: config, classification: { tier: "restart", fullRestart: ["defaultAgent"] } }
    },
  })
  const res = await handleWebRequest(post("/api/hub-config/preview", { config: { routerModel: "claude-sonnet-4-6" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual({ v: { routerModel: "claude-sonnet-4-6" } })
  expect(await res.json()).toEqual({ id: "hubprev-1", before: {}, after: { routerModel: "claude-sonnet-4-6" }, classification: { tier: "restart", fullRestart: ["defaultAgent"] } })
})

test("POST /api/hub-config/preview → 400 when config is missing", async () => {
  const res = await handleWebRequest(post("/api/hub-config/preview", {}, { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/hub-config/preview → 400 when previewHubConfigChange returns an error shape", async () => {
  const deps = fakeDeps({ previewHubConfigChange: async () => ({ error: "cannot edit excluded field: socketPath" }) })
  const res = await handleWebRequest(post("/api/hub-config/preview", { config: { socketPath: "/tmp/x" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "cannot edit excluded field: socketPath" })
})

test("POST /api/hub-config/confirm → 200 on applied, forwards id and the caller's email as actor", async () => {
  const called: { v: unknown | null } = { v: null }
  const deps = fakeDeps({
    confirmHubConfigChange: async (id, actor) => { called.v = [id, actor]; return { state: "applied", fullRestart: [] } },
  })
  const res = await handleWebRequest(post("/api/hub-config/confirm", { id: "hubprev-1" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual({ v: ["hubprev-1", "a@b.com"] })
  expect(await res.json()).toEqual({ state: "applied", fullRestart: [] })
})

test("POST /api/hub-config/confirm → 409 on not_found or conflict", async () => {
  const notFound = fakeDeps({ confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }) })
  const res1 = await handleWebRequest(post("/api/hub-config/confirm", { id: "x" }, { "x-switchboard-user": "a@b.com" }), notFound)
  expect(res1.status).toBe(409)

  const conflict = fakeDeps({ confirmHubConfigChange: async () => ({ state: "conflict", fullRestart: [] }) })
  const res2 = await handleWebRequest(post("/api/hub-config/confirm", { id: "x" }, { "x-switchboard-user": "a@b.com" }), conflict)
  expect(res2.status).toBe(409)
})

test("DELETE /api/hub-config with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/hub-config", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})

test("GET /api/channel/:id/stream → SSE headers, subscribes and unsubscribes on cancel", async () => {
  let unsubscribed = false
  const deps = fakeDeps({
    subscribeChannel: (id, cb) => {
      expect(id).toBe("c1")
      cb({ kind: "chat", ts: 1, author: "x", content: "hi", origin: "web" })
      return () => { unsubscribed = true }
    },
  })
  const res = await handleWebRequest(get("/api/channel/c1/stream", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain('"content":"hi"')
  await reader.cancel()
  expect(unsubscribed).toBe(true)
})
