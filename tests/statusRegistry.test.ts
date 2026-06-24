import { test, expect } from "bun:test"
import { StatusRegistry, type AgentStatus } from "../hub/statusRegistry"

function agent(name: string): AgentStatus {
  return { name, emoji: "🤖", mode: "persistent", alive: true, busy: false, queueDepth: 0, fillPct: 0.1, lastActivityMs: 0 }
}

test("recordRoute keeps only the most recent N events", () => {
  const r = new StatusRegistry(3)
  for (let i = 0; i < 5; i++) r.recordRoute({ ts: i, conv: "c", chosen: `a${i}`, switched: false })
  const snap = r.snapshot(100)
  expect(snap.routes.map(e => e.chosen)).toEqual(["a2", "a3", "a4"])
})

test("routeRate10m counts only events within the last 10 minutes", () => {
  const r = new StatusRegistry()
  const now = 11 * 60 * 1000
  r.recordRoute({ ts: 0, conv: "c", chosen: "old", switched: false })          // 11m ago → excluded
  r.recordRoute({ ts: now - 60_000, conv: "c", chosen: "recent", switched: false }) // 1m ago → counted
  expect(r.snapshot(now).routeRate10m).toBe(1)
})

test("ephemerals add and remove", () => {
  const r = new StatusRegistry()
  r.setEphemeral({ jobId: "j1", agent: "w", task: "do x", startedAt: 0 })
  r.setEphemeral({ jobId: "j2", agent: "w", task: "do y", startedAt: 0 })
  expect(r.snapshot(0).ephemerals.length).toBe(2)
  r.removeEphemeral("j1")
  expect(r.snapshot(0).ephemerals.map(e => e.jobId)).toEqual(["j2"])
})

test("setAgents and setOverseers replace wholesale", () => {
  const r = new StatusRegistry()
  r.setAgents([agent("a"), agent("b")])
  r.setAgents([agent("a")])                          // replace, not append
  expect(r.snapshot(0).agents.map(a => a.name)).toEqual(["a"])
  r.setOverseers([{ agent: "a", goal: "g", round: 1, max: 4, state: "prodding" }])
  expect(r.snapshot(0).overseers[0]!.goal).toBe("g")
})
