import { test, expect } from "bun:test"
import { SessionGovernor } from "../hub/sessionGovernor"
import type { GovernorPolicy, TurnUsage } from "../hub/types"

/** usage whose contextTokens == `tokens` (all in input). */
function usage(tokens: number): TurnUsage {
  return { inputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }
}

function harness(policy: GovernorPolicy | undefined, window = 1000) {
  const calls = {
    delivered: [] as { agent: string; text: string }[],
    notified: [] as string[],
    handoffs: [] as { agent: string; summary: string }[],
    resets: [] as string[],
  }
  const g = new SessionGovernor({
    policyFor: () => policy,
    windowFor: () => window,
    deliver: (agent, _c, text) => calls.delivered.push({ agent, text }),
    notify: (_c, text) => calls.notified.push(text),
    reset: async (agent) => { calls.resets.push(agent) },
    recordHandoff: (agent, _c, summary) => calls.handoffs.push({ agent, summary }),
  })
  return { g, calls }
}

const ON: GovernorPolicy = { enabled: true, softPct: 0.75, hardPct: 0.9 }

test("disabled policy or missing usage is a no-op", async () => {
  const off = harness({ enabled: false })
  expect(await off.g.observe("a", "c", "hi", usage(950))).toEqual({ forward: true })
  expect(off.calls.delivered).toEqual([])

  const on = harness(ON)
  expect(await on.g.observe("a", "c", "hi", undefined)).toEqual({ forward: true })
  expect(on.calls.delivered).toEqual([])
})

test("below the soft threshold forwards silently", async () => {
  const { g, calls } = harness(ON)
  expect(await g.observe("a", "c", "hi", usage(500))).toEqual({ forward: true })
  expect(calls.delivered).toEqual([])
})

test("soft threshold delivers one checkpoint nudge, debounced, and re-arms", async () => {
  const { g, calls } = harness(ON)
  await g.observe("a", "c", "x", usage(800))     // 80% → soft
  await g.observe("a", "c", "x", usage(820))     // still soft → no second nudge
  expect(calls.delivered.length).toBe(1)
  expect(calls.delivered[0]!.text).toContain("remember")

  await g.observe("a", "c", "x", usage(500))     // back below soft → re-arm
  await g.observe("a", "c", "x", usage(800))     // soft again → nudge again
  expect(calls.delivered.length).toBe(2)
})

test("hard threshold requests a handoff, forwards the reply, suppresses overseer", async () => {
  const { g, calls } = harness(ON)
  const d = await g.observe("a", "c", "answer", usage(950))   // 95% → hard
  expect(d.forward).toBe(true)
  expect(d.suppressOverseer).toBe(true)
  expect(d.footer).toContain("compacting")
  expect(calls.delivered.length).toBe(1)
  expect(calls.delivered[0]!.text).toContain("handoff")
  expect(g.isCompacting("a", "c")).toBe(true)
})

test("the handoff turn is swallowed: persisted, reset, reseeded, notified", async () => {
  const { g, calls } = harness(ON)
  await g.observe("a", "c", "answer", usage(950))             // → awaiting-handoff
  const d = await g.observe("a", "c", "HANDOFF: did X, next do Y", usage(960))
  expect(d.forward).toBe(false)
  expect(d.suppressOverseer).toBe(true)
  expect(calls.handoffs).toEqual([{ agent: "a", summary: "HANDOFF: did X, next do Y" }])
  expect(calls.resets).toEqual(["a"])
  expect(calls.notified[0]).toContain("compacted")
  expect(g.isCompacting("a", "c")).toBe(false)

  // The handoff seeds exactly the next dispatch, then clears.
  expect(g.takeSeed("a", "c")).toBe("HANDOFF: did X, next do Y")
  expect(g.takeSeed("a", "c")).toBeNull()
})

test("per-(agent,conversation) isolation of governor state", async () => {
  const { g, calls } = harness(ON)
  await g.observe("a", "c1", "x", usage(950))    // a/c1 → awaiting
  expect(g.isCompacting("a", "c1")).toBe(true)
  expect(g.isCompacting("a", "c2")).toBe(false)
  expect(g.isCompacting("b", "c1")).toBe(false)
  expect(calls.delivered.length).toBe(1)
})
