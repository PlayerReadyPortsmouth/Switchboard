import { test, expect } from "bun:test"
import { Overseer, parseJudgeOutput, buildJudgePrompt } from "../hub/overseer"
import type { OverseerPolicy } from "../hub/types"

const policy: OverseerPolicy = { enabled: true, maxIterations: 3, maxWallclockMs: 1_000_000 }

function harness(opts: { run: () => Promise<string>; pol?: OverseerPolicy; now?: () => number }) {
  const nudges: { agent: string; convId: string; text: string }[] = []
  const o = new Overseer({
    run: opts.run,
    defaultModel: "m",
    policyFor: () => opts.pol ?? policy,
    deliverNudge: (agent, convId, text) => nudges.push({ agent, convId, text }),
    recentConversation: () => "history",
    now: opts.now,
  })
  return { o, nudges }
}

test("judge prompt carries goal, conversation and latest reply", () => {
  const { user } = buildJudgePrompt("ship it", "the convo", "i think im done")
  expect(user).toContain("ship it")
  expect(user).toContain("the convo")
  expect(user).toContain("i think im done")
})

test("parseJudgeOutput requires a boolean done", () => {
  expect(parseJudgeOutput('{"done":true,"reason":"ok"}')).toEqual({ done: true, reason: "ok", nudge: undefined })
  expect(parseJudgeOutput('{"done":false,"nudge":"keep going"}')?.nudge).toBe("keep going")
  expect(parseJudgeOutput('{"reason":"x"}')).toBeNull()
  expect(parseJudgeOutput("garbage")).toBeNull()
})

test("no active goal ⇒ forwards without judging", async () => {
  let called = false
  const { o } = harness({ run: async () => { called = true; return '{"done":false}' } })
  const v = await o.intercept("agent", "c1", "hello")
  expect(v.forward).toBe(true)
  expect(called).toBe(false)
})

test("done ⇒ forwards and clears the session", async () => {
  const { o, nudges } = harness({ run: async () => '{"done":true}' })
  o.begin("agent", "c1", "the goal")
  const v = await o.intercept("agent", "c1", "all finished")
  expect(v.forward).toBe(true)
  expect(nudges.length).toBe(0)
  // session cleared → a second reply forwards without another judge
  expect((await o.intercept("agent", "c1", "again")).forward).toBe(true)
})

test("not done ⇒ swallows the reply and delivers the nudge", async () => {
  const { o, nudges } = harness({ run: async () => '{"done":false,"nudge":"fix the failing test"}' })
  o.begin("agent", "c1", "make tests pass")
  const v = await o.intercept("agent", "c1", "I wrote some code")
  expect(v.forward).toBe(false)
  expect(nudges).toEqual([{ agent: "agent", convId: "c1", text: "fix the failing test" }])
})

test("stops after maxIterations and forwards with a footer", async () => {
  const { o, nudges } = harness({ run: async () => '{"done":false}', pol: { enabled: true, maxIterations: 2 } })
  o.begin("agent", "c1", "g")
  expect((await o.intercept("agent", "c1", "r1")).forward).toBe(false)  // nudge 1
  expect((await o.intercept("agent", "c1", "r2")).forward).toBe(false)  // nudge 2
  const v = await o.intercept("agent", "c1", "r3")                       // cap hit
  expect(v.forward).toBe(true)
  expect(v.footer).toContain("stopped after 2")
  expect(nudges.length).toBe(2)
})

test("stops on wallclock budget", async () => {
  let t = 1000
  const { o } = harness({
    run: async () => '{"done":false,"nudge":"more"}',
    pol: { enabled: true, maxIterations: 99, maxWallclockMs: 5000 },
    now: () => t,
  })
  o.begin("agent", "c1", "g")          // startedAt = 1000
  expect((await o.intercept("agent", "c1", "r1")).forward).toBe(false)
  t = 7000                              // 6s elapsed > 5s budget
  const v = await o.intercept("agent", "c1", "r2")
  expect(v.forward).toBe(true)
  expect(v.footer).toContain("stopped")
})

test("garbled judge fails open (forwards)", async () => {
  const { o } = harness({ run: async () => "not json" })
  o.begin("agent", "c1", "g")
  expect((await o.intercept("agent", "c1", "r")).forward).toBe(true)
})

test("begin is a no-op for non-overseen agents", async () => {
  const { o } = harness({ run: async () => '{"done":false}', pol: { enabled: false } })
  o.begin("agent", "c1", "g")
  expect((await o.intercept("agent", "c1", "r")).forward).toBe(true)
})
