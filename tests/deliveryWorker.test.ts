import { expect, test } from "bun:test"
import { DeliveryWorker } from "../hub/surfaces/deliveryWorker"
import { SurfaceRouter } from "../hub/surfaces"
import type { Delivery, Message, TransportLink } from "../hub/conversations/types"

function fixture(results: Array<{ ok: boolean; externalMessageId?: string; error?: string; retryable?: boolean }>) {
  let now = 1_000
  const message: Message = { id: "m", conversationId: "c", sequence: 1, author: "agent", origin: "agent", content: "hi", replyTo: null, state: "completed", clientKey: null, createdAt: 1 }
  const link: TransportLink = { id: "l", conversationId: "c", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true, createdAt: 1, updatedAt: 1 }
  const delivery: Delivery = { id: "m:l", messageId: "m", linkId: "l", eventKind: "message", state: "pending", attempts: 0, nextAttemptAt: null, externalMessageId: null, error: null, createdAt: 1, updatedAt: 1 }
  const due: Delivery[] = [delivery]
  const writes: unknown[][] = []
  let sends = 0
  const repo = {
    listDueDeliveries: (_now: number, limit?: number) => due.splice(0, limit),
    getMessage: () => message,
    listTransportLinks: () => [link],
    markDeliveryDelivered: (...args: unknown[]) => { writes.push(["delivered", ...args]); return delivery },
    markDeliveryRetry: (...args: unknown[]) => { writes.push(["retry", ...args]); return delivery },
  }
  const router = { deliver: async () => [{ deliveryId: delivery.id, adapter: "discord", ...results[sends++]! }] }
  const worker = new DeliveryWorker(repo, router, { now: () => now, jitter: () => 25 })
  return { worker, writes, due, delivery, link, setNow: (value: number) => { now = value }, sends: () => sends }
}

test("persists successful pending delivery", async () => {
  const f = fixture([{ ok: true, externalMessageId: "external" }])
  await f.worker.tick()
  expect(f.writes).toEqual([["delivered", "m:l", "external", 1_000]])
})

test("schedules retryable failures with bounded exponential backoff and injected jitter", async () => {
  const f = fixture([{ ok: false, error: "down", retryable: true }])
  f.delivery.attempts = 3
  await f.worker.tick()
  expect(f.writes).toEqual([["retry", "m:l", "down", 9_025, false, 1_000]])
})

test("exhausts at maximum attempts and immediately exhausts non-retryable failures", async () => {
  const exhausted = fixture([{ ok: false, error: "down", retryable: true }])
  exhausted.delivery.attempts = 4
  await exhausted.worker.tick()
  expect(exhausted.writes[0]).toEqual(["retry", "m:l", "down", null, true, 1_000])
  const permanent = fixture([{ ok: false, error: "bad", retryable: false }])
  await permanent.worker.tick()
  expect(permanent.writes[0]).toEqual(["retry", "m:l", "bad", null, true, 1_000])
})

test("requests only due work in batches of 100", async () => {
  const f = fixture([{ ok: true }])
  let query: unknown[] = []
  ;(f.worker as any).repo.listDueDeliveries = (...args: unknown[]) => { query = args; return [] }
  await f.worker.tick()
  expect(query).toEqual([1_000, 100])
  expect(f.sends()).toBe(0)
})

test("ignores concurrent ticks and stop waits for the active tick", async () => {
  const f = fixture([{ ok: true }])
  let release!: () => void
  ;(f.worker as any).router.deliver = async () => { await new Promise<void>(r => { release = r }); return [{ deliveryId: "m:l", adapter: "discord", ok: true }] }
  const first = f.worker.tick()
  await Promise.resolve()
  await f.worker.tick()
  const stopped = f.worker.stop()
  expect(f.sends()).toBe(0)
  release()
  await Promise.all([first, stopped])
  expect(f.writes).toHaveLength(1)
})

test("unknown or failed delivery does not block the next due row", async () => {
  const f = fixture([{ ok: false, error: "Unknown surface adapter: discord", retryable: false }, { ok: true }])
  f.due.push({ ...f.delivery, id: "m:l2", linkId: "l2" })
  const link2 = { ...f.link, id: "l2" }
  ;(f.worker as any).repo.listTransportLinks = () => [f.link, link2]
  await f.worker.tick()
  expect(f.writes.map(row => row[0])).toEqual(["retry", "delivered"])
})

test("real router marks an unknown adapter non-retryable and worker exhausts it once", async () => {
  const f = fixture([])
  const worker = new DeliveryWorker((f.worker as any).repo, new SurfaceRouter([]), { now: () => 1_000, jitter: () => 0 })
  await worker.tick()
  expect(f.writes).toEqual([["retry", "m:l", "Unknown surface adapter: discord", null, true, 1_000]])
  expect(f.delivery.attempts).toBe(0)
})

test("timer reports a repository failure without an unhandled rejection", async () => {
  const reported: unknown[] = []; const unhandled: unknown[] = []
  const listener = (error: unknown) => { unhandled.push(error) }
  process.on("unhandledRejection", listener)
  const worker = new DeliveryWorker({ listDueDeliveries() { throw new Error("db down") } } as any, new SurfaceRouter([]), {
    intervalMs: 1, reportError: error => reported.push(error),
  })
  worker.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  await worker.stop()
  await new Promise(resolve => setTimeout(resolve, 0))
  process.off("unhandledRejection", listener)
  expect(reported.length).toBeGreaterThan(0)
  expect((reported[0] as Error).message).toBe("db down")
  expect(unhandled).toEqual([])
})
