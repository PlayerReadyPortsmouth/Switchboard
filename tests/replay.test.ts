import { test, expect } from "bun:test"
import { buildReplay, renderReplay } from "../hub/replay"
import type { AuditEvent } from "../hub/types"

const ev = (over: Partial<AuditEvent>): AuditEvent => ({ ts: 0, kind: "route", actor: "hub", action: "x", outcome: "ok", ...over })

const events: AuditEvent[] = [
  ev({ ts: 100, kind: "route", actor: "user:U1", action: "route", target: "assistant", chat: "C1" }),
  ev({ ts: 200, kind: "outbound", actor: "agent:assistant", action: "deliver", target: "ops", chat: "C1", corr: "a1", outcome: "pending" }),
  ev({ ts: 260, kind: "approval", actor: "user:U2", action: "grant", target: "ops", chat: "C1", corr: "a1" }),
  ev({ ts: 150, kind: "access", actor: "user:U3", action: "deny", chat: "C2", outcome: "deny" }),   // other chat
  ev({ ts: 300, kind: "outbound", actor: "hub", action: "deliver", target: "ops", chat: "C1", corr: "a1" }),
]

// ---- buildReplay ----

test("selects a conversation by chat, orders by ts with corr groups contiguous", () => {
  const t = buildReplay(events, "C1")
  expect(t.count).toBe(4)                              // the C2 event is excluded
  expect(t.spanMs).toBe(200)                           // 300 - 100
  expect(t.rows.map((r) => r.ts)).toEqual([100, 200, 260, 300])
  expect(t.rows[0].corr).toBeUndefined()               // the route is ungrouped
  expect(t.rows[1].corr).toBe("a1")
  expect(t.rows[1].groupHead).toBe(true)               // first of the a1 group
  expect(t.rows[2].groupHead).toBe(false)
})

test("selects a single action by corr (across whatever chat)", () => {
  const t = buildReplay(events, "a1")
  expect(t.count).toBe(3)
  expect(t.rows.every((r) => r.corr === "a1")).toBe(true)
})

test("a corr group sorts by its earliest event, keeping the thread together", () => {
  // group b1's earliest event (ts 50) precedes a standalone event at ts 90
  const e2: AuditEvent[] = [
    ev({ ts: 90, kind: "route", action: "route", chat: "C3" }),
    ev({ ts: 50, kind: "approval", action: "request", chat: "C3", corr: "b1", outcome: "pending" }),
    ev({ ts: 95, kind: "approval", action: "grant", chat: "C3", corr: "b1" }),
  ]
  const t = buildReplay(e2, "C3")
  expect(t.rows.map((r) => r.action)).toEqual(["request", "grant", "route"])  // b1 group (gt50) before route (90)
})

test("empty when nothing matches", () => {
  expect(buildReplay(events, "nope").count).toBe(0)
  expect(buildReplay(events, "nope").rows).toEqual([])
})

// ---- renderReplay ----

const fmt = (ts: number) => `t${ts}`

test("renders a header with count/span/cost and the grouped rows", () => {
  const out = renderReplay(buildReplay(events, "C1"), fmt)
  expect(out).toContain("replay `C1`")
  expect(out).toContain("4 events")
  expect(out).toContain("route")
  expect(out).toContain("→ ops")
  expect(out).toContain("(corr a1)")     // tagged on the group head
  expect(out).toContain("[pending]")
})

test("count === 0 renders a friendly empty message", () => {
  expect(renderReplay(buildReplay(events, "nope"), fmt)).toContain("nothing recorded")
})
