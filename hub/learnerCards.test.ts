import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LearnerCards, learnedLine, learnerCustomId, parseLearnerCustomId } from "./learnerCards"
import type { LearnerReport } from "./learnerDiagnose"
import type { CardSpec } from "./types"

const T = Date.parse("2026-11-19T12:00:00Z")
const report: LearnerReport = {
  at: new Date(T).toISOString(), since: 0, failed: ["Stacy"],
  findings: [{ agent: "Assistant", total: 4, byKind: {}, tools: [], examples: [] }, { agent: "Bill", total: 1, byKind: {}, tools: [], examples: [] }],
  proposals: [
    { agent: "Assistant", type: "prompt_edit", summary: "Use mysessionstoday first", why: "two rephrases", text: "For next session,  call\nmysessionstoday.", evidence: 2 },
    { agent: "Assistant", type: "allow_tool", summary: "Allow rota", why: "", tool: "rota", evidence: 1 },
    { agent: "Bill", type: "prompt_edit", summary: "Say when a consult is refused", why: "", text: "Tell the person plainly.", evidence: 1 },
  ],
}

function rig(storePath = join(mkdtempSync(join(tmpdir(), "lrn-")), "pending.json")) {
  const sent: { chatId: string; card: CardSpec }[] = [], edited: CardSpec[] = [], applied: [string, string, string][] = [], audits: string[] = []
  let n = 0, fail: string | undefined
  const cards = new LearnerCards({
    storePath, now: () => T, genId: () => "p",
    sendCard: async (chatId, card) => { sent.push({ chatId, card }); return `m${++n}` },
    editCard: async (_c, _m, card) => { edited.push(card) },
    approversFor: (agent) => (agent === "Bill" ? ["boss"] : ["boss", "aurora"]),
    applyPromptEdit: (agent, text, by) => { if (fail) return fail; applied.push([agent, text, by]); return undefined },
    audit: (e) => audits.push(`${e.action}:${e.agent}:${e.outcome}`),
  })
  return { cards, sent, edited, applied, audits, storePath, failWith: (r: string) => { fail = r } }
}
const idOf = (card: CardSpec, verb: "Approve" | "Reject") => card.buttons.find(b => b.label === verb)!.customId

test("custom ids round-trip and foreign ids are ignored", () => {
  expect(parseLearnerCustomId(learnerCustomId("approve", "p1"))).toEqual({ verb: "approve", id: "p1" })
  expect(parseLearnerCustomId("gwa:confirm:p1")).toBeNull()
})

test("post: one summary, then a card per prompt change; tools are listed, never buttoned", async () => {
  const h = rig()
  expect(await h.cards.post("chan", report)).toBe(2)
  expect(h.sent).toHaveLength(3)
  const summary = h.sent[0]!.card
  expect(summary.buttons).toEqual([])
  expect(summary.body).toContain("5 misses: Assistant 4, Bill 1.")
  expect(summary.body).toContain("Nothing has been applied.")
  expect(summary.body).toContain("Assistant: Allow rota (`rota`)")
  expect(summary.body).toContain("did not run for: Stacy")
  expect(h.sent[1]!.card.buttons.map(b => b.label)).toEqual(["Approve", "Reject"])
  expect(h.sent[1]!.card.fields![0]!.value).toContain("mysessionstoday")
})

describe("deciding", () => {
  test("only an approver for that agent may press", async () => {
    const h = rig(); await h.cards.post("chan", report)
    const bill = idOf(h.sent[2]!.card, "Approve")
    expect(h.cards.mayPress(bill, "aurora")).toBe(false)
    expect(h.cards.click(bill, "aurora")).toBe("Only an approver can decide this.")
    expect(h.applied).toEqual([])
    expect(h.cards.mayPress(bill, "boss")).toBe(true)
  })

  test("approve adds the dated wording once and closes the card", async () => {
    const h = rig(); await h.cards.post("chan", report)
    const id = idOf(h.sent[1]!.card, "Approve")
    expect(h.cards.click(id, "aurora")).toBeUndefined()
    expect(h.applied).toEqual([["Assistant", "LEARNED 2026-11-19: For next session, call mysessionstoday.", "aurora"]])
    expect(h.edited[0]!.buttons).toEqual([])
    expect(h.edited[0]!.body).toContain("Approved by <@aurora>")
    expect(h.audits).toEqual(["learner.approve:Assistant:ok"])
    expect(h.cards.click(id, "boss")).toBe("This proposal has already been decided.")
    expect(h.applied).toHaveLength(1)
  })

  test("reject changes nothing; a failed apply says so", async () => {
    const h = rig(); await h.cards.post("chan", report)
    expect(h.cards.click(idOf(h.sent[1]!.card, "Reject"), "boss")).toBeUndefined()
    expect(h.applied).toEqual([])
    expect(h.edited[0]!.body).toContain("Rejected by <@boss>")
    h.failWith("disk full")
    h.cards.click(idOf(h.sent[2]!.card, "Approve"), "boss")
    expect(h.edited[1]!.body).toContain("Not applied")
    expect(h.audits[1]).toBe("learner.approve:Bill:error")
  })

  test("open cards still work after a restart", async () => {
    const h = rig(); await h.cards.post("chan", report)
    const id = idOf(h.sent[1]!.card, "Approve")
    const again = rig(h.storePath)
    expect(again.cards.mayPress(id, "aurora")).toBe(true)
    expect(again.cards.click(id, "aurora")).toBeUndefined()
    expect(again.applied).toHaveLength(1)
    expect(again.cards.click("lrn:approve:nope", "aurora")).toBe("This proposal is no longer open.")
  })
})

test("learnedLine is dated and single-line", () => {
  expect(learnedLine("a\n b", T)).toBe("LEARNED 2026-11-19: a b")
})
