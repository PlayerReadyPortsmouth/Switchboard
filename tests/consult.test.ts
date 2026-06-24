import { test, expect } from "bun:test"
import { mayConsult, ConsultRegistry } from "../hub/consult"
import type { AgentConfig } from "../hub/types"

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
