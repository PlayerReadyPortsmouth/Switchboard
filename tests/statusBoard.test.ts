import { test, expect } from "bun:test"
import { renderBoard, agentLine, Throttle } from "../hub/statusBoard"
import type { AgentStatus, StatusSnapshot } from "../hub/statusRegistry"

function agent(p: Partial<AgentStatus> = {}): AgentStatus {
  return {
    name: "assistant", emoji: "🤖", mode: "persistent", alive: true, busy: false,
    queueDepth: 0, fillPct: 0.62, lastActivityMs: 0, ...p,
  }
}

test("agentLine shows busy/idle/offline, context, queue, cost, replicas", () => {
  expect(agentLine(agent({ busy: true, queueDepth: 2, costUsd: 0.04 })))
    .toBe("🤖 **assistant**  ● busy  ctx 62%  q:2  $0.04")
  expect(agentLine(agent({ busy: false, queueDepth: 0 })))
    .toBe("🤖 **assistant**  ○ idle  ctx 62%")
  expect(agentLine(agent({ alive: false }))).toContain("✖ offline")
  expect(agentLine(agent({ replicas: 3 }))).toContain("×3")
})

function snap(p: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    now: Date.UTC(2026, 5, 24, 12, 4, 31),
    agents: [agent()], overseers: [], routes: [], routeRate10m: 0, ephemerals: [], ...p,
  }
}

test("renderBoard lists persistent agents and always shows a router field", () => {
  const card = renderBoard(snap())
  expect(card.title).toContain("Switchboard")
  const names = (card.fields ?? []).map(f => f.name)
  expect(names).toContain("Persistent agents")
  expect(names).toContain("Router (haiku)")
  expect(card.footer).toContain("12:04:31")
})

test("renderBoard includes overseer + ephemeral fields only when present", () => {
  const bare = renderBoard(snap())
  expect((bare.fields ?? []).map(f => f.name)).not.toContain("Overseer")

  const full = renderBoard(snap({
    overseers: [{ agent: "assistant", goal: "fix tests", round: 2, max: 4, state: "prodding" }],
    routes: [{ ts: 0, conv: "c", chosen: "assistant", confidence: 0.91, switched: true }],
    routeRate10m: 5,
    ephemerals: [{ jobId: "j1", agent: "worker", task: "deploy preview", startedAt: 0 }],
  }))
  const byName = Object.fromEntries((full.fields ?? []).map(f => [f.name, f.value]))
  expect(byName["Overseer"]).toContain("round 2/4")
  expect(byName["Router (haiku)"]).toContain("switched")
  expect(byName["Router (haiku)"]).toContain("0.91")
  expect(byName["Router (haiku)"]).toContain("5 routes/10m")
  expect(byName["Ephemeral agents"]).toContain("deploy preview")
})

test("renderBoard shows a compacting overseer line distinctly", () => {
  const card = renderBoard(snap({ overseers: [{ agent: "a", goal: "", round: 0, max: 0, state: "compacting" }] }))
  const o = (card.fields ?? []).find(f => f.name === "Overseer")
  expect(o?.value).toContain("compacting")
})

test("Throttle emits once then coalesces a burst into a single scheduled flush", () => {
  const t = new Throttle(1000)
  expect(t.request(0)).toEqual({ emit: true })       // first → immediate
  const r1 = t.request(100)                           // within window → schedule
  expect(r1.emit).toBe(false)
  expect(r1.scheduleInMs).toBe(900)
  expect(t.request(200)).toEqual({ emit: false })    // already scheduled → no-op
  expect(t.request(500)).toEqual({ emit: false })
  t.fire(1000)                                        // scheduled flush fires
  expect(t.request(2500).emit).toBe(true)            // past interval again → immediate
})
