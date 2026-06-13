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

test("judge prompt reserves 'blocked' for genuine human needs and pushes autonomy otherwise", () => {
  const { system } = buildJudgePrompt("g", "c", "r")
  expect(system).toContain("GENUINELY required")
  expect(system).toContain("sensible default")
})

test("false block ⇒ judge returns working+nudge ⇒ agent is prodded to proceed", async () => {
  // The intelligence lives in the prompt; here we assert the mechanism: a
  // working verdict on a "should I proceed?" reply re-prods rather than pausing.
  const { o, nudges } = harness({
    run: async () => '{"status":"working","nudge":"You can decide this yourself — pick the sensible default and continue."}',
  })
  o.begin("agent", "c1", "tidy up the config")
  const v = await o.intercept("agent", "c1", "Should I also remove the unused field? Awaiting confirmation.")
  expect(v.forward).toBe(false)
  expect(nudges[0].text).toContain("sensible default")
})

test("parseJudgeOutput reads status, tolerates legacy boolean done", () => {
  expect(parseJudgeOutput('{"status":"done","reason":"ok"}')).toEqual({ status: "done", reason: "ok", nudge: undefined })
  expect(parseJudgeOutput('{"status":"working","nudge":"keep going"}')?.nudge).toBe("keep going")
  expect(parseJudgeOutput('{"status":"blocked"}')?.status).toBe("blocked")
  expect(parseJudgeOutput('{"done":true}')?.status).toBe("done")     // legacy
  expect(parseJudgeOutput('{"done":false}')?.status).toBe("working") // legacy
  expect(parseJudgeOutput('{"reason":"x"}')).toBeNull()
  expect(parseJudgeOutput("garbage")).toBeNull()
})

test("no active goal ⇒ forwards without judging", async () => {
  let called = false
  const { o } = harness({ run: async () => { called = true; return '{"status":"working"}' } })
  const v = await o.intercept("agent", "c1", "hello")
  expect(v.forward).toBe(true)
  expect(called).toBe(false)
})

test("done ⇒ forwards and clears the session", async () => {
  const { o, nudges } = harness({ run: async () => '{"status":"done"}' })
  o.begin("agent", "c1", "the goal")
  const v = await o.intercept("agent", "c1", "all finished")
  expect(v.forward).toBe(true)
  expect(nudges.length).toBe(0)
  // session cleared → a second reply forwards without another judge
  expect((await o.intercept("agent", "c1", "again")).forward).toBe(true)
})

test("working ⇒ swallows the reply and delivers the nudge", async () => {
  const { o, nudges } = harness({ run: async () => '{"status":"working","nudge":"fix the failing test"}' })
  o.begin("agent", "c1", "make tests pass")
  const v = await o.intercept("agent", "c1", "I wrote some code")
  expect(v.forward).toBe(false)
  expect(nudges).toEqual([{ agent: "agent", convId: "c1", text: "fix the failing test" }])
})

test("blocked ⇒ forwards (paused) and never prods", async () => {
  const { o, nudges } = harness({ run: async () => '{"status":"blocked","reason":"needs Stephen to decide"}' })
  o.begin("agent", "c1", "do the risky thing")
  const v = await o.intercept("agent", "c1", "Should I proceed? Awaiting your call.")
  expect(v.forward).toBe(true)
  expect(v.footer).toContain("awaiting a human")
  expect(nudges.length).toBe(0)
  // terminal: a follow-up reply isn't re-judged until a new goal begins
  expect((await o.intercept("agent", "c1", "still waiting")).forward).toBe(true)
})

test("stops after maxIterations and forwards with a footer", async () => {
  const { o, nudges } = harness({ run: async () => '{"status":"working"}', pol: { enabled: true, maxIterations: 2 } })
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
    run: async () => '{"status":"working","nudge":"more"}',
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
  const { o } = harness({ run: async () => '{"status":"working"}', pol: { enabled: false } })
  o.begin("agent", "c1", "g")
  expect((await o.intercept("agent", "c1", "r")).forward).toBe(true)
})
