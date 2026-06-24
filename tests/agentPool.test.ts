import { test, expect } from "bun:test"
import {
  ReplicaPool, pickIndex, underPressure, scaleUpReady, scaleDownIndex,
  type PooledReplica, type ScaleCfg,
} from "../hub/agentPool"
import type { InboundMessage } from "../hub/types"

const CFG: ScaleCfg = { min: 1, max: 2, scaleUpQueue: 2, scaleUpSustainMs: 1000, replicaIdleMs: 1000 }

test("pickIndex prefers an idle replica, then the shortest queue, skipping dead", () => {
  expect(pickIndex([{ alive: true, busy: true, queueDepth: 0 }, { alive: true, busy: false, queueDepth: 5 }])).toBe(1)
  expect(pickIndex([{ alive: true, busy: true, queueDepth: 3 }, { alive: true, busy: true, queueDepth: 1 }])).toBe(1)
  expect(pickIndex([{ alive: false, busy: false, queueDepth: 0 }, { alive: true, busy: true, queueDepth: 9 }])).toBe(1)
  expect(pickIndex([{ alive: false, busy: false, queueDepth: 0 }])).toBe(-1)
})

test("underPressure requires all-busy, queue over threshold, and headroom", () => {
  expect(underPressure([{ alive: true, busy: true, queueDepth: 2 }], CFG)).toBe(true)
  expect(underPressure([{ alive: true, busy: false, queueDepth: 9 }], CFG)).toBe(false) // not all busy
  expect(underPressure([{ alive: true, busy: true, queueDepth: 1 }], CFG)).toBe(false)  // queue below threshold
  const atMax = [{ alive: true, busy: true, queueDepth: 5 }, { alive: true, busy: true, queueDepth: 5 }]
  expect(underPressure(atMax, CFG)).toBe(false)                                          // already at max
})

test("scaleUpReady only fires once pressure is sustained", () => {
  const loads = [{ alive: true, busy: true, queueDepth: 2 }]
  expect(scaleUpReady(loads, CFG, 0, 500)).toBe(false)   // 500ms < 1000ms sustain
  expect(scaleUpReady(loads, CFG, 0, 1000)).toBe(true)
  expect(scaleUpReady(loads, CFG, null, 9999)).toBe(false)
})

test("scaleDownIndex retires an idle, unbound, non-primary replica (respecting min)", () => {
  const reps = [
    { alive: true, busy: false, primary: true, stickyCount: 0, idleMs: 9999 },
    { alive: true, busy: false, primary: false, stickyCount: 0, idleMs: 9999 },
  ]
  expect(scaleDownIndex(reps, CFG)).toBe(1)
  expect(scaleDownIndex([reps[0]!], CFG)).toBe(-1)                       // at min
  reps[1]!.stickyCount = 1
  expect(scaleDownIndex(reps, CFG)).toBe(-1)                             // still has conversations
  reps[1]!.stickyCount = 0; reps[1]!.busy = true
  expect(scaleDownIndex(reps, CFG)).toBe(-1)                             // busy mid-turn → never retired
})

class FakeReplica implements PooledReplica {
  busy = false; q = 0; alive = true; activity = 0; closed = false
  delivered: InboundMessage[] = []
  constructor(readonly name: string) {}
  deliver(_k: string, m: InboundMessage): void { this.delivered.push(m); this.busy = true }
  onReply(): void {}
  isAvailable(): boolean { return this.alive }
  isBusy(): boolean { return this.busy }
  queueDepth(): number { return this.q }
  fillPct(): number { return 0 }
  lastUsageInfo(): null { return null }
  lastActivityMs(): number { return this.activity }
  sendInteraction(): void {}
  async close(): Promise<void> { this.closed = true; this.alive = false }
}
function msg(chatId: string): InboundMessage {
  return { chatId, messageId: "m", userId: "u", user: "u", content: "x", ts: "", isDM: false }
}

test("conversations stick to their assigned replica", async () => {
  const primary = new FakeReplica("a")
  const extra = new FakeReplica("a#2")
  const pool = new ReplicaPool("a", primary, { ...CFG, spawn: async () => extra })
  pool.deliver("conv1", msg("conv1"))
  primary.busy = false                       // free it; sticky should still hold conv1
  pool.deliver("conv1", msg("conv1"))
  expect(primary.delivered.length).toBe(2)
  expect(extra.delivered.length).toBe(0)
})

test("tick scales up under sustained pressure, then no further past max", async () => {
  let t = 0
  const primary = new FakeReplica("a"); primary.busy = true; primary.q = 2
  const extra = new FakeReplica("a#2"); extra.busy = true; extra.q = 2
  const pool = new ReplicaPool("a", primary, { ...CFG, now: () => t, spawn: async () => extra })

  await pool.tick()                 // t=0 → pressure starts, not yet sustained
  expect(pool.replicaCount()).toBe(1)
  t = 1000
  await pool.tick()                 // sustained → scale up to 2
  expect(pool.replicaCount()).toBe(2)
  t = 5000
  await pool.tick()                 // at max (2) → no further scale-up
  expect(pool.replicaCount()).toBe(2)
})

test("tick retires an idle spare replica down to min", async () => {
  let t = 10_000
  const primary = new FakeReplica("a")
  const spare = new FakeReplica("a#2"); spare.activity = 0   // idle since t=0
  const pool = new ReplicaPool("a", primary, { ...CFG, now: () => t, spawn: async () => spare })
  // Force a second replica in via a sustained-pressure scale-up first.
  primary.busy = true; primary.q = 2
  await pool.tick(); t = 11_000; await pool.tick()
  expect(pool.replicaCount()).toBe(2)
  // Now relieve pressure; the spare is idle and unbound → retires.
  primary.busy = false; primary.q = 0; spare.busy = false; spare.activity = 0
  t = 20_000
  await pool.tick()
  expect(pool.replicaCount()).toBe(1)
  expect(spare.closed).toBe(true)
})
