import type { AuditEvent, AuditFilter, AuditInput, AuditSummary } from "./types"

/** Normalize an input into a complete event: stamp `ts` (from `now` unless given),
 *  default `outcome` to "ok", and omit undefined optionals so the JSONL stays
 *  compact (no `"target":null` noise). Pure. */
export function auditEvent(input: AuditInput, now: number): AuditEvent {
  const e: AuditEvent = {
    ts: input.ts ?? now,
    kind: input.kind,
    actor: input.actor,
    action: input.action,
    outcome: input.outcome ?? "ok",
  }
  if (input.target !== undefined) e.target = input.target
  if (input.chat !== undefined) e.chat = input.chat
  if (input.detail !== undefined) e.detail = input.detail
  if (input.cost !== undefined) e.cost = input.cost
  if (input.corr !== undefined) e.corr = input.corr
  return e
}

/** Recursively mask any string value containing a known secret substring, for the
 *  ledger. An empty/secret-free list returns the detail unchanged (same ref). */
export function redactDetail(
  detail: Record<string, unknown>,
  secrets: string[],
): Record<string, unknown> {
  const secs = secrets.filter(Boolean)
  if (secs.length === 0) return detail
  const mask = (v: unknown): unknown => {
    if (typeof v === "string") return secs.some((s) => v.includes(s)) ? "***" : v
    if (Array.isArray(v)) return v.map(mask)
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = mask(val)
      return o
    }
    return v
  }
  return mask(detail) as Record<string, unknown>
}

/** True if `actor` satisfies the filter term: a prefix match when the term ends
 *  with ":" (e.g. "agent:" → every agent), otherwise exact. */
function actorMatches(actor: string, term: string): boolean {
  return term.endsWith(":") ? actor.startsWith(term) : actor === term
}

/** Filter a chronological event list (AND across terms), apply the `since` lower
 *  bound, then keep the most recent `limit`. Pure. */
export function matchAudit(events: AuditEvent[], f: AuditFilter): AuditEvent[] {
  let out = events.filter(
    (e) =>
      (f.kind === undefined || e.kind === f.kind) &&
      (f.action === undefined || e.action === f.action) &&
      (f.outcome === undefined || e.outcome === f.outcome) &&
      (f.actor === undefined || actorMatches(e.actor, f.actor)) &&
      (f.chat === undefined || e.chat === f.chat) &&
      (f.since === undefined || e.ts >= f.since),
  )
  if (f.limit !== undefined && f.limit >= 0) out = out.slice(-f.limit)
  return out
}

/** Roll up counts by kind & outcome, total cost, and distinct actor count. Pure. */
export function summarize(events: AuditEvent[]): AuditSummary {
  const byKind: Record<string, number> = {}
  const byOutcome: Record<string, number> = {}
  const actors = new Set<string>()
  let costUsd = 0
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1
    actors.add(e.actor)
    if (typeof e.cost === "number") costUsd += e.cost
  }
  return { total: events.length, byKind, byOutcome, costUsd, actors: actors.size }
}
