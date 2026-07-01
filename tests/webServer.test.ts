import { test, expect } from "bun:test"
import { handleWebRequest } from "../hub/webServer"
import type { WebInput, DashboardJson } from "../hub/web"
import type { WebDeps } from "../hub/webServer"

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
    subscribeChannel: () => () => {},
    sendChannelMessage: async () => {},
    runCommand: async () => null,
    ...overrides,
  }
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "GET", headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

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

test("GET /api/channels → 200 JSON list", async () => {
  const deps = fakeDeps({ listChannels: () => [{ channelId: "c1", agent: "qa" }] })
  const res = await handleWebRequest(get("/api/channels", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ channelId: "c1", agent: "qa" }])
})

test("GET /api/channel/:id/history → 200 JSON list", async () => {
  const deps = fakeDeps({ fetchChannelHistory: async (id) => { expect(id).toBe("c1"); return [{ ts: 1, author: "x", content: "hi", origin: "discord" }] } })
  const res = await handleWebRequest(get("/api/channel/c1/history", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ ts: 1, author: "x", content: "hi", origin: "discord" }])
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

test("GET /api/channel/:id/stream → SSE headers, subscribes and unsubscribes on cancel", async () => {
  let unsubscribed = false
  const deps = fakeDeps({
    subscribeChannel: (id, cb) => {
      expect(id).toBe("c1")
      cb({ ts: 1, author: "x", content: "hi", origin: "web" })
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
