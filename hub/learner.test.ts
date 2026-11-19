import { describe, expect, test } from "bun:test"
import { collectMisses, missesFromAudit, missesFromConversation, renderFindings, similarity, summariseMisses, type AuditRow, type ConvRow } from "./learner"

const T = 1_795_000_000_000
const read = (outcome: string, target: string, detail: Record<string, unknown>, ts = T): AuditRow =>
  ({ ts, kind: "access", actor: "user:u1", action: "readyapp.read", outcome, target, detail: { agent: "Assistant", ...detail } })

describe("missesFromAudit", () => {
  test("sorts refusals into allow-list, ReadyApp and error", () => {
    const m = missesFromAudit([
      read("ok", "tickets", {}),
      read("deny", "finance", { reason: "not_in_agent_scope" }),
      read("error", "tickets", { code: "missing_token", status: 401 }),
      { ts: T, kind: "exec", actor: "user:u1", action: "readyapp.propose", outcome: "deny", target: "ticket.reply", detail: { agent: "Assistant", reason: "not_in_catalog" } },
    ])
    expect(m.map(x => [x.kind, x.tool, x.agent])).toEqual([
      ["tool_not_allowed", "finance", "Assistant"],
      ["tool_error", "tickets", "Assistant"],
      ["tool_off_in_readyapp", "ticket.reply", "Assistant"],
    ])
    expect(m[0]!.userId).toBe("u1")
  })

  test("ignores the sole-speaker safety refusal and rows before `since`", () => {
    expect(missesFromAudit([
      { ts: T, kind: "exec", action: "readyapp.propose", outcome: "deny", target: "x", detail: { reason: "no_sole_speaker" } },
      read("deny", "finance", { reason: "not_in_agent_scope" }, T - 10),
    ], { since: T })).toEqual([])
  })

  test("slow turns, cancelled cards and refused consults", () => {
    const m = missesFromAudit([
      { ts: T, kind: "turn", actor: "user:u1", action: "answer", outcome: "ok", target: "Assistant", chat: "c1", detail: { ms: 61_000 } },
      { ts: T, kind: "turn", actor: "user:u1", action: "answer", outcome: "ok", target: "Assistant", chat: "c1", detail: { ms: 9_000 } },
      { ts: T, kind: "exec", actor: "user:u1", action: "readyapp.cancel", outcome: "ok", target: "ticket.update", detail: { agent: "Assistant" } },
      { ts: T, kind: "consult", actor: "agent:Bill", action: "ask", outcome: "deny", target: "Susie", detail: { reason: "caller_not_permitted", user: "u1", chat: "c1" } },
    ])
    expect(m.map(x => [x.kind, x.agent])).toEqual([["slow_turn", "Assistant"], ["card_cancelled", "Assistant"], ["consult_refused", "Bill"]])
    expect(m[0]!.reason).toBe("61s")
    expect(m[2]!.userId).toBe("u1")
  })
})

describe("missesFromConversation", () => {
  const u = (text: string, ts: number): ConvRow => ({ role: "user", text, ts, userId: "u1" })
  const a = (text: string, ts: number): ConvRow => ({ role: "agent", text, ts, agent: "Assistant" })

  test("the agent saying it cannot", () => {
    const m = missesFromConversation("c1", [u("Suggest a reply to the Lucas ticket", T), a("I can only see ticket titles, so I can't draft that.", T + 5)])
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ kind: "agent_said_cannot", agent: "Assistant", chat: "c1", userText: "Suggest a reply to the Lucas ticket" })
  })

  test("a correction and a rephrase", () => {
    const m = missesFromConversation("c1", [
      u("What is my next session?", T), a("You have 12 sessions this week.", T + 5),
      u("No, just the next one", T + 60_000), a("Your next session is 4pm.", T + 65_000),
      u("what sessions do I have tomorrow", T + 120_000), a("Here is today.", T + 125_000),
      u("What sessions do I have tomorrow?", T + 180_000),
    ])
    expect(m.map(x => x.kind)).toEqual(["user_corrected", "user_rephrased"])
  })

  test("a new question, or one long after, is not a miss", () => {
    expect(missesFromConversation("c1", [
      u("What is my next session?", T), a("4pm at Taunton.", T + 5),
      u("What tickets do I have?", T + 60_000), a("Two.", T + 65_000),
      u("What tickets do I have?", T + 3_600_000),
    ])).toEqual([])
  })
})

test("similarity ignores filler words and punctuation", () => {
  expect(similarity("What sessions do I have tomorrow?", "what sessions do i have tomorrow")).toBe(1)
  expect(similarity("What is my next session?", "What tickets do I have?")).toBeLessThan(0.3)
})

test("collect, summarise and render", () => {
  const misses = collectMisses(
    [read("deny", "finance", { reason: "not_in_agent_scope" }), read("deny", "finance", { reason: "not_in_agent_scope" }, T + 1)],
    { c1: [{ role: "user", text: "pay?", ts: T, userId: "u1" }, { role: "agent", text: "I cannot see pay.", ts: T + 2, agent: "Assistant" }] },
  )
  const f = summariseMisses(misses)
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ agent: "Assistant", total: 3, byKind: { tool_not_allowed: 2, agent_said_cannot: 1 } })
  expect(f[0]!.tools[0]).toEqual({ tool: "finance", kind: "tool_not_allowed", count: 2 })
  const text = renderFindings(f)
  expect(text).toContain("Assistant: 3 misses")
  expect(text).toContain("finance (tool_not_allowed, 2)")
  expect(renderFindings([])).toBe("No misses recorded.")
})
