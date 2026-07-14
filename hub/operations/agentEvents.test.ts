import { expect, test } from "bun:test"
import { AgentEventStream, type AgentOperationsEvent } from "./agentEvents"

test("events are ordered and replay after a cursor", () => {
  const stream = new AgentEventStream(3)
  stream.publish({ kind: "agent_changed", agent: "qa", ts: 1 })
  stream.publish({ kind: "agent_changed", agent: "qa", ts: 2 })
  const seen: number[] = []

  const subscription = stream.subscribe(1, event => seen.push(event.sequence))

  expect(seen).toEqual([2])
  subscription.unsubscribe()
})

test("an expired cursor emits snapshot_required", () => {
  const stream = new AgentEventStream(1)
  stream.publish({ kind: "agent_changed", agent: "a", ts: 1 })
  stream.publish({ kind: "agent_changed", agent: "b", ts: 2 })
  const kinds: string[] = []

  stream.subscribe(0, event => kinds.push(event.kind)).unsubscribe()

  expect(kinds[0]).toBe("snapshot_required")
  expect(kinds).toEqual(["snapshot_required"])
})

test("subscribers receive published events until they unsubscribe", () => {
  const stream = new AgentEventStream()
  const seen: number[] = []
  const subscription = stream.subscribe(0, event => seen.push(event.sequence))

  const first = stream.publish({ kind: "config_applied", agent: "qa", ts: 1 })
  subscription.unsubscribe()
  const second = stream.publish({ kind: "action_completed", agent: "qa", action: "reset", ts: 2 })

  expect(first.sequence).toBe(1)
  expect(second.sequence).toBe(2)
  expect(seen).toEqual([1])
})

test("a cursor immediately before the retained floor replays without a gap", () => {
  const stream = new AgentEventStream(1)
  stream.publish({ kind: "agent_changed", agent: "a", ts: 1 })
  stream.publish({ kind: "agent_changed", agent: "b", ts: 2 })
  const kinds: string[] = []

  stream.subscribe(1, event => kinds.push(event.kind)).unsubscribe()

  expect(kinds).toEqual(["agent_changed"])
})

test("reentrant publication preserves sequence order for every subscriber", () => {
  const stream = new AgentEventStream()
  const seen: number[] = []
  stream.subscribe(0, event => {
    if (event.sequence === 1) stream.publish({ kind: "agents_snapshot", ts: 2 })
  })
  stream.subscribe(0, event => seen.push(event.sequence))

  stream.publish({ kind: "agents_snapshot", ts: 1 })

  expect(seen).toEqual([1, 2])
})

test("publication during replay is handed off without losing a shifted event", () => {
  const stream = new AgentEventStream(1)
  stream.publish({ kind: "agents_snapshot", ts: 1 })
  const seen: number[] = []

  stream.subscribe(0, event => {
    seen.push(event.sequence)
    if (event.sequence === 1) stream.publish({ kind: "agents_snapshot", ts: 2 })
  }).unsubscribe()

  expect(seen).toEqual([1, 2])
})

test("subscription during delivery does not duplicate a retained pending event", () => {
  const stream = new AgentEventStream()
  const seen: number[] = []
  let nestedSubscription: { unsubscribe(): void } | undefined
  stream.subscribe(0, event => {
    if (event.sequence !== 1) return
    stream.publish({ kind: "agents_snapshot", ts: 2 })
    nestedSubscription = stream.subscribe(0, replayed => seen.push(replayed.sequence))
  })

  stream.publish({ kind: "agents_snapshot", ts: 1 })

  nestedSubscription?.unsubscribe()
  expect(seen).toEqual([1, 2])
})

test("mutating the publish return cannot corrupt retained replay", () => {
  const stream = new AgentEventStream()
  const published = stream.publish({ kind: "agents_snapshot", ts: 1 })
  published.sequence = 99
  const seen: Array<{ kind: string; sequence: number }> = []

  stream.subscribe(0, event => seen.push({ kind: event.kind, sequence: event.sequence })).unsubscribe()

  expect(seen).toEqual([{ kind: "agents_snapshot", sequence: 1 }])
})

test("one subscriber cannot mutate the event delivered to another subscriber", () => {
  const stream = new AgentEventStream()
  const seen: number[] = []
  stream.subscribe(0, event => { event.sequence = 99 })
  stream.subscribe(0, event => seen.push(event.sequence))

  stream.publish({ kind: "agents_snapshot", ts: 1 })

  expect(seen).toEqual([1])
})

test("a cursor ahead of a restarted hub receives an explicit reset snapshot", () => {
  const stream = new AgentEventStream()
  const events: AgentOperationsEvent[] = []
  stream.publish({ kind: "agents_snapshot", ts: 1 })
  stream.subscribe(99, event => events.push(event)).unsubscribe()
  expect(events).toEqual([{ kind: "snapshot_required", ts: expect.any(Number), sequence: 1 }])
})
