import { expect, test } from "bun:test"
import {
  AgentStream,
  type AgentStreamHandlers,
  type EventSourceHandlers,
  type EventSourceLike,
} from "./agentStream"
import type { AgentOperationsEvent } from "./types"

const handlers: AgentStreamHandlers = { onEvent: () => {}, onInvalidate: () => {}, onState: () => {} }

test("opens the operations stream from the supplied cursor", async () => {
  const urls: string[] = []
  const stream = new AgentStream({
    open: (url, _handlers) => (urls.push(url), { close() {} }),
    online: () => true,
  })

  await stream.start(7, handlers)

  expect(urls).toEqual(["/api/operations/agents/events?after=7"])
})

test("keeps one monotonic cursor across reconnects", async () => {
  const urls: string[] = []
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const received: number[] = []
  const stream = new AgentStream({
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), timers.length),
    clearTimer: () => {},
  })
  await stream.start(3, { ...handlers, onEvent: event => received.push(event.sequence) })

  opened[0].message(JSON.stringify({ kind: "agent_changed", agent: "qa", ts: 1, sequence: 5 } satisfies AgentOperationsEvent))
  opened[0].message(JSON.stringify({ kind: "agents_snapshot", ts: 2, sequence: 4 } satisfies AgentOperationsEvent))
  opened[0].message(JSON.stringify({ kind: "agents_snapshot", ts: 3, sequence: 5 } satisfies AgentOperationsEvent))
  opened[0].error()
  await timers[0]()

  expect(received).toEqual([5])
  expect(urls).toEqual([
    "/api/operations/agents/events?after=3",
    "/api/operations/agents/events?after=5",
  ])
})

test("snapshot-required advances the cursor and invalidates cached views", async () => {
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const urls: string[] = []
  let invalidations = 0
  const stream = new AgentStream({
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), timers.length),
    clearTimer: () => {},
  })
  await stream.start(2, { ...handlers, onInvalidate: () => { invalidations++ } })

  opened[0].message(JSON.stringify({ kind: "snapshot_required", ts: 1, sequence: 9 } satisfies AgentOperationsEvent))
  opened[0].error()
  await timers[0]()

  expect(invalidations).toBe(1)
  expect(urls[1]).toBe("/api/operations/agents/events?after=9")
})

test("accepts a lower snapshot reset after the hub restarts", async () => {
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const urls: string[] = []
  let invalidations = 0
  const stream = new AgentStream({
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), timers.length),
    clearTimer: () => {},
  })
  await stream.start(99, { ...handlers, onInvalidate: () => { invalidations++ } })
  opened[0].message(JSON.stringify({ kind: "snapshot_required", sequence: 1, ts: 1 } satisfies AgentOperationsEvent))
  opened[0].error()
  await timers[0]()
  expect(invalidations).toBe(1)
  expect(urls.at(-1)).toContain("after=1")
})

test("reports connecting, live, and reconnecting states", async () => {
  let sourceHandlers!: EventSourceHandlers
  const states: string[] = []
  const stream = new AgentStream({
    open: (_url, value) => (sourceHandlers = value, { close() {} }),
    online: () => true,
    setTimer: () => "timer",
    clearTimer: () => {},
  })
  await stream.start(0, { ...handlers, onState: state => states.push(state) })
  sourceHandlers.open()
  sourceHandlers.error()

  expect(states).toEqual(["connecting", "live", "reconnecting"])
})

test("reports offline and resumes on the online event", async () => {
  let sourceHandlers!: EventSourceHandlers
  let online = false
  let onlineListener!: () => void | Promise<void>
  const states: string[] = []
  const stream = new AgentStream({
    open: (_url, value) => (sourceHandlers = value, { close() {} }),
    online: () => online,
    subscribeOnline: callback => (onlineListener = callback, () => {}),
  })
  await stream.start(0, { ...handlers, onState: state => states.push(state) })
  sourceHandlers.error()
  online = true
  await onlineListener()

  expect(states).toEqual(["connecting", "offline", "reconnecting"])
})

test("ignores source callbacks after stop", async () => {
  let sourceHandlers!: EventSourceHandlers
  const events: AgentOperationsEvent[] = []
  const states: string[] = []
  let invalidations = 0
  let timers = 0
  const source: EventSourceLike = { close() {} }
  const stream = new AgentStream({
    open: (_url, value) => (sourceHandlers = value, source),
    online: () => true,
    setTimer: () => ++timers,
    clearTimer: () => {},
  })
  await stream.start(0, {
    onEvent: event => events.push(event),
    onInvalidate: () => { invalidations++ },
    onState: state => states.push(state),
  })
  stream.stop()

  sourceHandlers.open()
  sourceHandlers.message(JSON.stringify({ kind: "snapshot_required", ts: 1, sequence: 1 } satisfies AgentOperationsEvent))
  sourceHandlers.error()

  expect(events).toEqual([])
  expect(invalidations).toBe(0)
  expect(states).toEqual(["connecting"])
  expect(timers).toBe(0)
})
