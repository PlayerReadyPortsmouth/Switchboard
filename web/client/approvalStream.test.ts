import { expect, test } from "bun:test"
import {
  ApprovalStream,
  type ApprovalStreamHandlers,
  type EventSourceHandlers,
  type EventSourceLike,
} from "./approvalStream"
import type { ApprovalOperationsEvent } from "./types"

const handlers: ApprovalStreamHandlers = { onEvent: () => {}, onInvalidate: () => {}, onState: () => {} }

const changed = (sequence: number): ApprovalOperationsEvent => ({
  kind: "approval_changed",
  approvalId: `approval-${sequence}`,
  pendingCount: sequence,
  ts: sequence,
  sequence,
})

test("opens the approval operations stream with an initial zero cursor", async () => {
  const urls: string[] = []
  const stream = new ApprovalStream({
    open: (url, _handlers) => (urls.push(url), { close() {} }),
    online: () => true,
  })

  await stream.start(0, handlers)

  expect(urls).toEqual(["/api/operations/approvals/events?after=0"])
})

test("advances one monotonic cursor and suppresses duplicate and lower sequences", async () => {
  const urls: string[] = []
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const received: number[] = []
  const stream = new ApprovalStream({
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), callback),
    clearTimer: () => {},
  })
  await stream.start(1, { ...handlers, onEvent: event => received.push(event.sequence) })

  opened[0].message(JSON.stringify(changed(3)))
  opened[0].message(JSON.stringify(changed(2)))
  opened[0].message(JSON.stringify(changed(3)))
  opened[0].message(JSON.stringify({ kind: "approvals_snapshot", pendingCount: 4, ts: 4, sequence: 4 } satisfies ApprovalOperationsEvent))
  opened[0].error()
  await timers[0]()

  expect(received).toEqual([3, 4])
  expect(urls).toEqual([
    "/api/operations/approvals/events?after=1",
    "/api/operations/approvals/events?after=4",
  ])
})

test("snapshot-required invalidates and adopts a server reset sequence of zero", async () => {
  const urls: string[] = []
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const received: ApprovalOperationsEvent[] = []
  let invalidations = 0
  const stream = new ApprovalStream({
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), callback),
    clearTimer: () => {},
  })
  await stream.start(99, {
    onEvent: event => received.push(event),
    onInvalidate: () => { invalidations++ },
    onState: () => {},
  })

  opened[0].message(JSON.stringify({
    kind: "snapshot_required",
    pendingCount: 2,
    ts: 1,
    sequence: 0,
  } satisfies ApprovalOperationsEvent))
  opened[0].error()
  await timers[0]()

  expect(invalidations).toBe(1)
  expect(received).toEqual([])
  expect(urls.at(-1)).toBe("/api/operations/approvals/events?after=0")
})

test("malformed JSON and invalid sequences do not advance the reconnect cursor", async () => {
  const urls: string[] = []
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const stream = new ApprovalStream({
    open: (url, sourceHandlers) => (urls.push(url), opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: callback => (timers.push(callback), callback),
    clearTimer: () => {},
  })
  await stream.start(4, handlers)

  opened[0].message("{")
  opened[0].message(JSON.stringify({ ...changed(5), sequence: 5.5 }))
  opened[0].message(JSON.stringify({ ...changed(5), sequence: -1 }))
  opened[0].error()
  await timers[0]()

  expect(urls.at(-1)).toBe("/api/operations/approvals/events?after=4")
})

test("uses 1, 2, 5, and capped 10 second online retry delays", async () => {
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  const delays: number[] = []
  const stream = new ApprovalStream({
    open: (_url, sourceHandlers) => (opened.push(sourceHandlers), { close() {} }),
    online: () => true,
    setTimer: (callback, delay) => (timers.push(callback), delays.push(delay), callback),
    clearTimer: () => {},
  })
  await stream.start(0, handlers)

  for (let attempt = 0; attempt < 5; attempt++) {
    opened.at(-1)!.error()
    await timers.shift()!()
  }

  expect(delays).toEqual([1000, 2000, 5000, 10000, 10000])
})

test("offline recovery installs one online listener and no retry timer", async () => {
  const opened: EventSourceHandlers[] = []
  const states: string[] = []
  let online = false
  let onlineCallback!: () => void | Promise<void>
  let subscriptions = 0
  let unsubscriptions = 0
  let timers = 0
  const stream = new ApprovalStream({
    open: (_url, sourceHandlers) => (opened.push(sourceHandlers), { close() {} }),
    online: () => online,
    subscribeOnline: callback => {
      subscriptions++
      onlineCallback = callback
      return () => { unsubscriptions++ }
    },
    setTimer: () => ++timers,
    clearTimer: () => {},
  })
  await stream.start(0, { ...handlers, onState: state => states.push(state) })

  opened[0].error()
  opened[0].error()
  expect(subscriptions).toBe(1)
  expect(timers).toBe(0)

  online = true
  await onlineCallback()
  await onlineCallback()

  expect(opened).toHaveLength(2)
  expect(subscriptions).toBe(1)
  expect(unsubscriptions).toBe(1)
  expect(timers).toBe(0)
  expect(states).toEqual(["connecting", "offline", "reconnecting"])
})

test("stale source and timer callbacks do nothing after stop", async () => {
  let sourceHandlers!: EventSourceHandlers
  let timerCallback!: () => void | Promise<void>
  const events: ApprovalOperationsEvent[] = []
  const states: string[] = []
  let invalidations = 0
  let opens = 0
  let cleared = 0
  const source: EventSourceLike = { close() {} }
  const stream = new ApprovalStream({
    open: (_url, value) => (opens++, sourceHandlers = value, source),
    online: () => true,
    setTimer: callback => (timerCallback = callback, callback),
    clearTimer: () => { cleared++ },
  })
  await stream.start(0, {
    onEvent: event => events.push(event),
    onInvalidate: () => { invalidations++ },
    onState: state => states.push(state),
  })
  sourceHandlers.error()
  stream.stop()

  sourceHandlers.open()
  sourceHandlers.message(JSON.stringify(changed(1)))
  sourceHandlers.message(JSON.stringify({ kind: "snapshot_required", ts: 1, sequence: 0 } satisfies ApprovalOperationsEvent))
  sourceHandlers.error()
  await timerCallback()

  expect(opens).toBe(1)
  expect(cleared).toBe(1)
  expect(events).toEqual([])
  expect(invalidations).toBe(0)
  expect(states).toEqual(["connecting", "reconnecting"])
})

test("a captured offline online callback does nothing after stop", async () => {
  let sourceHandlers!: EventSourceHandlers
  let onlineCallback!: () => void | Promise<void>
  const states: string[] = []
  let opens = 0
  let unsubscriptions = 0
  let timers = 0
  const stream = new ApprovalStream({
    open: (_url, value) => (opens++, sourceHandlers = value, { close() {} }),
    online: () => false,
    subscribeOnline: callback => {
      onlineCallback = callback
      return () => { unsubscriptions++ }
    },
    setTimer: () => ++timers,
    clearTimer: () => {},
  })
  await stream.start(0, { ...handlers, onState: state => states.push(state) })
  sourceHandlers.error()
  stream.stop()

  await onlineCallback()

  expect(opens).toBe(1)
  expect(unsubscriptions).toBe(1)
  expect(timers).toBe(0)
  expect(states).toEqual(["connecting", "offline"])
})

test("closes the old source so exactly one source exists after each reconnect", async () => {
  const opened: EventSourceHandlers[] = []
  const timers: Array<() => void | Promise<void>> = []
  let activeSources = 0
  let maximumActiveSources = 0
  const stream = new ApprovalStream({
    open: (_url, sourceHandlers) => {
      opened.push(sourceHandlers)
      activeSources++
      maximumActiveSources = Math.max(maximumActiveSources, activeSources)
      let closed = false
      return {
        close() {
          if (closed) return
          closed = true
          activeSources--
        },
      }
    },
    online: () => true,
    setTimer: callback => (timers.push(callback), callback),
    clearTimer: () => {},
  })
  await stream.start(0, handlers)

  opened[0].error()
  opened[0].error()
  expect(timers).toHaveLength(1)
  await timers.shift()!()
  opened[1].error()
  await timers.shift()!()

  expect(opened).toHaveLength(3)
  expect(maximumActiveSources).toBe(1)
  expect(activeSources).toBe(1)
  stream.stop()
  expect(activeSources).toBe(0)
})
