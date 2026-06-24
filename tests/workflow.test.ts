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

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new MissionRegistry(() => now, () => `m${++n}`, ttl)
  return { r, at: (v: number) => { now = v } }
}

test("open stamps a mission:<id> channel + deadline; settle is single-shot", () => {
  const h = harness(1000)
  h.at(500)
  let got: string | undefined
  const { channel } = h.r.open("ship:a", "x", (out) => { got = out })
  expect(channel).toBe("mission:m1")
  expect(h.r.isMissionChannel("mission:m1")).toBe(true)
  expect(h.r.isMissionChannel("consult:m1")).toBe(false)
  expect(h.r.settle(channel, "result")).toBe(true)
  expect(got).toBe("result")
  expect(h.r.settle(channel, "again")).toBe(false)   // single-shot
})

test("sweepExpired returns only past-deadline entries with their resolvers", () => {
  const h = harness(1000)
  h.at(0)
  const a = h.r.open("ship:a", "x", () => {})
  h.at(600)
  const b = h.r.open("ship:b", "y", () => {})   // expires 1600
  h.at(1200)
  const expired = h.r.sweepExpired()
  expect(expired.map((e) => e.channel)).toEqual([a.channel])
  expect(typeof expired[0].resolve).toBe("function")
  expect(h.r.isMissionChannel(b.channel)).toBe(true)
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
