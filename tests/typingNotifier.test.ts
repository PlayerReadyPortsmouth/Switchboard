import { test, expect } from "bun:test"
import { createTypingNotifier } from "../hub/conversations/typingNotifier"

/** A hand-driven timer, so nothing here depends on wall-clock time. */
function harness(opts: { maxMs?: number; refreshMs?: number; send?: (id: string) => void } = {}) {
  const sent: string[] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextHandle = 1
  let clock = 0
  const notifier = createTypingNotifier({
    send: opts.send ?? ((id) => { sent.push(id) }),
    refreshMs: opts.refreshMs ?? 8_000,
    maxMs: opts.maxMs ?? 120_000,
    setTimer: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, ms }); return h },
    clearTimer: (h) => { timers.delete(h as number) },
    now: () => clock,
  })
  return {
    notifier, sent, timers,
    tick(ms: number) { clock += ms; for (const t of [...timers.values()]) t.fn() },
    liveTimers: () => timers.size,
  }
}

test("start pings immediately — a turn should not look idle for the first refresh window", () => {
  const h = harness()
  h.notifier.start("conv-1")
  expect(h.sent).toEqual(["conv-1"])
})

test("keeps re-pinging, because Discord expires a typing indicator after about ten seconds", () => {
  const h = harness()
  h.notifier.start("conv-1")
  h.tick(8_000)
  h.tick(8_000)
  expect(h.sent).toEqual(["conv-1", "conv-1", "conv-1"])
})

test("stop ends the pings and clears the timer", () => {
  const h = harness()
  h.notifier.start("conv-1")
  h.notifier.stop("conv-1")
  h.tick(8_000)
  expect(h.sent).toEqual(["conv-1"])
  expect(h.liveTimers()).toBe(0)
})

test("a second start for the same conversation does not stack a second timer", () => {
  const h = harness()
  h.notifier.start("conv-1")
  h.notifier.start("conv-1")
  expect(h.liveTimers()).toBe(1)
  expect(h.sent).toEqual(["conv-1"])
})

test("different conversations type independently", () => {
  const h = harness()
  h.notifier.start("a")
  h.notifier.start("b")
  h.notifier.stop("a")
  h.tick(8_000)
  expect(h.sent).toEqual(["a", "b", "b"])
})

test("BOUNDED: an agent that never replies stops typing after maxMs instead of forever", () => {
  const h = harness({ refreshMs: 8_000, maxMs: 20_000 })
  h.notifier.start("conv-1")
  h.tick(8_000)   // 8s  → ping
  h.tick(8_000)   // 16s → ping
  h.tick(8_000)   // 24s → past the cap, give up
  expect(h.sent).toEqual(["conv-1", "conv-1", "conv-1"])
  expect(h.liveTimers()).toBe(0)
})

test("stop on a conversation that was never started is a no-op, not a throw", () => {
  const h = harness()
  expect(() => h.notifier.stop("never")).not.toThrow()
})

test("stopAll clears every live indicator, so no timer outlives a shutdown", () => {
  const h = harness()
  h.notifier.start("a"); h.notifier.start("b"); h.notifier.start("c")
  expect(h.liveTimers()).toBe(3)
  h.notifier.stopAll()
  expect(h.liveTimers()).toBe(0)
})

test("a throwing send cannot reach the caller — a cosmetic ping must never break a turn", () => {
  const h = harness({ send: () => { throw new Error("discord down") } })
  expect(() => h.notifier.start("conv-1")).not.toThrow()
  expect(() => h.tick(8_000)).not.toThrow()
})

test("a REJECTING async send is swallowed too, with no unhandled rejection", async () => {
  const h = harness({ send: () => { return Promise.reject(new Error("429")) as unknown as void } })
  expect(() => h.notifier.start("conv-1")).not.toThrow()
  await new Promise(resolve => setTimeout(resolve, 0))
})
