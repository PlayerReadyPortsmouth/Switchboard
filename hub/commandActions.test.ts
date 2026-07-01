// hub/commandActions.test.ts
import { test, expect } from "bun:test"
import { buildAuditText, buildToolsText, type AuditSource, type ToolUsageSource } from "./commandActions"

const fmtTime = (ts: number) => new Date(ts).toISOString().slice(11, 19)

test("buildAuditText: bare query renders recent lines", () => {
  const audit: AuditSource = {
    recent: (f) => { expect(f).toEqual({ limit: 25 }); return [{ ts: 0, kind: "route", actor: "a", action: "b", outcome: "ok" } as any] },
    summary: () => { throw new Error("should not be called") },
  }
  expect(buildAuditText("", audit, fmtTime)).toContain("route a b")
})

test("buildAuditText: 'cost' query renders the summary", () => {
  const audit: AuditSource = {
    recent: () => { throw new Error("should not be called") },
    summary: (f) => { expect(f).toEqual({}); return { total: 3, byKind: {}, byOutcome: {}, costUsd: 0.01, actors: 2 } },
  }
  expect(buildAuditText("cost", audit, fmtTime)).toContain("total: 3")
})

test("buildToolsText: no arg → snapshot across agents", () => {
  const toolUsage: ToolUsageSource = {
    forAgent: () => undefined,
    snapshot: () => [{ agent: "qa", tools: { Read: { count: 3, errors: 1 } }, total: 3 }],
  }
  expect(buildToolsText("", toolUsage)).toBe("**qa** — Read ×3 (1✗)")
})

test("buildToolsText: agent arg with no activity", () => {
  const toolUsage: ToolUsageSource = { forAgent: () => undefined, snapshot: () => [] }
  expect(buildToolsText("qa", toolUsage)).toBe("_no tool activity for qa_")
})
