import { test, expect } from "bun:test"
import { handleMetricsRequest } from "../hub/metricsServer"
import type { MetricsInput } from "../hub/metrics"
import type { AgentStatus } from "../hub/statusRegistry"

const agent = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  name: "assistant", emoji: "🤖", mode: "persistent",
  alive: true, busy: false, queueDepth: 0, fillPct: 0.5, lastActivityMs: 0, ...over,
})
const input = (agents: AgentStatus[]): MetricsInput => ({
  now: 1000, startedAt: 0,
  status: { now: 1000, agents, overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
  audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
  pendingApprovals: 0,
})
const get = (path: string) => new Request(`http://hub${path}`, { method: "GET" })

test("GET /metrics → 200 Prometheus text", async () => {
  const res = handleMetricsRequest(get("/metrics"), () => input([agent()]))
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/plain")
  expect(await res.text()).toContain("switchboard_up 1")
})

test("GET /health → 200 ok JSON when an agent is alive", async () => {
  const res = handleMetricsRequest(get("/health"), () => input([agent({ alive: true })]))
  expect(res.status).toBe(200)
  expect(JSON.parse(await res.text()).status).toBe("ok")
})

test("GET /healthz → 503 degraded when agents exist but none alive", async () => {
  const res = handleMetricsRequest(get("/healthz"), () => input([agent({ alive: false })]))
  expect(res.status).toBe(503)
  expect(JSON.parse(await res.text()).status).toBe("degraded")
})

test("POST → 405, unknown path → 404", () => {
  const post = new Request("http://hub/metrics", { method: "POST" })
  expect(handleMetricsRequest(post, () => input([])).status).toBe(405)
  expect(handleMetricsRequest(get("/nope"), () => input([])).status).toBe(404)
})
