import { test, expect } from "bun:test"
import { handleWebRequest } from "../hub/webServer"
import type { WebInput, DashboardJson } from "../hub/web"
import type { WebDeps } from "../hub/webServer"
import type { AgentConfig } from "../hub/types"

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
    listAgents: async () => ({}),
    previewAgentChange: async () => ({ id: "prev-1", before: null, after: null, classification: { tier: "safe", fullRestart: [] } }),
    confirmAgentChange: async () => ({ state: "not_found", restarted: [], fullRestart: [] }),
    ...overrides,
  }
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "GET", headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
const del = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "DELETE", headers })

test("GET / → 200 HTML dashboard (no auth required)", async () => {
  const res = await handleWebRequest(get("/"), fakeDeps())
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/html")
})

test("GET /api/status → 200 JSON payload (no auth required)", async () => {
  const res = await handleWebRequest(get("/api/status"), fakeDeps())
  expect(res.status).toBe(200)
  const json = (await res.json()) as DashboardJson
  expect(json.status).toBe("ok")
  expect(json.pendingApprovalList).toEqual([])
})

test("POST / → 405, unknown path → 404", async () => {
  expect((await handleWebRequest(post("/", {}, { "x-switchboard-user": "a@b.com" }), fakeDeps())).status).toBe(405)
  expect((await handleWebRequest(get("/nope"), fakeDeps())).status).toBe(404)
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
  const deps = fakeDeps({ listAgents: async () => ({ qa: agentCfg }) })
  const res = await handleWebRequest(get("/api/agents", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ qa: agentCfg })
})

test("GET /api/agents without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/agents"), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/agents/:name/preview → 200, forwards name and config", async () => {
  // Wrapped in an object (not a bare `let`) so TS's control-flow narrowing doesn't
  // collapse the read below to the closure-unreachable `null` initializer type.
  const called: { v: [string, unknown] | null } = { v: null }
  const deps = fakeDeps({
    previewAgentChange: async (name, config) => {
      called.v = [name, config]
      return { id: "prev-1", before: null, after: config as any, classification: { tier: "restart", fullRestart: ["+agent:qa"] } }
    },
  })
  const res = await handleWebRequest(post("/api/agents/qa/preview", { config: { emoji: "🤖" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called.v).toEqual(["qa", { emoji: "🤖" }])
  expect(await res.json()).toEqual({ id: "prev-1", before: null, after: { emoji: "🤖" }, classification: { tier: "restart", fullRestart: ["+agent:qa"] } })
})

test("POST /api/agents/:name/preview → 400 when previewAgentChange reports a shape error", async () => {
  const deps = fakeDeps({
    previewAgentChange: async () => ({ error: "runtime.cwd must be a string" }),
  })
  const res = await handleWebRequest(post("/api/agents/qa/preview", { config: { emoji: "🤖" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "runtime.cwd must be a string" })
})

test("POST /api/agents/:name/confirm → 200 on applied, forwards id, hard, and the caller's email as actor", async () => {
  const called: { v: [string, string, boolean, string] | null } = { v: null }
  const deps = fakeDeps({
    confirmAgentChange: async (name, id, hard, actor) => { called.v = [name, id, hard, actor]; return { state: "applied", restarted: [], fullRestart: [] } },
  })
  const res = await handleWebRequest(post("/api/agents/qa/confirm", { id: "prev-1", hard: true }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called.v).toEqual(["qa", "prev-1", true, "a@b.com"])
  expect(await res.json()).toEqual({ state: "applied", restarted: [], fullRestart: [] })
})

test("POST /api/agents/:name/confirm → 409 on not_found or conflict", async () => {
  const notFound = fakeDeps({ confirmAgentChange: async () => ({ state: "not_found", restarted: [], fullRestart: [] }) })
  const res1 = await handleWebRequest(post("/api/agents/qa/confirm", { id: "x", hard: false }, { "x-switchboard-user": "a@b.com" }), notFound)
  expect(res1.status).toBe(409)

  const conflict = fakeDeps({ confirmAgentChange: async () => ({ state: "conflict", restarted: [], fullRestart: [] }) })
  const res2 = await handleWebRequest(post("/api/agents/qa/confirm", { id: "x", hard: false }, { "x-switchboard-user": "a@b.com" }), conflict)
  expect(res2.status).toBe(409)
})

test("DELETE /api/agents with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/agents", { "x-switchboard-user": "a@b.com" }), fakeDeps())
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
