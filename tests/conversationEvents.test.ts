import { expect, test } from "bun:test"
import { ConversationEventStream } from "../hub/conversations/events"
import type { Message } from "../hub/conversations/types"

const message = (sequence: number): Message => ({
  id: `m${sequence}`,
  conversationId: "c1",
  sequence,
  author: "owner",
  origin: "web",
  content: `${sequence}`,
  replyTo: null,
  state: "committed",
  clientKey: `k${sequence}`,
  createdAt: sequence * 10,
})

test("subscribe replays committed messages after the requested sequence then streams new ones", () => {
  const history = [message(1), message(2)]
  const stream = new ConversationEventStream((conversationId, after) => history.filter((m) => m.conversationId === conversationId && m.sequence > after))
  const seen: number[] = []
  const stop = stream.subscribe("c1", 1, (event) => seen.push(event.sequence))
  stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 3, ts: 30, message: message(3) })
  stop()
  expect(seen).toEqual([2, 3])
})

test("subscribe suppresses a live event already covered by replay", () => {
  let stream!: ConversationEventStream
  const history = [message(2)]
  stream = new ConversationEventStream((_conversationId, _after) => {
    stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 2, ts: 20, message: message(2) })
    return history
  })
  const seen: number[] = []
  stream.subscribe("c1", 1, (event) => seen.push(event.sequence))
  expect(seen).toEqual([2])
})

test("subscribe paginates the complete persisted gap and suppresses live overlap exactly once", () => {
  const history = Array.from({ length: 750 }, (_, index) => message(index + 1))
  const seen: number[] = []
  let pages = 0
  let stream!: ConversationEventStream
  stream = new ConversationEventStream((_conversationId, after, limit) => {
    pages++
    if (after === 500) {
      stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 750, ts: 750, message: message(750) })
      stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 751, ts: 751, message: message(751) })
    }
    return history.filter(item => item.sequence > after).slice(0, limit)
  })

  stream.subscribe("c1", 0, event => seen.push(event.sequence))

  expect(pages).toBe(2)
  expect(seen).toEqual(Array.from({ length: 751 }, (_, index) => index + 1))
})

test("reentrant publish preserves sequence order for every subscriber", () => {
  const stream = new ConversationEventStream(() => [])
  const seenA: number[] = []
  const seenB: number[] = []
  stream.subscribe("c1", 0, (event) => {
    seenA.push(event.sequence)
    if (event.sequence === 1) stream.publish({ kind: "activity", conversationId: "c1", sequence: 2, ts: 20 })
  })
  stream.subscribe("c1", 0, (event) => seenB.push(event.sequence))

  stream.publish({ kind: "activity", conversationId: "c1", sequence: 1, ts: 10 })

  expect(seenA).toEqual([1, 2])
  expect(seenB).toEqual([1, 2])
})

test("a throwing subscriber does not escape publish or starve another subscriber", () => {
  const stream = new ConversationEventStream(() => [])
  const seen: number[] = []
  stream.subscribe("c1", 0, () => { throw new Error("subscriber failed") })
  stream.subscribe("c1", 0, (event) => seen.push(event.sequence))

  expect(() => stream.publish({ kind: "activity", conversationId: "c1", sequence: 1, ts: 10 })).not.toThrow()
  expect(seen).toEqual([1])
})

test("live activity at the committed message sequence is delivered while replay remains message-only", () => {
  const history = [message(1)]
  const stream = new ConversationEventStream((_conversationId, after) => history.filter(item => item.sequence > after))
  const live: string[] = []
  stream.subscribe("c1", 1, event => live.push(event.kind === "turn_state" ? event.state! : event.kind))

  stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 2, ts: 20, message: message(2) })
  stream.publish({ kind: "turn_state", conversationId: "c1", sequence: 2, ts: 21, state: "queued" })
  stream.publish({ kind: "turn_state", conversationId: "c1", sequence: 2, ts: 22, state: "working" })
  stream.publish({ kind: "turn_state", conversationId: "c1", sequence: 2, ts: 23, state: "failed" })
  history.push(message(2))

  const replay: string[] = []
  stream.subscribe("c1", 1, event => replay.push(event.kind))

  expect(live).toEqual(["message_committed", "queued", "working", "failed"])
  expect(replay).toEqual(["message_committed"])
})

test("live activity below a newer durable message cursor is still delivered once", () => {
  const stream = new ConversationEventStream(() => [])
  const seen: string[] = []
  stream.subscribe("c1", 0, event => seen.push(`${event.kind}:${event.sequence}:${event.state ?? ""}`))
  stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 2, ts: 20, message: message(2) })
  stream.publish({ kind: "turn_state", conversationId: "c1", sequence: 1, ts: 21, state: "completed" })
  expect(seen).toEqual(["message_committed:2:", "turn_state:1:completed"])
})

test("activity published reentrantly during replay follows the replayed messages without sequence filtering", () => {
  let stream!: ConversationEventStream
  const history = [message(2)]
  stream = new ConversationEventStream(() => {
    stream.publish({ kind: "turn_state", conversationId: "c1", sequence: 1, ts: 21, state: "completed" })
    return history
  })
  const seen: string[] = []
  stream.subscribe("c1", 0, event => seen.push(`${event.kind}:${event.sequence}`))
  expect(seen).toEqual(["message_committed:2", "turn_state:1"])
})
