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
