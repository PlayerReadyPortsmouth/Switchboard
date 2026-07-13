import { expect, test } from "bun:test"
import { ConversationStream, type ConversationStreamHandlers, type EventSourceHandlers, type EventSourceLike } from "./conversationStream"
import { initialWorkspaceState, workspaceReducer } from "./state"
import type { ConversationEvent, Message } from "./types"

const messageAt = (sequence: number, id = `m${sequence}`): Message => ({
  id, conversationId: "c1", sequence, author: "owner", origin: "web", content: String(sequence), replyTo: null,
  state: "committed", clientKey: `k${sequence}`, createdAt: sequence * 10,
})

const handlers: ConversationStreamHandlers = { onMessages: () => {}, onEvent: () => {}, onState: () => {} }

test("reconnect fetches the durable gap before opening SSE", async () => {
  const order: string[] = []
  const fakeSource: EventSourceLike = { close: () => {} }
  const stream = new ConversationStream({
    fetchGap: async after => (order.push(`gap:${after}`), [messageAt(4)]),
    open: (_url, _handlers) => (order.push("sse"), fakeSource),
    online: () => true,
  })
  await stream.start("c1", 3, handlers)
  expect(order).toEqual(["gap:3", "sse"])
})

test("message events advance reconnect cursor while activity does not", async () => {
  const urls: string[] = []
  const gaps: number[] = []
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const states: string[] = []
  const stream = new ConversationStream({
    fetchGap: async after => (gaps.push(after), []),
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), timers.length),
    clearTimer: () => {},
  })
  await stream.start("c/1", 3, { ...handlers, onState: state => states.push(state) })
  opened[0].open()
  opened[0].message(JSON.stringify({ kind: "activity", conversationId: "c/1", sequence: 9, ts: 1 } satisfies ConversationEvent))
  opened[0].message(JSON.stringify({ kind: "message_committed", conversationId: "c/1", sequence: 4, ts: 2, message: messageAt(4) } satisfies ConversationEvent))
  opened[0].error()
  await timers[0]()

  expect(gaps).toEqual([3, 4])
  expect(urls).toEqual([
    "/api/conversations/c%2F1/events?after=3",
    "/api/conversations/c%2F1/events?after=4",
  ])
  expect(states).toEqual(["connecting", "live", "reconnecting"])
})

test("offline errors close the source without scheduling a reconnect", async () => {
  let sourceHandlers!: EventSourceHandlers
  let closed = 0
  let timers = 0
  const states: string[] = []
  const stream = new ConversationStream({
    fetchGap: async () => [],
    open: (_url, value) => (sourceHandlers = value, { close: () => { closed++ } }),
    online: () => false,
    setTimer: () => (++timers),
    clearTimer: () => {},
  })
  await stream.start("c1", 0, { ...handlers, onState: state => states.push(state) })
  sourceHandlers.error()
  expect(closed).toBe(1)
  expect(timers).toBe(0)
  expect(states).toEqual(["connecting", "offline"])
})

test("stop closes the source and clears a pending reconnect timer", async () => {
  let sourceHandlers!: EventSourceHandlers
  let closed = 0
  const cleared: unknown[] = []
  const stream = new ConversationStream({
    fetchGap: async () => [],
    open: (_url, value) => (sourceHandlers = value, { close: () => { closed++ } }),
    online: () => true,
    setTimer: () => "timer-1",
    clearTimer: timer => cleared.push(timer),
  })
  await stream.start("c1", 0, handlers)
  sourceHandlers.error()
  stream.stop()
  expect(closed).toBe(1)
  expect(cleared).toEqual(["timer-1"])
})

test("repeated source errors schedule only one reconnect", async () => {
  let sourceHandlers!: EventSourceHandlers
  let timers = 0
  const stream = new ConversationStream({
    fetchGap: async () => [],
    open: (_url, value) => (sourceHandlers = value, { close() {} }),
    online: () => true,
    setTimer: () => ++timers,
    clearTimer: () => {},
  })
  await stream.start("c1", 0, handlers)
  sourceHandlers.error()
  sourceHandlers.error()
  expect(timers).toBe(1)
})

test("a stopped gap fetch cannot emit or open a source for a later selection", async () => {
  let resolveFirst!: (messages: Message[]) => void
  const firstGap = new Promise<Message[]>(resolve => { resolveFirst = resolve })
  const gaps: Record<string, Promise<Message[]>> = { c1: firstGap, c2: Promise.resolve([]) }
  const opened: string[] = []
  const emitted: Message[][] = []
  const stream = new ConversationStream({
    fetchGap: (_after, conversationId) => gaps[conversationId],
    open: url => (opened.push(url), { close() {} }),
    online: () => true,
  })

  const firstStart = stream.start("c1", 0, { ...handlers, onMessages: messages => emitted.push(messages) })
  await stream.start("c2", 0, { ...handlers, onMessages: messages => emitted.push(messages) })
  resolveFirst([messageAt(1)])
  await firstStart

  expect(emitted).toEqual([])
  expect(opened).toEqual(["/api/conversations/c2/events?after=0"])
})

test("workspaceReducer deduplicates history and SSE messages by ID and sorts by sequence", () => {
  const state = workspaceReducer(initialWorkspaceState, { type: "messages/received", messages: [messageAt(3), messageAt(1)] })
  const next = workspaceReducer(state, { type: "messages/received", messages: [messageAt(2), messageAt(3)] })
  expect(next.messages.map(message => message.id)).toEqual(["m1", "m2", "m3"])
})

test("selecting a conversation clears messages and stale activity from the previous conversation", () => {
  const selected = workspaceReducer(initialWorkspaceState, { type: "conversation/selected", conversationId: "c1" })
  const withMessages = workspaceReducer(selected, { type: "messages/received", messages: [messageAt(1)] })
  const withActivity = workspaceReducer(withMessages, { type: "activity/received", event: { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 2, state: "working" } })
  const next = workspaceReducer(withActivity, { type: "conversation/selected", conversationId: "c2" })
  expect(next.selectedConversationId).toBe("c2")
  expect(next.messages).toEqual([])
  expect(next.activity).toEqual([])
})
