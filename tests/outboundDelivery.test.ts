import { test, expect } from "bun:test"
import { OutboundDelivery, idempotencyKey, type DeliveryLogEntry, type DeadLetterEntry } from "../hub/outboundDelivery"
import type { OutboundRoute } from "../hub/types"

const route = (p: Partial<OutboundRoute> = {}): OutboundRoute => ({ id: "r", url: "https://x.test/h", ...p })

function harness(opts: {
  statuses?: (number | "throw")[]   // per-attempt fetch outcomes
  secret?: string
  allowedHosts?: string[]
  retries?: number
} = {}) {
  const statuses = opts.statuses ?? [200]
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  const log: DeliveryLogEntry[] = []
  const dead: DeadLetterEntry[] = []
  const sleeps: number[] = []
  let i = 0
  const d = new OutboundDelivery({
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body })
      const s = statuses[Math.min(i++, statuses.length - 1)]
      if (s === "throw") throw new Error("network")
      return { status: s }
    },
    appendLog: (e) => log.push(e),
    appendDeadLetter: (e) => dead.push(e),
    sleep: async (ms) => { sleeps.push(ms) },
    now: () => 1_000_000,
    secretFor: () => opts.secret,
    retries: opts.retries,
    allowedHosts: opts.allowedHosts,
  })
  return { d, calls, log, dead, sleeps }
}

test("a 2xx delivers in one attempt and logs success", async () => {
  const h = harness({ statuses: [200] })
  const r = await h.d.deliver(route(), '{"a":1}')
  expect(r).toEqual({ ok: true, attempts: 1, status: 200 })
  expect(h.calls.length).toBe(1)
  expect(h.log).toEqual([{ id: "r", ts: 1_000_000, attempt: 1, status: 200, ok: true, idemKey: idempotencyKey("r", '{"a":1}') }])
  expect(h.dead).toEqual([])
})

test("retries on 5xx/throw then succeeds, sleeping between attempts", async () => {
  const h = harness({ statuses: [500, "throw", 204] })
  const r = await h.d.deliver(route(), "body")
  expect(r.ok).toBe(true)
  expect(r.attempts).toBe(3)
  expect(h.calls.length).toBe(3)
  expect(h.sleeps).toEqual([500, 1000])   // backoff between the 3 attempts
})

test("exhausting all attempts dead-letters and reports failure", async () => {
  const h = harness({ statuses: [500], retries: 3 })
  const r = await h.d.deliver(route(), "payload")
  expect(r).toEqual({ ok: false, attempts: 3, status: 500 })
  expect(h.log.length).toBe(3)
  expect(h.dead).toEqual([{ id: "r", ts: 1_000_000, url: "https://x.test/h", body: "payload", lastStatus: 500, attempts: 3 }])
})

test("the idempotency key is stable across retries", async () => {
  const h = harness({ statuses: [500, 200] })
  await h.d.deliver(route(), "same")
  const keys = h.calls.map(c => c.headers["Idempotency-Key"])
  expect(keys[0]).toBe(keys[1])
  expect(keys[0]).toBe(idempotencyKey("r", "same"))
})

test("signing headers are present only when a secret is configured", async () => {
  const signed = harness({ statuses: [200], secret: "s3cret" })
  await signed.d.deliver(route({ secretEnv: "X" }), "b")
  expect(signed.calls[0]!.headers["X-Switchboard-Signature"]).toMatch(/^sha256=/)
  expect(signed.calls[0]!.headers["X-Switchboard-Timestamp"]).toBe("1000")   // 1_000_000ms → 1000s

  const unsigned = harness({ statuses: [200] })
  await unsigned.d.deliver(route(), "b")
  expect(unsigned.calls[0]!.headers["X-Switchboard-Signature"]).toBeUndefined()
})

test("a destination outside the host allowlist is blocked without any fetch", async () => {
  const h = harness({ statuses: [200], allowedHosts: ["api.example.com"] })
  const r = await h.d.deliver(route({ url: "https://evil.com/x" }), "b")
  expect(r.status).toBe("blocked")
  expect(h.calls).toEqual([])
  expect(h.dead).toEqual([])
})
