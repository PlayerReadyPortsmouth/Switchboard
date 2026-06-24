import { test, expect } from "bun:test"
import { TurnGate } from "../hub/turnGate"
import type { InboundMessage } from "../hub/types"

function msg(content: string, chatId = "c1", userId = "u1"): InboundMessage {
  return { chatId, messageId: content, userId, user: userId, content, ts: "", isDM: false }
}

function gate(opts: { maxQueueDepth?: number; coalesce?: boolean } = {}) {
  const sent: string[] = []
  const g = new TurnGate({ send: (m) => sent.push(m.content), ...opts })
  return { g, sent }
}

test("first submit sends immediately and marks busy", () => {
  const { g, sent } = gate()
  expect(g.submit(msg("a"))).toBe("sent")
  expect(g.isBusy()).toBe(true)
  expect(sent).toEqual(["a"])
})

test("submits while busy queue in order and drain on turnComplete", () => {
  const { g, sent } = gate()
  g.submit(msg("a"))
  expect(g.submit(msg("b"))).toBe("queued")
  expect(g.submit(msg("c"))).toBe("queued")
  expect(g.queueDepth()).toBe(2)
  expect(sent).toEqual(["a"])           // only the first is in flight

  g.turnComplete()                       // a done → b sent
  expect(sent).toEqual(["a", "b"])
  expect(g.isBusy()).toBe(true)
  g.turnComplete()                       // b done → c sent
  expect(sent).toEqual(["a", "b", "c"])
  g.turnComplete()                       // c done → idle
  expect(g.isBusy()).toBe(false)
  expect(g.queueDepth()).toBe(0)
})

test("queue cap rejects overflow without dropping earlier work", () => {
  const { g, sent } = gate({ maxQueueDepth: 2 })
  g.submit(msg("a"))                     // in flight
  expect(g.submit(msg("b"))).toBe("queued")
  expect(g.submit(msg("c"))).toBe("queued")
  expect(g.submit(msg("d"))).toBe("overflow")
  expect(g.queueDepth()).toBe(2)
  expect(sent).toEqual(["a"])
})

test("coalesce folds consecutive same-conversation same-user messages", () => {
  const { g, sent } = gate({ coalesce: true })
  g.submit(msg("a"))                     // in flight
  g.submit(msg("b1"))                    // queued
  g.submit(msg("b2"))                    // folded into b1
  expect(g.queueDepth()).toBe(1)
  g.turnComplete()
  expect(sent).toEqual(["a", "b1\nb2"])
})

test("coalesce does not merge across conversations or users", () => {
  const { g } = gate({ coalesce: true })
  g.submit(msg("a"))
  g.submit(msg("b", "c1", "u1"))
  g.submit(msg("c", "c2", "u1"))         // different conv → not merged
  g.submit(msg("d", "c2", "u2"))         // different user → not merged
  expect(g.queueDepth()).toBe(3)
})

test("turnComplete is a no-op when idle", () => {
  const { g, sent } = gate()
  g.turnComplete()
  expect(g.isBusy()).toBe(false)
  expect(sent).toEqual([])
})

test("reset clears in-flight and queued state", () => {
  const { g } = gate()
  g.submit(msg("a")); g.submit(msg("b"))
  g.reset()
  expect(g.isBusy()).toBe(false)
  expect(g.queueDepth()).toBe(0)
})
