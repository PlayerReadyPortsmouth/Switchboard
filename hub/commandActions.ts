// hub/commandActions.ts
import { parseAuditCommand, renderAuditLines, renderAuditSummary } from "./auditCommand"
import type { AuditEvent, AuditFilter, AuditSummary } from "./types"
import type { AgentToolUsage } from "./toolUsageRegistry"

export interface AuditSource {
  recent(filter?: AuditFilter): AuditEvent[]
  summary(filter?: AuditFilter): AuditSummary
}

/** Same grammar/output as the `!audit` Discord command — shared so the web
 *  "Audit" button and Discord render identically. Pure given an injected
 *  audit source + time formatter. */
export function buildAuditText(query: string, audit: AuditSource, fmtTime: (ts: number) => string): string {
  const q = parseAuditCommand(query)
  return q.summary
    ? renderAuditSummary(audit.summary(q.filter))
    : renderAuditLines(audit.recent({ ...q.filter, limit: q.filter.limit ?? 25 }), fmtTime)
}

export interface ToolUsageSource {
  forAgent(agent: string): AgentToolUsage | undefined
  snapshot(): AgentToolUsage[]
}

function fmtToolUsage(a: AgentToolUsage): string {
  return `**${a.agent}** — ` + (Object.entries(a.tools)
    .sort((x, y) => y[1].count - x[1].count)
    .map(([n, s]) => `${n} ×${s.count}${s.errors ? ` (${s.errors}✗)` : ""}`).join(" · ") || "_none_")
}

/** Same output as the `!tools` Discord command (per-agent or fleet-wide). */
export function buildToolsText(who: string, toolUsage: ToolUsageSource): string {
  if (who) {
    const a = toolUsage.forAgent(who)
    return a ? fmtToolUsage(a) : `_no tool activity for ${who}_`
  }
  const snap = toolUsage.snapshot()
  return snap.length ? snap.map(fmtToolUsage).join("\n") : "_no tool activity yet_"
}
