import { describe, expect, test } from "bun:test"
import { TurnLedger, parseUsageCommand, renderUsage, rollupTurns, type TurnRow } from "./turnLedger"

const AURORA = "186188409499418628"
const STEPHEN = "425368343789305865"
const usage = (costUsd: number, over = {}) => ({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, cacheCreationTokens: 10, costUsd, durationMs: 4200, ...over })

describe("TurnLedger.close", () => {
  test("one person behind the turn: attributed to them, with tokens, tools and cost", () => {
    const l = new TurnLedger()
    l.tools("Bill", ["Read", "Grep", "Read"])
    l.consulted("Bill", "Susie")
    const e = l.close({ key: "Bill", agent: "Bill", chat: "100000", usage: usage(0.05), speakers: [{ userId: AURORA }] })
    expect(e).toMatchObject({ kind: "turn", actor: `user:${AURORA}`, action: "answer", target: "Bill", chat: "100000", cost: 0.05 })
    expect(e.detail).toEqual({ tokensIn: 100, tokensOut: 40, tokensCacheRead: 900, tokensCacheWrite: 10, tools: { Read: 2, Grep: 1 }, consulted: ["Susie"], ms: 4200 })
  })

  test("cost is the turn's share of a running session total", () => {
    const l = new TurnLedger()
    const close = (c: number) => l.close({ key: "Bill", agent: "Bill", chat: "1", usage: usage(c), speakers: [{ userId: AURORA }] }).cost
    expect(close(0.05)).toBe(0.05)
    expect(close(0.08)).toBe(0.03)
    expect(close(0.02)).toBe(0.02)        // total went down ⇒ a fresh session
  })

  test("cost is tracked per process, so replicas do not subtract from each other", () => {
    const l = new TurnLedger()
    l.close({ key: "Bill", agent: "Bill", chat: "1", usage: usage(0.50), speakers: [] })
    const e = l.close({ key: "Bill#2", agent: "Bill", chat: "1", usage: usage(0.04), speakers: [{ userId: AURORA }] })
    expect(e.cost).toBe(0.04)
    expect(e.detail!.process).toBe("Bill#2")
  })

  test("tools and consults reset between turns", () => {
    const l = new TurnLedger()
    l.tools("Bill", ["Read"])
    l.close({ key: "Bill", agent: "Bill", chat: "1", speakers: [{ userId: AURORA }] })
    const e = l.close({ key: "Bill", agent: "Bill", chat: "1", speakers: [{ userId: AURORA }] })
    expect(e.detail!.tools).toBeUndefined()
  })

  test("a consult answer is attributed to the asking agent, with the person it was for", () => {
    const l = new TurnLedger()
    const e = l.close({ key: "Susie", agent: "Susie", chat: "consult:c1", usage: usage(0.01), speakers: [], consultedBy: "Bill", forUser: AURORA })
    expect(e).toMatchObject({ actor: "agent:Bill", action: "consult_answer", target: "Susie" })
    expect(e.detail!.forUser).toBe(AURORA)
  })

  test("nobody behind it is a system turn; two people is unattributed, with both listed", () => {
    const l = new TurnLedger()
    expect(l.close({ key: "Bill", agent: "Bill", chat: "1", speakers: [] }).actor).toBe("system")
    const e = l.close({ key: "Bill", agent: "Bill", chat: "1", speakers: [{ userId: AURORA }, { userId: STEPHEN }, { userId: AURORA }] })
    expect(e.actor).toBe("user:unattributed")
    expect(e.detail!.candidates).toEqual([AURORA, STEPHEN])
  })

  test("no usage reported: no cost field, and wall time falls back to when the turn began", () => {
    const l = new TurnLedger(() => 10_000)
    const e = l.close({ key: "Bill", agent: "Bill", chat: "1", speakers: [{ userId: AURORA, at: 4_000 }] })
    expect("cost" in e).toBe(false)
    expect(e.detail).toEqual({ ms: 6000 })
  })

  test("data tools called are listed by name only", () => {
    const l = new TurnLedger()
    l.data("Assistant", "tickets")
    expect(l.close({ key: "Assistant", agent: "Assistant", chat: "1", speakers: [{ userId: AURORA }] }).detail!.data).toEqual(["tickets"])
  })
})

describe("rollupTurns / renderUsage", () => {
  const rows = [
    { actor: `user:${AURORA}`, target: "Bill", cost: 0.05, detail: { tokensIn: 100, tokensOut: 40, tokensCacheRead: 900 } },
    { actor: "agent:Bill", target: "Susie", cost: 0.01, detail: { forUser: AURORA, tokensIn: 50, tokensOut: 10 } },
    { actor: `user:${STEPHEN}`, target: "Bill", cost: 0.20, detail: { tokensIn: 5000, tokensOut: 700 } },
    { actor: "system", target: "Geoff", cost: 0.02, detail: {} },
  ]
  test("a consult is charged to the person it was for", () => {
    const r = rollupTurns(rows)
    expect(r.byPerson[`user:${AURORA}`]).toEqual({ turns: 2, cost: 0.06, tokensIn: 1050, tokensOut: 50 })
    expect(r.byAgent.Susie.turns).toBe(1)
    expect(r.byAgent.Bill.turns).toBe(2)
    expect(Math.round(r.total.cost * 100)).toBe(28)
  })
  test("a consult with no known person is system usage", () => {
    expect(rollupTurns([{ actor: "agent:Bill", target: "Susie", cost: 0.01 }]).byPerson.system.turns).toBe(1)
  })
  test("render lists people and agents, costliest first, as mentions", () => {
    const text = renderUsage(rows, "today")
    expect(text.startsWith("**Usage, today**: 4 turns, $0.280")).toBe(true)
    expect(text.indexOf(`<@${STEPHEN}>`)).toBeLessThan(text.indexOf(`<@${AURORA}>`))
    expect(text).toContain("system: 1 turn, $0.020")
  })
  test("no rows says so and points at the config", () => {
    expect(renderUsage([], "today")).toContain("audit.kinds")
  })
})

test("parseUsageCommand", () => {
  expect(parseUsageCommand("!usage")).toEqual({ days: 1 })
  expect(parseUsageCommand("!usage today")).toEqual({ days: 1 })
  expect(parseUsageCommand(" !usage 7 ")).toEqual({ days: 7 })
  expect(parseUsageCommand("!usage 30d")).toEqual({ days: 30 })
  expect(parseUsageCommand("!usage lots")).toEqual({ days: 1 })
  expect(parseUsageCommand("usage")).toBeNull()
  expect(parseUsageCommand("!usages")).toBeNull()
})

import { raUsage } from "./gatewayActions"

describe("ReadyApp summary usage", () => {
  test("a generated summary is counted; a cached one and a plain read are not", () => {
    expect(raUsage({ usage: { model: "m", inputTokens: 900, outputTokens: 90, cacheReadInputTokens: 31, cacheCreationInputTokens: 0 }, summaryCached: false }))
      .toEqual({ model: "m", tokensIn: 931, tokensOut: 90 })
    expect(raUsage({ usage: { inputTokens: 900, outputTokens: 90 }, summaryCached: true })).toBeUndefined()
    expect(raUsage({ items: [] })).toBeUndefined()
    expect(raUsage(null)).toBeUndefined()
  })

  test("the turn carries the counts and !usage shows them apart from the cost", () => {
    const l = new TurnLedger(() => 1000)
    l.readyApp("A", { tokensIn: 931, tokensOut: 96 })
    l.readyApp("A", { tokensIn: 817, tokensOut: 250 })
    const rec = l.close({ key: "A", agent: "A", chat: "c", speakers: [{ userId: "42" }] })
    expect(rec.detail).toMatchObject({ raSummaries: 2, raTokensIn: 1748, raTokensOut: 346 })
    expect(rec.cost).toBeUndefined()
    const out = renderUsage([rec as TurnRow], "today")
    expect(out).toContain("**ReadyApp summaries** (tokens only, not in the cost above): 2, 1.7k in / 346 out")
    expect(out).toContain("<@42>: 2, 1.7k in / 346 out")
    // A turn with none leaves the report as it was.
    const plain = l.close({ key: "B", agent: "B", chat: "c", speakers: [{ userId: "42" }] })
    expect(renderUsage([plain as TurnRow], "today")).not.toContain("ReadyApp summaries")
  })
})
