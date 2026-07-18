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

test("prefixes the conversation stream URL with a non-root base path", async () => {
  const urls: string[] = []
  const stream = new ConversationStream({
    fetchGap: async () => [],
    open: (url, _handlers) => (urls.push(url), { close() {} }),
    online: () => true,
  }, "/switchboard/")
  await stream.start("c/1", 3, handlers)
  expect(urls).toEqual(["/switchboard/api/conversations/c%2F1/events?after=3"])
})

test("leaves the conversation stream URL unprefixed for the default base path", async () => {
  const urls: string[] = []
  const stream = new ConversationStream({
    fetchGap: async () => [],
    open: (url, _handlers) => (urls.push(url), { close() {} }),
    online: () => true,
  }, "/")
  await stream.start("c/1", 3, handlers)
  expect(urls).toEqual(["/api/conversations/c%2F1/events?after=3"])
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

test("attachment events surface via onEvent without advancing the reconnect cursor", async () => {
  const gaps: number[] = []
  const opened: EventSourceHandlers[] = []
  const events: ConversationEvent[] = []
  const timers: Array<() => void | Promise<void>> = []
  const stream = new ConversationStream({
    fetchGap: async after => (gaps.push(after), []),
    open: (_url, sourceHandlers) => (opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), timers.length),
    clearTimer: () => {},
  })
  await stream.start("c1", 3, { ...handlers, onEvent: event => events.push(event) })
  opened[0].open()
  opened[0].message(JSON.stringify({
    kind: "attachment", conversationId: "c1", sequence: 1_700_000_000_000, ts: 1,
    attachment: { token: "tok1", title: "Doc", contentType: "application/pdf", mode: "view", visibility: "org" },
  } satisfies ConversationEvent))
  opened[0].error()
  await timers[0]()

  expect(events.map(event => event.kind)).toEqual(["attachment"])
  expect(events[0].attachment?.token).toBe("tok1")
  // Reconnect refetches from the ORIGINAL cursor — an attachment's Date.now() sequence must not move it.
  expect(gaps).toEqual([3, 3])
})

test("duplicate attachment events (same token) collapse to one in the reducer; non-attachment stays in activity", () => {
  const attachment = (token: string): ConversationEvent => ({
    kind: "attachment", conversationId: "c1", sequence: Date.now(), ts: 1,
    attachment: { token, title: "Doc", contentType: "application/pdf", mode: "view", visibility: "org" },
  })
  let state = workspaceReducer(initialWorkspaceState, { type: "activity/received", event: attachment("tok1") })
  state = workspaceReducer(state, { type: "activity/received", event: attachment("tok1") })
  state = workspaceReducer(state, { type: "activity/received", event: attachment("tok2") })
  state = workspaceReducer(state, { type: "activity/received", event: { kind: "activity", conversationId: "c1", sequence: 5, ts: 2 } })
  expect(state.attachments.map(a => a.token)).toEqual(["tok1", "tok2"])
  expect(state.activity.map(e => e.kind)).toEqual(["activity"])
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
    subscribeOnline: () => () => {},
    setTimer: () => (++timers),
    clearTimer: () => {},
  })
  await stream.start("c1", 0, { ...handlers, onState: state => states.push(state) })
  sourceHandlers.error()
  expect(closed).toBe(1)
  expect(timers).toBe(0)
  expect(states).toEqual(["connecting", "offline"])
})

test("an online event resumes offline streams gap-first exactly once and releases its listener", async () => {
  let sourceHandlers!: EventSourceHandlers
  let online = false
  let onlineListener!: () => void | Promise<void>
  let listeners = 0
  let removals = 0
  const order: string[] = []
  const stream = new ConversationStream({
    fetchGap: async after => (order.push(`gap:${after}`), []),
    open: (_url, value) => (order.push("sse"), sourceHandlers = value, { close() {} }),
    online: () => online,
    subscribeOnline: callback => {
      listeners++
      onlineListener = callback
      return () => { removals++ }
    },
  })
  await stream.start("c1", 3, { ...handlers, onState: state => order.push(state) })
  order.length = 0

  sourceHandlers.error()
  online = true
  order.push("online")
  await onlineListener()
  await onlineListener()

  expect(order).toEqual(["offline", "online", "reconnecting", "gap:3", "sse"])
  expect(listeners).toBe(1)
  expect(removals).toBe(1)
})

test("a late source error cannot race an online gap recovery", async () => {
  let sourceHandlers!: EventSourceHandlers
  let online = false
  let onlineListener!: () => void | Promise<void>
  let resolveRecovery!: (messages: Message[]) => void
  const recoveryGap = new Promise<Message[]>(resolve => { resolveRecovery = resolve })
  let gaps = 0
  let timers = 0
  let sources = 0
  const stream = new ConversationStream({
    fetchGap: async () => ++gaps === 1 ? [] : recoveryGap,
    open: (_url, value) => (sources++, sourceHandlers = value, { close() {} }),
    online: () => online,
    subscribeOnline: callback => (onlineListener = callback, () => {}),
    setTimer: () => ++timers,
    clearTimer: () => {},
  })
  await stream.start("c1", 0, handlers)
  const staleHandlers = sourceHandlers
  staleHandlers.error()
  online = true
  const recovery = onlineListener()
  staleHandlers.error()

  expect(timers).toBe(0)
  resolveRecovery([])
  await recovery
  expect(sources).toBe(2)
  staleHandlers.error()
  expect(timers).toBe(0)
})

test("stop removes the owned online listener", async () => {
  let sourceHandlers!: EventSourceHandlers
  let removals = 0
  const stream = new ConversationStream({
    fetchGap: async () => [],
    open: (_url, value) => (sourceHandlers = value, { close() {} }),
    online: () => false,
    subscribeOnline: () => () => { removals++ },
  })
  await stream.start("c1", 0, handlers)
  sourceHandlers.error()
  stream.stop()
  expect(removals).toBe(1)
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

test("stopping synchronously from gap delivery prevents a stale source from opening", async () => {
  const opened: string[] = []
  const stream = new ConversationStream({
    fetchGap: async () => [messageAt(1)],
    open: url => (opened.push(url), { close() {} }),
    online: () => true,
  })

  await stream.start("c1", 0, { ...handlers, onMessages: () => stream.stop() })

  expect(opened).toEqual([])
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
