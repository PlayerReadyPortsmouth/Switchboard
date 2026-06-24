import type { AuditEvent, AuditFilter, AuditKind, AuditSummary } from "./types"

const KINDS = new Set<AuditKind>([
  "route", "spawn", "exec", "outbound", "session", "access", "approval", "event", "card",
])

export interface AuditQuery {
  summary: boolean
  filter: AuditFilter
}

/** Parse `!audit` arguments into a query. Grammar (order-free):
 *   !audit                       → recent events (default limit)
 *   !audit <kind>                → filter by kind (route|exec|outbound|…)
 *   !audit actor <a>             → filter by actor (exact, or prefix on trailing ":")
 *   !audit chat <c>              → filter by chat key
 *   !audit cost                  → summary rollup instead of a list
 *   … <n>                        → a bare integer overrides the display limit
 */
export function parseAuditCommand(args: string): AuditQuery {
  const toks = args.trim().split(/\s+/).filter(Boolean)
  const filter: AuditFilter = {}
  let summary = false
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].toLowerCase()
    if (t === "cost" || t === "summary") summary = true
    else if (t === "actor" && toks[i + 1]) filter.actor = toks[++i]
    else if (t === "chat" && toks[i + 1]) filter.chat = toks[++i]
    else if (KINDS.has(t as AuditKind)) filter.kind = t as AuditKind
    else if (/^\d+$/.test(t)) filter.limit = Number(t)
  }
  return { summary, filter }
}

/** One compact line per event: `<time> <kind> <actor> <action> [target] [outcome]`,
 *  wrapped in a code block. `fmtTime` is injected so the renderer stays pure. */
export function renderAuditLines(events: AuditEvent[], fmtTime: (ts: number) => string): string {
  if (events.length === 0) return "📜 audit: no matching events."
  const lines = events.map((e) => {
    const tgt = e.target ? ` ${e.target}` : ""
    const oc = e.outcome === "ok" ? "" : ` [${e.outcome}]`
    return `${fmtTime(e.ts)} ${e.kind} ${e.actor} ${e.action}${tgt}${oc}`
  })
  return "```\n" + lines.join("\n") + "\n```"
}

export function renderAuditSummary(s: AuditSummary): string {
  const fmt = (o: Record<string, number>): string =>
    Object.entries(o).map(([k, n]) => `${k}:${n}`).join("  ") || "—"
  return [
    "📊 **audit summary**",
    `total: ${s.total}   actors: ${s.actors}   cost: $${s.costUsd.toFixed(4)}`,
    `by kind: ${fmt(s.byKind)}`,
    `by outcome: ${fmt(s.byOutcome)}`,
  ].join("\n")
}
