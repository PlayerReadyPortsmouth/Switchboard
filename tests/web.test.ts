import { test, expect } from "bun:test"
import { renderDashboardJson, DASHBOARD_HTML, type WebInput } from "../hub/web"
import type { AgentStatus } from "../hub/statusRegistry"
import type { AuditEvent, AuditSummary } from "../hub/types"

const agent = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  name: "assistant", emoji: "🤖", mode: "persistent",
  alive: true, busy: false, queueDepth: 0, fillPct: 0.5, lastActivityMs: 0, ...over,
})
const summary = (): AuditSummary => ({
  total: 2, byKind: { route: 2 }, byOutcome: { ok: 2 }, costUsd: 0.03, actors: 1,
})
const recent: AuditEvent[] = [
  { ts: 1, kind: "route", actor: "user:1", action: "route", outcome: "ok", target: "assistant" },
  { ts: 2, kind: "access", actor: "user:2", action: "deny", outcome: "deny" },
]
const input = (over: Partial<WebInput> = {}): WebInput => ({
  now: 61_000, startedAt: 0,
  status: { now: 61_000, agents: [agent()], overseers: [], routes: [], routeRate10m: 4,
    ephemerals: [{ jobId: "j1", agent: "worker", task: "build", startedAt: 0 }] },
  audit: summary(), recent, pendingApprovals: 1, ...over,
})

// ---- renderDashboardJson ----

test("projects status, agents, ephemerals, summary, and the recent feed", () => {
  const d = renderDashboardJson(input())
  expect(d.status).toBe("ok")
  expect(d.uptimeSec).toBe(61)
  expect(d.routeRate10m).toBe(4)
  expect(d.pendingApprovals).toBe(1)
  expect(d.agents[0]).toEqual({ name: "assistant", alive: true, busy: false, contextFill: 0.5, queueDepth: 0, costUsd: 0, replicas: 1 })
  expect(d.ephemerals).toEqual([{ jobId: "j1", agent: "worker", task: "build" }])
  expect(d.audit).toEqual(summary())
  expect(d.recent).toEqual([
    { ts: 1, kind: "route", actor: "user:1", action: "route", target: "assistant", outcome: "ok" },
    { ts: 2, kind: "access", actor: "user:2", action: "deny", target: undefined, outcome: "deny" },
  ])
})

test("status is degraded when agents exist but none are alive (matches /health)", () => {
  expect(renderDashboardJson(input({
    status: { now: 0, agents: [agent({ alive: false })], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
  })).status).toBe("degraded")
})

// ---- DASHBOARD_HTML ----

test("DASHBOARD_HTML is a self-contained page that polls the status endpoint relatively", () => {
  expect(DASHBOARD_HTML.startsWith("<!doctype html>")).toBe(true)
  // Relative (no leading slash) so it works mounted under /switchboard/ as well as at root.
  expect(DASHBOARD_HTML).toContain("fetch('api/status')")
  expect(DASHBOARD_HTML).not.toContain("fetch('/api/status')")
  expect(DASHBOARD_HTML).toContain("Switchboard")
})
