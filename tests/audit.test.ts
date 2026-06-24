import { test, expect } from "bun:test"
import { auditEvent, redactDetail, matchAudit, summarize, parseJsonlTail, shouldRotate, rotationsToPrune } from "../hub/audit"
import type { AuditEvent } from "../hub/types"

// ---- auditEvent (normalize) ----

test("auditEvent stamps now() and defaults outcome to ok", () => {
  const e = auditEvent({ kind: "route", actor: "user:1", action: "route" }, 1_000)
  expect(e).toEqual({ ts: 1_000, kind: "route", actor: "user:1", action: "route", outcome: "ok" })
})

test("auditEvent keeps an explicit ts and outcome", () => {
  const e = auditEvent({ kind: "exec", actor: "user:1", action: "direct", outcome: "error", ts: 42 }, 1_000)
  expect(e.ts).toBe(42)
  expect(e.outcome).toBe("error")
})

test("auditEvent drops undefined optionals but keeps provided ones", () => {
  const e = auditEvent(
    { kind: "outbound", actor: "agent:a", action: "deliver", target: "r1", chat: "c1", detail: { status: 200 }, cost: 0.01, corr: "x" },
    5,
  )
  expect(e).toEqual({
    ts: 5, kind: "outbound", actor: "agent:a", action: "deliver", outcome: "ok",
    target: "r1", chat: "c1", detail: { status: 200 }, cost: 0.01, corr: "x",
  })
  // no undefined keys leak into the JSONL
  const bare = auditEvent({ kind: "event", actor: "hub", action: "schedule.fired" }, 1)
  expect(Object.keys(bare).sort()).toEqual(["action", "actor", "kind", "outcome", "ts"])
})

// ---- redactDetail ----

test("redactDetail masks string values containing a secret substring", () => {
  const out = redactDetail({ auth: "Bearer sk-TOPSECRET-xyz", note: "fine" }, ["sk-TOPSECRET-xyz"])
  expect(out).toEqual({ auth: "***", note: "fine" })
})

test("redactDetail recurses into nested objects and arrays", () => {
  const out = redactDetail({ a: { b: "hasSECRET" }, list: ["clean", "alsoSECRET"], n: 7 }, ["SECRET"])
  expect(out).toEqual({ a: { b: "***" }, list: ["clean", "***"], n: 7 })
})

test("redactDetail with no secrets returns detail unchanged", () => {
  const d = { x: "y" }
  expect(redactDetail(d, [])).toBe(d)
  expect(redactDetail(d, [""])).toBe(d) // empty strings are filtered out
})

// ---- matchAudit ----

const EV: AuditEvent[] = [
  { ts: 10, kind: "route", actor: "user:1", action: "route", outcome: "ok", chat: "c1" },
  { ts: 20, kind: "exec", actor: "user:1", action: "direct", outcome: "error", chat: "c1" },
  { ts: 30, kind: "access", actor: "user:2", action: "deny", outcome: "deny", chat: "c2" },
  { ts: 40, kind: "outbound", actor: "agent:assistant", action: "deliver", outcome: "ok", chat: "c1" },
]

test("matchAudit filters by kind, outcome, chat", () => {
  expect(matchAudit(EV, { kind: "exec" }).map(e => e.ts)).toEqual([20])
  expect(matchAudit(EV, { outcome: "ok" }).map(e => e.ts)).toEqual([10, 40])
  expect(matchAudit(EV, { chat: "c1" }).map(e => e.ts)).toEqual([10, 20, 40])
})

test("matchAudit actor: exact vs prefix (trailing colon)", () => {
  expect(matchAudit(EV, { actor: "user:1" }).map(e => e.ts)).toEqual([10, 20])
  expect(matchAudit(EV, { actor: "user:" }).map(e => e.ts)).toEqual([10, 20, 30]) // prefix
  expect(matchAudit(EV, { actor: "agent:" }).map(e => e.ts)).toEqual([40])
  // a bare exact prefix must not over-match: user:1 ≠ user:2
  expect(matchAudit(EV, { actor: "user:2" }).map(e => e.ts)).toEqual([30])
})

test("matchAudit since lower-bounds ts; limit keeps the most recent N", () => {
  expect(matchAudit(EV, { since: 25 }).map(e => e.ts)).toEqual([30, 40])
  expect(matchAudit(EV, { limit: 2 }).map(e => e.ts)).toEqual([30, 40])
  expect(matchAudit(EV, {}).length).toBe(4)
})

test("matchAudit combines filters (AND)", () => {
  expect(matchAudit(EV, { chat: "c1", outcome: "ok" }).map(e => e.ts)).toEqual([10, 40])
})

// ---- summarize ----

test("summarize rolls up counts, cost, and distinct actors", () => {
  const evs: AuditEvent[] = [
    { ts: 1, kind: "route", actor: "user:1", action: "route", outcome: "ok", cost: 0.02 },
    { ts: 2, kind: "route", actor: "user:1", action: "route", outcome: "ok", cost: 0.03 },
    { ts: 3, kind: "access", actor: "user:2", action: "deny", outcome: "deny" },
  ]
  expect(summarize(evs)).toEqual({
    total: 3,
    byKind: { route: 2, access: 1 },
    byOutcome: { ok: 2, deny: 1 },
    costUsd: 0.05,
    actors: 2,
  })
})

test("summarize of an empty list is all-zero", () => {
  expect(summarize([])).toEqual({ total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 })
})

// ---- parseJsonlTail ----

test("parseJsonlTail returns the last n events, skipping a torn final line", () => {
  const raw =
    '{"ts":1,"kind":"route","actor":"u","action":"route","outcome":"ok"}\n' +
    '{"ts":2,"kind":"exec","actor":"u","action":"direct","outcome":"ok"}\n' +
    '{"ts":3,"kind":"acce'  // torn write, no newline
  expect(parseJsonlTail(raw, 10).map((e) => e.ts)).toEqual([1, 2])
  expect(parseJsonlTail(raw, 1).map((e) => e.ts)).toEqual([2])
  expect(parseJsonlTail("", 10)).toEqual([])
})

// ---- rotation helpers ----

test("shouldRotate triggers at/over the cap, never without one", () => {
  expect(shouldRotate(100, 100)).toBe(true)
  expect(shouldRotate(99, 100)).toBe(false)
  expect(shouldRotate(1e9, undefined)).toBe(false)
  expect(shouldRotate(1e9, 0)).toBe(false)
})

test("rotationsToPrune keeps the newest keepFiles, deletes the rest", () => {
  const files = ["audit-1000.jsonl", "audit-3000.jsonl", "audit-2000.jsonl"]
  expect(rotationsToPrune(files, 2)).toEqual(["audit-1000.jsonl"])
  expect(rotationsToPrune(files, 0)).toEqual(["audit-1000.jsonl", "audit-2000.jsonl", "audit-3000.jsonl"])
  expect(rotationsToPrune(files, undefined)).toEqual([])  // no keep configured ⇒ prune none
})
