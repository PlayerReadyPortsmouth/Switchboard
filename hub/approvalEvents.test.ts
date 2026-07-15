import { expect, test } from "bun:test"
import { ApprovalEventStream, type ApprovalOperationsEvent } from "./approvalEvents"

test("events carry only changed ID and safe aggregate state", () => {
  const stream = new ApprovalEventStream(3)
  const event = stream.publish({
    kind: "approval_changed",
    approvalId: "approval-1",
    pendingCount: 2,
    ts: 10,
  })

  expect(event).toEqual({
    kind: "approval_changed",
    approvalId: "approval-1",
    pendingCount: 2,
    ts: 10,
    sequence: 1,
  })
  expect(JSON.stringify(event)).not.toContain("conversation")
  expect(JSON.stringify(event)).not.toContain("detail")
})

test("events are monotonic and retained events replay strictly after a cursor", () => {
  const stream = new ApprovalEventStream(3)
  const first = stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  const second = stream.publish({
    kind: "approval_changed",
    approvalId: "approval-1",
    pendingCount: 0,
    ts: 2,
  })
  const seen: ApprovalOperationsEvent[] = []

  stream.subscribe(1, event => seen.push(event)).unsubscribe()

  expect([first.sequence, second.sequence]).toEqual([1, 2])
  expect(seen).toEqual([second])
})

test("a cursor older than retained history emits one snapshot_required gap", () => {
  const stream = new ApprovalEventStream(1)
  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  stream.publish({ kind: "approvals_snapshot", pendingCount: 2, ts: 2 })
  const seen: ApprovalOperationsEvent[] = []

  stream.subscribe(0, event => seen.push(event)).unsubscribe()

  expect(seen).toEqual([{
    kind: "snapshot_required",
    pendingCount: 2,
    ts: expect.any(Number),
    sequence: 2,
  }])
})

test("a cursor immediately before the retained floor replays without a gap", () => {
  const stream = new ApprovalEventStream(1)
  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  stream.publish({ kind: "approvals_snapshot", pendingCount: 2, ts: 2 })
  const seen: ApprovalOperationsEvent[] = []

  stream.subscribe(1, event => seen.push(event)).unsubscribe()

  expect(seen).toEqual([{
    kind: "approvals_snapshot",
    pendingCount: 2,
    ts: 2,
    sequence: 2,
  }])
})

test("a cursor ahead of a restarted stream receives an explicit reset snapshot", () => {
  const stream = new ApprovalEventStream()
  stream.publish({ kind: "approvals_snapshot", pendingCount: 4, ts: 1 })
  const seen: ApprovalOperationsEvent[] = []

  stream.subscribe(99, event => seen.push(event)).unsubscribe()

  expect(seen).toEqual([{
    kind: "snapshot_required",
    pendingCount: 4,
    ts: expect.any(Number),
    sequence: 1,
  }])
})

test("reentrant publication preserves sequence order for every subscriber", () => {
  const stream = new ApprovalEventStream()
  const seen: number[] = []
  stream.subscribe(0, event => {
    if (event.sequence === 1) {
      stream.publish({ kind: "approvals_snapshot", pendingCount: 2, ts: 2 })
    }
  })
  stream.subscribe(0, event => seen.push(event.sequence))

  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })

  expect(seen).toEqual([1, 2])
})

test("publication during replay is handed off without losing an event", () => {
  const stream = new ApprovalEventStream(1)
  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  const seen: number[] = []

  stream.subscribe(0, event => {
    seen.push(event.sequence)
    if (event.sequence === 1) {
      stream.publish({ kind: "approvals_snapshot", pendingCount: 2, ts: 2 })
    }
  }).unsubscribe()

  expect(seen).toEqual([1, 2])
})

test("subscription during delivery does not duplicate a retained pending event", () => {
  const stream = new ApprovalEventStream()
  const seen: number[] = []
  let nested: { unsubscribe(): void } | undefined
  stream.subscribe(0, event => {
    if (event.sequence !== 1) return
    stream.publish({ kind: "approvals_snapshot", pendingCount: 2, ts: 2 })
    nested = stream.subscribe(0, replayed => seen.push(replayed.sequence))
  })

  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })

  nested?.unsubscribe()
  expect(seen).toEqual([1, 2])
})

test("publish results and deliveries are isolated copies", () => {
  const stream = new ApprovalEventStream()
  const returned = stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  returned.sequence = 99
  returned.pendingCount = 99
  const seen: ApprovalOperationsEvent[] = []

  stream.subscribe(0, event => {
    event.sequence = 88
    event.pendingCount = 88
  })
  stream.subscribe(0, event => seen.push(event)).unsubscribe()

  expect(seen).toEqual([{
    kind: "approvals_snapshot",
    pendingCount: 1,
    ts: 1,
    sequence: 1,
  }])
})

test("subscribers receive new events only until unsubscribe", () => {
  const stream = new ApprovalEventStream()
  const seen: number[] = []
  const subscription = stream.subscribe(0, event => seen.push(event.sequence))

  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  subscription.unsubscribe()
  subscription.unsubscribe()
  stream.publish({ kind: "approvals_snapshot", pendingCount: 0, ts: 2 })

  expect(seen).toEqual([1])
})

test("a subscriber that fails during replay is removed before later publication", () => {
  const stream = new ApprovalEventStream()
  stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 })
  let calls = 0

  expect(() => stream.subscribe(0, () => {
    calls += 1
    throw new Error("subscriber failed")
  })).toThrow("subscriber failed")

  expect(() => stream.publish({ kind: "approvals_snapshot", pendingCount: 0, ts: 2 })).not.toThrow()
  expect(calls).toBe(1)
})

test("a live subscriber failure removes only that subscriber without starving peers", () => {
  const stream = new ApprovalEventStream()
  let failingCalls = 0
  const seen: number[] = []
  stream.subscribe(0, () => {
    failingCalls += 1
    throw new Error("subscriber failed")
  })
  stream.subscribe(0, event => seen.push(event.sequence))

  expect(() => stream.publish({ kind: "approvals_snapshot", pendingCount: 1, ts: 1 }))
    .toThrow("subscriber failed")
  expect(seen).toEqual([1])
  expect(() => stream.publish({ kind: "approvals_snapshot", pendingCount: 0, ts: 2 }))
    .not.toThrow()
  expect(failingCalls).toBe(1)
  expect(seen).toEqual([1, 2])
})
