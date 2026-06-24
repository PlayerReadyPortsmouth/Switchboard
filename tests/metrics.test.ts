import { test, expect } from "bun:test"
import { renderPrometheus, renderHealth, type MetricsInput } from "../hub/metrics"
import type { AgentStatus, StatusSnapshot } from "../hub/statusRegistry"
import type { AuditSummary } from "../hub/types"

const agent = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  name: "assistant", emoji: "🤖", mode: "persistent",
  alive: true, busy: false, queueDepth: 0, fillPct: 0.5, lastActivityMs: 0, ...over,
})
const snap = (agents: AgentStatus[]): StatusSnapshot => ({
  now: 1000, agents, overseers: [], routes: [], routeRate10m: 3, ephemerals: [],
})
const summary = (): AuditSummary => ({
  total: 5, byKind: { route: 3, outbound: 2 }, byOutcome: { ok: 4, deny: 1 }, costUsd: 0.12, actors: 2,
})
const input = (over: Partial<MetricsInput> = {}): MetricsInput => ({
  now: 5000, startedAt: 0, status: snap([agent()]), audit: summary(), pendingApprovals: 0, ...over,
})

// ---- renderPrometheus ----

test("emits HELP/TYPE, up, uptime, and labelled agent gauges", () => {
  const out = renderPrometheus(input({
    status: snap([agent({ queueDepth: 2, fillPct: 0.62, costUsd: 0.41, busy: true })]),
    pendingApprovals: 1,
  }))
  expect(out).toContain("# TYPE switchboard_up gauge")
  expect(out).toContain("switchboard_up 1")
  expect(out).toContain("switchboard_uptime_seconds 5")
  expect(out).toContain('switchboard_agent_busy{agent="assistant"} 1')
  expect(out).toContain('switchboard_agent_queue_depth{agent="assistant"} 2')
  expect(out).toContain('switchboard_agent_context_fill_ratio{agent="assistant"} 0.62')
  expect(out).toContain('switchboard_agent_cost_usd{agent="assistant"} 0.41')
  expect(out).toContain("switchboard_pending_approvals 1")
  expect(out).toContain("switchboard_route_rate_10m 3")
})

test("projects the audit summary into ledger gauges", () => {
  const out = renderPrometheus(input())
  expect(out).toContain('switchboard_ledger_events{kind="outbound"} 2')
  expect(out).toContain('switchboard_ledger_outcomes{outcome="deny"} 1')
  expect(out).toContain("switchboard_ledger_cost_usd 0.12")
})

test("escapes label values per the exposition format", () => {
  const out = renderPrometheus(input({ status: snap([agent({ name: 'a"b\\c' })]) }))
  expect(out).toContain('switchboard_agent_alive{agent="a\\"b\\\\c"} 1')
})

// ---- renderHealth ----

test("health is ok/200 when an agent is alive", () => {
  const h = renderHealth(input({ now: 1000, startedAt: 0, status: snap([agent({ alive: true })]) }))
  expect(h.ok).toBe(true)
  expect(h.body.status).toBe("ok")
  expect(h.body.uptimeSec).toBe(1)
  expect(h.body.agents[0]).toEqual({ name: "assistant", alive: true, busy: false, queueDepth: 0, contextFill: 0.5 })
})

test("health is degraded/503 when agents exist but none are alive", () => {
  const h = renderHealth(input({ status: snap([agent({ alive: false }), agent({ name: "help", alive: false })]) }))
  expect(h.ok).toBe(false)
  expect(h.body.status).toBe("degraded")
})

test("health is ok when no agents are configured (nothing to be unhealthy about)", () => {
  expect(renderHealth(input({ status: snap([]) })).ok).toBe(true)
})
