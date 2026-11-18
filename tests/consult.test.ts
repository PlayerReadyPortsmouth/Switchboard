import { test, expect } from "bun:test"
import { mayConsult, ConsultRegistry, consultAnswerFromReply, TurnSpeakers, speakerBlocking, reachNote } from "../hub/consult"
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

// ---- caller access: the person behind the turn, not only the agent ----

const who = (userId: string, chatId: string, permitted: string[]) => ({ userId, chatId, permitted, at: 0 })

test("speakerBlocking: a person may only be served by agents they are permitted", () => {
  const aurora = who("aurora", "100000", ["Bill", "Ted"])
  expect(speakerBlocking([aurora], "Bill")).toBeNull()
  expect(speakerBlocking([aurora], "Susie")?.userId).toBe("aurora")
})

test("speakerBlocking: nobody behind the turn leaves the agent-level check to decide", () => {
  expect(speakerBlocking([], "Susie")).toBeNull()
})

test("speakerBlocking: when two people could be behind a consult, both must be allowed", () => {
  const stephen = who("stephen", "100000", ["Bill", "Susie"])
  const aurora = who("aurora", "100000", ["Bill"])
  expect(speakerBlocking([stephen], "Susie")).toBeNull()
  expect(speakerBlocking([stephen, aurora], "Susie")?.userId).toBe("aurora")
})

test("TurnSpeakers narrows to the chat the consulting process is serving", () => {
  const s = new TurnSpeakers(() => 1000)
  s.begin("Bill", { userId: "aurora", chatId: "100000", permitted: ["Bill"] })
  s.begin("Bill", { userId: "stephen", chatId: "200000", permitted: ["Bill", "Susie"] })
  expect(s.behind("Bill", "100000").map(x => x.userId)).toEqual(["aurora"])
  expect(s.behind("Bill", "200000").map(x => x.userId)).toEqual(["stephen"])
  expect(s.behind("Bill").map(x => x.userId)).toEqual(["aurora", "stephen"])
  expect(s.behind("Bill", "300000")).toEqual([])
})

test("TurnSpeakers: end removes that chat's turn only", () => {
  const s = new TurnSpeakers(() => 1000)
  s.begin("Bill", { userId: "aurora", chatId: "100000", permitted: [] })
  s.begin("Bill", { userId: "stephen", chatId: "200000", permitted: [] })
  s.end("Bill", "100000")
  expect(s.behind("Bill").map(x => x.userId)).toEqual(["stephen"])
  s.end("Bill", "200000")
  expect(s.behind("Bill")).toEqual([])
})

test("TurnSpeakers: a turn that never replied ages out instead of pinning a stale speaker", () => {
  let now = 1000
  const s = new TurnSpeakers(() => now, 60_000)
  s.begin("Bill", { userId: "aurora", chatId: "100000", permitted: [] })
  now += 61_000
  expect(s.behind("Bill")).toEqual([])
})

test("TurnSpeakers keeps agents separate and ignores an end for an unknown turn", () => {
  const s = new TurnSpeakers(() => 1000)
  s.begin("Bill", { userId: "aurora", chatId: "100000", permitted: [] })
  s.end("Susie", "100000")
  s.end("Bill", "999999")
  expect(s.behind("Bill").map(x => x.userId)).toEqual(["aurora"])
  expect(s.behind("Susie")).toEqual([])
})

// ---- reachNote: tell the agent who it may consult for THIS person ----

const team: any = {
  Ted: { access: { roles: [], consultableBy: ["Bill"] } },
  Bill: { access: { roles: [], consultableBy: ["Ted"] } },
  Susie: { access: { roles: [], consultableBy: ["Ted", "Bill"] } },
  Geoff: { access: { roles: [] } },                       // consultable by nobody
}

test("reachNote lists who can and cannot be consulted for this person", () => {
  const note = reachNote("Ted", team, ["Ted", "Bill"])
  expect(note).toContain("you may consult: Bill.")
  expect(note).toContain("do not have access to: Susie.")
  expect(note).toContain("Do not offer to ask that colleague")
  expect(note).not.toContain("Geoff")                     // not a colleague Ted may consult at all
  expect(note.startsWith("\n\n[hub] ")).toBe(true)
})

test("reachNote: everyone reachable ⇒ no warning", () => {
  const note = reachNote("Ted", team, ["Ted", "Bill", "Susie"])
  expect(note).toContain("you may consult: Bill, Susie.")
  expect(note).not.toContain("do not have access")
})

test("reachNote: nobody reachable is said plainly", () => {
  expect(reachNote("Ted", team, ["Ted"])).toContain("you may consult: nobody.")
})

test("reachNote: an agent with no colleagues gets no note", () => {
  expect(reachNote("Geoff", { Geoff: team.Geoff }, ["Geoff"])).toBe("")
})
