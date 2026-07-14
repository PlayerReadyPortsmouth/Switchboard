import { test, expect } from "bun:test"
import { handleWebRequest, startWebServer } from "../hub/webServer"
import type { WebInput, DashboardJson } from "../hub/web"
import type { WebDeps } from "../hub/webServer"
import type { AgentConfig } from "../hub/types"
import type { WorkspaceAssetHandler } from "../hub/webAssets"
import { AgentOperationsError } from "../hub/operations/agentService"

const baseInput = (): WebInput => ({
  now: 1000, startedAt: 0,
  status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
  audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
  recent: [], pendingApprovals: 0, pendingApprovalList: [],
})

function fakeDeps(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    collect: baseInput,
    requireUser: (req) => req.headers.get("x-switchboard-user"),
    resolveApproval: async () => "not_found",
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

test("GET /api/status → 200 JSON payload (no auth required)", async () => {
  const res = await handleWebRequest(get("/api/status"), fakeDeps())
  expect(res.status).toBe(200)
  const json = (await res.json()) as DashboardJson
  expect(json.status).toBe("ok")
  expect(json.pendingApprovalList).toEqual([])
})

test("POST / → 405, unknown non-API GET → 503", async () => {
  expect((await handleWebRequest(post("/", {}, { "x-switchboard-user": "a@b.com" }), fakeDeps())).status).toBe(405)
  expect((await handleWebRequest(get("/nope"), fakeDeps())).status).toBe(503)
})

test("POST /api/approvals/:id without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(post("/api/approvals/appr-1", { decision: "grant" }), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/approvals/:id grant → 200, calls resolveApproval with the header identity", async () => {
  // Wrapped in an object (not a bare `let`) so TS's control-flow narrowing doesn't
  // collapse the read below to the closure-unreachable `null` initializer type.
  const called: { v: [string, string, string] | null } = { v: null }
  const deps = fakeDeps({
    resolveApproval: async (id, decision, actor) => { called.v = [id, decision, actor]; return "granted" },
  })
  const res = await handleWebRequest(post("/api/approvals/appr-1", { decision: "grant" }, { "x-switchboard-user": "aurora@player-ready.co.uk" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ state: "granted" })
  expect(called.v).toEqual(["appr-1", "grant", "aurora@player-ready.co.uk"])
})

test("POST /api/approvals/:id already resolved → 409", async () => {
  const deps = fakeDeps({ resolveApproval: async () => "not_found" })
  const res = await handleWebRequest(post("/api/approvals/appr-1", { decision: "deny" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(409)
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
