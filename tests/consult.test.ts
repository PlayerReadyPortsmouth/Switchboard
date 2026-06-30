import { test, expect } from "bun:test"
import { mayConsult, ConsultRegistry, consultAnswerFromReply } from "../hub/consult"
import type { AgentConfig, AgentReply } from "../hub/types"

const target = (consultableBy?: string[]): AgentConfig => ({
  emoji: "🤖", description: "t", mode: "persistent",
  access: { roles: ["*"], consultableBy }, runtime: { cwd: "/" },
})

// ---- mayConsult (requester, targetName, targetConfig) ----

test("mayConsult allows a listed requester or a wildcard", () => {
  expect(mayConsult("a", "b", target(["a", "x"]))).toBe(true)
  expect(mayConsult("a", "b", target(["*"]))).toBe(true)
})

test("mayConsult denies an unlisted requester, empty/absent list, and unknown target", () => {
  expect(mayConsult("z", "b", target(["a"]))).toBe(false)
  expect(mayConsult("a", "b", target([]))).toBe(false)
  expect(mayConsult("a", "b", target(undefined))).toBe(false)
  expect(mayConsult("a", "b", undefined)).toBe(false)
})

test("mayConsult always denies a self-consult (even with a wildcard)", () => {
  expect(mayConsult("a", "a", target(["*"]))).toBe(false)
  expect(mayConsult("a", "a", target(["a"]))).toBe(false)
})

// ---- ConsultRegistry ----

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new ConsultRegistry(() => now, () => `q${++n}`, ttl)
  return { r, at: (v: number) => { now = v }, advance: (d: number) => { now += d } }
}

test("open stamps a virtual channel + deadline and is recognized", () => {
  const h = harness(1000)
  h.at(500)
  let got: string | undefined
  const e = h.r.open("a", "b", (ans) => { got = ans })
  expect(e.channel).toBe("consult:q1")
  expect(e.requester).toBe("a")
  expect(e.target).toBe("b")
  expect(e.expiresAt).toBe(1500)
  expect(h.r.isConsultChannel("consult:q1")).toBe(true)
  expect(h.r.isConsultChannel("guild:123")).toBe(false)
  expect(h.r.pendingCount()).toBe(1)
  expect(got).toBeUndefined()
})

test("settle resolves once with the answer (single-shot)", () => {
  const h = harness()
  let got: string | undefined
  const e = h.r.open("a", "b", (ans) => { got = ans })
  const settled = h.r.settle(e.channel, "the answer")
  expect(settled?.id).toBe(e.id)
  expect(got).toBe("the answer")
  expect(h.r.pendingCount()).toBe(0)
  expect(h.r.settle(e.channel, "again")).toBeNull()   // single-shot
})

test("settle of an unknown channel is a no-op", () => {
  const h = harness()
  expect(h.r.settle("consult:nope", "x")).toBeNull()
})

// ---- consultAnswerFromReply (a card answer must still settle the consult) ----

const reply = (over: Partial<AgentReply>): AgentReply => ({ agent: "b", kind: "reply", chatId: "consult:q1", ...over })

test("consultAnswerFromReply returns text for a text reply and serializes a card", () => {
  expect(consultAnswerFromReply(reply({ kind: "reply", text: "hello" }))).toBe("hello")
  expect(consultAnswerFromReply(reply({ kind: "card", card: { title: "Result", body: "all good", buttons: [] } }))).toBe("Result\n\nall good")
  expect(consultAnswerFromReply(reply({ kind: "update", card: { title: "T", body: "B", buttons: [] } }))).toBe("T\n\nB")
})

test("consultAnswerFromReply ignores non-answering reply kinds (consult keeps waiting)", () => {
  expect(consultAnswerFromReply(reply({ kind: "react", emoji: "✅" }))).toBeUndefined()
  expect(consultAnswerFromReply(reply({ kind: "reply", text: undefined }))).toBeUndefined()
  expect(consultAnswerFromReply(reply({ kind: "card", card: undefined }))).toBeUndefined()
})

// ---- inbound peer-ask settle contract (regression for the onAgentReply branch
// that settles a peerAskRegistry channel; the hub routes a local agent's reply on
// that channel through exactly this consultAnswerFromReply + settle sequence). ----

test("an agent reply on a pending inbound-ask channel settles it via the answer", () => {
  const h = harness()
  let sentBack: string | undefined
  // deliverPeerAsk opens the inbound local-consult; resolve POSTs back to replyTo.
  const e = h.r.open("peer:remote", "localAgent", (ans) => { sentBack = ans })
  // The local agent answers on that channel — the onAgentReply branch runs this:
  const agentReply = reply({ chatId: e.channel, kind: "reply", text: "remote, here is your answer" })
  const answer = consultAnswerFromReply(agentReply)
  expect(answer).toBe("remote, here is your answer")
  const settled = h.r.settle(e.channel, answer ?? "")
  expect(settled?.id).toBe(e.id)
  expect(sentBack).toBe("remote, here is your answer")
  expect(h.r.pendingCount()).toBe(0)
})

test("a card answer on a pending inbound-ask channel still settles it (serialized)", () => {
  const h = harness()
  let sentBack: string | undefined
  const e = h.r.open("peer:remote", "localAgent", (ans) => { sentBack = ans })
  const agentReply = reply({ chatId: e.channel, kind: "card", card: { title: "Done", body: "the result", buttons: [] } })
  const answer = consultAnswerFromReply(agentReply)
  const settled = h.r.settle(e.channel, answer ?? "")
  expect(settled?.id).toBe(e.id)
  expect(sentBack).toBe("Done\n\nthe result")
})

test("sweepExpired returns only past-deadline consults", () => {
  const h = harness(1000)
  h.at(0)
  const a = h.r.open("a", "b", () => {})
  h.at(600)
  const b = h.r.open("a", "c", () => {})   // expires 1600
  h.at(1200)
  const expired = h.r.sweepExpired()
  expect(expired.map((e) => e.id)).toEqual([a.id])
  expect(h.r.pendingCount()).toBe(1)
  expect(h.r.isConsultChannel(b.channel)).toBe(true)
})
