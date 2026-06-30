import { expect, test } from "bun:test"
import { PeerSpool } from "./peerSpool"
import type { PeerEnvelope } from "./peering"

const env = (corrId: string): PeerEnvelope =>
  ({ from: "a", to: "b:agent", corrId, kind: "notify", text: "hi", ts: 0 })

function make(send: any, onDeadLetter = () => {}, now = () => 0) {
  return new PeerSpool({ now, maxAttempts: 3, baseDelayMs: 100, send, onDeadLetter })
}

test("successful send removes the item", async () => {
  const s = make(async () => true)
  s.enqueue("b:agent", env("c1"))
  await s.drainOnce()
  expect(s.size()).toBe(0)
})

test("failure keeps the item and backs off; not retried before nextAt", async () => {
  let t = 0; let calls = 0
  const s = new PeerSpool({ now: () => t, maxAttempts: 3, baseDelayMs: 100,
    send: async () => { calls++; return false }, onDeadLetter: () => {} })
  s.enqueue("b:agent", env("c1"))
  await s.drainOnce()                 // attempt 1 → fail, schedule at t+100
  expect(s.size()).toBe(1); expect(calls).toBe(1)
  await s.drainOnce()                 // still t=0, not due → no new call
  expect(calls).toBe(1)
  t = 100
  await s.drainOnce()                 // due → attempt 2
  expect(calls).toBe(2)
})

test("dead-letters after maxAttempts", async () => {
  let t = 0; const dead: string[] = []
  const s = new PeerSpool({ now: () => t, maxAttempts: 2, baseDelayMs: 10,
    send: async () => false, onDeadLetter: (i) => dead.push(i.body.corrId) })
  s.enqueue("b:agent", env("c9"))
  await s.drainOnce()                 // attempt 1
  t = 1000; await s.drainOnce()       // attempt 2 → reaches max → dead-letter
  expect(s.size()).toBe(0)
  expect(dead).toEqual(["c9"])
})

test("snapshot/restore round-trips pending items", () => {
  const s = make(async () => false)
  s.enqueue("b:agent", env("c1"))
  const snap = s.snapshot()
  const s2 = make(async () => false)
  s2.restore(snap)
  expect(s2.size()).toBe(1)
})
