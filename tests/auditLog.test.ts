import { test, expect } from "bun:test"
import { AuditLog } from "../hub/auditLog"
import type { AuditEvent, AuditKind } from "../hub/types"

function harness(
  opts: {
    enabled?: boolean
    kinds?: AuditKind[]
    secrets?: string[]
    tail?: AuditEvent[]
    appendThrows?: boolean
  } = {},
) {
  const appended: AuditEvent[] = []
  const log = new AuditLog({
    append: (e) => {
      if (opts.appendThrows) throw new Error("disk full")
      appended.push(e)
    },
    readTail: () => opts.tail ?? [],
    now: () => 1234,
    enabled: opts.enabled ?? true,
    kinds: opts.kinds,
    secrets: opts.secrets,
  })
  return { log, appended }
}

// ---- record ----

test("record appends a normalized event when enabled", () => {
  const h = harness()
  h.log.record({ kind: "route", actor: "user:1", action: "route", target: "assistant", chat: "c1" })
  expect(h.appended).toEqual([
    { ts: 1234, kind: "route", actor: "user:1", action: "route", outcome: "ok", target: "assistant", chat: "c1" },
  ])
})

test("record is a no-op when disabled", () => {
  const h = harness({ enabled: false })
  h.log.record({ kind: "exec", actor: "user:1", action: "direct" })
  expect(h.appended).toEqual([])
})

test("record honors the kinds allowlist", () => {
  const h = harness({ kinds: ["exec", "access"] })
  h.log.record({ kind: "route", actor: "u", action: "route" })   // not allowed
  h.log.record({ kind: "exec", actor: "u", action: "direct" })   // allowed
  expect(h.appended.map((e) => e.kind)).toEqual(["exec"])
})

test("record redacts secrets in detail before append", () => {
  const h = harness({ secrets: ["sk-LIVE-123"] })
  h.log.record({ kind: "outbound", actor: "agent:a", action: "deliver", detail: { authHeader: "Bearer sk-LIVE-123", status: 200 } })
  expect(h.appended[0].detail).toEqual({ authHeader: "***", status: 200 })
})

test("record never throws and never propagates an append failure", () => {
  const h = harness({ appendThrows: true })
  expect(() => h.log.record({ kind: "session", actor: "hub", action: "reset" })).not.toThrow()
})

// ---- recent / summary (read surface) ----

const TAIL: AuditEvent[] = [
  { ts: 1, kind: "route", actor: "user:1", action: "route", outcome: "ok" },
  { ts: 2, kind: "exec", actor: "user:1", action: "direct", outcome: "error" },
  { ts: 3, kind: "access", actor: "user:2", action: "deny", outcome: "deny" },
  { ts: 4, kind: "outbound", actor: "agent:a", action: "deliver", outcome: "ok", cost: 0.05 },
]

test("recent applies the filter and keeps the most recent N", () => {
  const h = harness({ tail: TAIL })
  expect(h.log.recent({ kind: "exec" }).map((e) => e.ts)).toEqual([2])
  expect(h.log.recent({ actor: "user:" }).map((e) => e.ts)).toEqual([1, 2, 3])
  expect(h.log.recent({ limit: 2 }).map((e) => e.ts)).toEqual([3, 4])
})

test("summary rolls up the filtered tail", () => {
  const h = harness({ tail: TAIL })
  expect(h.log.summary()).toEqual({
    total: 4,
    byKind: { route: 1, exec: 1, access: 1, outbound: 1 },
    byOutcome: { ok: 2, error: 1, deny: 1 },
    costUsd: 0.05,
    actors: 3,
  })
  expect(h.log.summary({ actor: "user:" })).toMatchObject({ total: 3, actors: 2, costUsd: 0 })
})
