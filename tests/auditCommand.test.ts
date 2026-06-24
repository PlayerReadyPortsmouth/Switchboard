import { test, expect } from "bun:test"
import { parseAuditCommand, renderAuditLines, renderAuditSummary } from "../hub/auditCommand"
import type { AuditEvent, AuditSummary } from "../hub/types"

// ---- parseAuditCommand ----

test("empty args → list query with no filter", () => {
  expect(parseAuditCommand("")).toEqual({ summary: false, filter: {} })
})

test("a bare kind sets the kind filter", () => {
  expect(parseAuditCommand(" exec ")).toEqual({ summary: false, filter: { kind: "exec" } })
})

test("actor / chat take the following token; actor prefix preserved", () => {
  expect(parseAuditCommand("actor user:42")).toEqual({ summary: false, filter: { actor: "user:42" } })
  expect(parseAuditCommand("actor agent:")).toEqual({ summary: false, filter: { actor: "agent:" } })
  expect(parseAuditCommand("chat C123")).toEqual({ summary: false, filter: { chat: "C123" } })
})

test("cost (or summary) flips to a rollup; trailing integer overrides limit", () => {
  expect(parseAuditCommand("cost")).toEqual({ summary: true, filter: {} })
  expect(parseAuditCommand("outbound 5")).toEqual({ summary: false, filter: { kind: "outbound", limit: 5 } })
})

test("combined, order-free tokens", () => {
  expect(parseAuditCommand("access actor user:1 3")).toEqual({
    summary: false, filter: { kind: "access", actor: "user:1", limit: 3 },
  })
})

// ---- renderAuditLines ----

const clock = (ts: number) => `T${ts}`

test("renderAuditLines emits one code-block line per event with target/outcome", () => {
  const events: AuditEvent[] = [
    { ts: 1, kind: "route", actor: "user:1", action: "route", outcome: "ok", target: "assistant" },
    { ts: 2, kind: "access", actor: "user:2", action: "deny", outcome: "deny" },
  ]
  expect(renderAuditLines(events, clock)).toBe(
    "```\nT1 route user:1 route assistant\nT2 access user:2 deny [deny]\n```",
  )
})

test("renderAuditLines on empty is a friendly note", () => {
  expect(renderAuditLines([], clock)).toBe("📜 audit: no matching events.")
})

// ---- renderAuditSummary ----

test("renderAuditSummary formats counts and cost", () => {
  const s: AuditSummary = {
    total: 3, byKind: { route: 2, access: 1 }, byOutcome: { ok: 2, deny: 1 }, costUsd: 0.05, actors: 2,
  }
  const out = renderAuditSummary(s)
  expect(out).toContain("total: 3")
  expect(out).toContain("actors: 2")
  expect(out).toContain("cost: $0.0500")
  expect(out).toContain("route:2")
  expect(out).toContain("deny:1")
})
