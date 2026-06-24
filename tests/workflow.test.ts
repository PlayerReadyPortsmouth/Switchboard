import { test, expect } from "bun:test"
import { renderStepPrompt, findWorkflow, MissionRegistry, renderMissionCard, type MissionRun } from "../hub/workflow"
import type { WorkflowRoute } from "../hub/types"

// ---- renderStepPrompt ----

test("interpolates {{input}} and {{steps.<id>}}, tolerating whitespace", () => {
  expect(renderStepPrompt("do {{input}} now", { input: "X", steps: {} })).toBe("do X now")
  expect(renderStepPrompt("use {{ steps.research }}", { input: "", steps: { research: "R" } })).toBe("use R")
  expect(renderStepPrompt("{{input}} + {{steps.a}}", { input: "I", steps: { a: "A" } })).toBe("I + A")
})

test("unknown step ref → empty, non-matching braces left intact, plain text unchanged", () => {
  expect(renderStepPrompt("{{steps.missing}}", { input: "", steps: {} })).toBe("")
  expect(renderStepPrompt("{{unknown}}", { input: "", steps: {} })).toBe("{{unknown}}")
  expect(renderStepPrompt("plain text", { input: "X", steps: {} })).toBe("plain text")
})

// ---- findWorkflow ----

const wf: WorkflowRoute[] = [{ id: "ship", steps: [{ id: "a", agent: "x", prompt: "{{input}}" }] }]
test("findWorkflow returns by id, undefined on miss", () => {
  expect(findWorkflow(wf, "ship")?.id).toBe("ship")
  expect(findWorkflow(wf, "nope")).toBeUndefined()
})

// ---- MissionRegistry ----

function harness() {
  let n = 0
  return new MissionRegistry(() => `m${++n}`)
}

test("open stamps a unique mission:<id> channel; settle resolves ok=true, single-shot", () => {
  const r = harness()
  let got: { ok: boolean; output: string } | undefined
  const { channel } = r.open((ok, output) => { got = { ok, output } })
  expect(channel).toBe("mission:m1")
  expect(r.isMissionChannel("mission:m1")).toBe(true)
  expect(r.isMissionChannel("consult:m1")).toBe(false)
  expect(r.open(() => {}).channel).toBe("mission:m2")   // monotonic, no collision
  expect(r.settle(channel, "result")).toBe(true)
  expect(got).toEqual({ ok: true, output: "result" })
  expect(r.settle(channel, "again")).toBe(false)        // single-shot
  expect(r.fail(channel, "late")).toBe(false)           // already settled
})

test("fail resolves ok=false (busy/unavailable/timeout) and is single-shot vs settle", () => {
  const r = harness()
  let got: { ok: boolean; output: string } | undefined
  const { channel } = r.open((ok, output) => { got = { ok, output } })
  expect(r.fail(channel, "(agent busy)")).toBe(true)
  expect(got).toEqual({ ok: false, output: "(agent busy)" })
  expect(r.isMissionChannel(channel)).toBe(false)
  expect(r.settle(channel, "too late")).toBe(false)     // fail won the race
})

// ---- renderMissionCard ----

const run = (over: Partial<MissionRun> = {}): MissionRun => ({
  runId: "r1", workflowId: "ship", input: "add dark mode", chatId: "c1", state: "running",
  steps: [
    { id: "research", agent: "research", state: "done", output: "found the approach" },
    { id: "implement", agent: "assistant", state: "running" },
    { id: "review", agent: "help", state: "pending" },
  ], ...over,
})

test("renderMissionCard shows per-step glyphs, agents, and truncated output", () => {
  const card = renderMissionCard(run())
  expect(card.title).toContain("ship")
  expect(card.body).toContain("✅")
  expect(card.body).toContain("🔄")
  expect(card.body).toContain("⏳")
  expect(card.body).toContain("research")
  expect(card.body).toContain("found the approach")
  expect(card.buttons).toEqual([])
})

test("renderMissionCard title reflects done / failed terminal state", () => {
  expect(renderMissionCard(run({ state: "done" })).title).toContain("✅")
  expect(renderMissionCard(run({ state: "failed" })).title).toContain("❌")
})
