import type { AuditEvent, AuditFilter, AuditInput, AuditKind, AuditSummary } from "./types"
import { auditEvent, matchAudit, redactDetail, summarize } from "./audit"

export interface AuditLogDeps {
  /** Append one event to the ledger (`<stateDir>/audit.jsonl`). */
  append: (e: AuditEvent) => void
  /** Read up to the last `n` events from the ledger (parses the JSONL tail). */
  readTail: (n: number) => AuditEvent[]
  now: () => number
  /** Resolved secret values masked in `detail` before append. */
  secrets?: string[]
  /** Master switch — false/undefined ⇒ `record` is a no-op. */
  enabled?: boolean
  /** Optional allowlist of kinds to record (omit ⇒ all). */
  kinds?: AuditKind[]
}

/** The ledger sink. `record` builds → redacts → appends and NEVER throws (a
 *  logging failure must not break a turn); `recent`/`summary` read a bounded tail
 *  and run the pure core. All IO is injected. */
export class AuditLog {
  constructor(private deps: AuditLogDeps) {}

  record(input: AuditInput): void {
    try {
      if (!this.deps.enabled) return
      if (this.deps.kinds && !this.deps.kinds.includes(input.kind)) return
      const detail = input.detail ? redactDetail(input.detail, this.deps.secrets ?? []) : undefined
      this.deps.append(auditEvent({ ...input, detail }, this.deps.now()))
    } catch (err) {
      try {
        process.stderr.write(`audit record failed: ${err}\n`)
      } catch {
        /* even stderr can fail; the ledger is best-effort and must not throw */
      }
    }
  }

  /** Most-recent events matching `filter` (default last 50). */
  recent(filter: AuditFilter = {}): AuditEvent[] {
    const limit = Math.max(filter.limit ?? 50, 0)
    return matchAudit(this.deps.readTail(this.scanSize(filter)), { ...filter, limit })
  }

  /** Roll up the filtered tail (no display limit). */
  summary(filter: AuditFilter = {}): AuditSummary {
    return summarize(matchAudit(this.deps.readTail(this.scanSize(filter)), { ...filter, limit: undefined }))
  }

  /** A filtered query scans a wider window than the display limit so matches
   *  aren't starved by an unfiltered tail; an unfiltered query reads just enough. */
  private scanSize(filter: AuditFilter): number {
    const display = filter.limit ?? 50
    const filtered =
      filter.kind || filter.actor || filter.chat || filter.action || filter.outcome || filter.since
    return filtered ? Math.max(display * 20, 1000) : display
  }
}
