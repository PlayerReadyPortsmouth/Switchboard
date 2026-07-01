/** A full-fidelity per-turn trace, separate from the AuditLog (which stays
 *  metadata-only by invariant). Where the audit ledger records WHAT happened,
 *  the trace records the full bodies — inbound text, each tool use/result, and
 *  the agent's outbound reply/card — so an operator can reconstruct exactly what
 *  a turn did. Ships dark behind `hub.trace.enabled`; disabled ⇒ `record` is a
 *  no-op and nothing is written. All IO is injected so the core is pure. */

export interface TraceRecord {
  v: 1
  ts: string
  agent: string
  chat: string
  kind: "inbound" | "tool_use" | "tool_result" | "reply" | "card" | "update"
  text?: string                               // full body (inbound content / reply text / card title+body)
  tools?: { id: string; name: string }[]      // for tool_use
  results?: { id: string; isError: boolean }[] // for tool_result
  bytes: number                               // byte length of `text` (0 when none)
}

export type TraceInput = Omit<TraceRecord, "v" | "ts" | "bytes">

export interface TraceFilter {
  agent?: string
  chat?: string
  kind?: TraceRecord["kind"]
  since?: number    // epoch ms; keep records at or after this instant
  limit?: number    // most-recent N (default 50)
}

export interface TurnTraceDeps {
  append: (line: string) => void
  readTail: (n: number) => TraceRecord[]
  now: () => number
  enabled?: boolean
}

export class TurnTrace {
  constructor(private deps: TurnTraceDeps) {}

  /** Build → append one trace record. No-op when disabled; NEVER throws (a trace
   *  write must not break a turn). */
  record(input: TraceInput): void {
    try {
      if (!this.deps.enabled) return
      const rec: TraceRecord = {
        v: 1,
        ts: new Date(this.deps.now()).toISOString(),
        bytes: input.text ? Buffer.byteLength(input.text) : 0,
        ...input,
      }
      this.deps.append(JSON.stringify(rec) + "\n")
    } catch (err) {
      try { process.stderr.write(`trace record failed: ${err}\n`) } catch { /* best-effort */ }
    }
  }

  /** Most-recent records matching `filter`. A filtered query scans a wider window
   *  so matches aren't starved by an unfiltered tail. */
  recent(filter: TraceFilter = {}): TraceRecord[] {
    const display = Math.max(filter.limit ?? 50, 0)
    const filtered = filter.agent || filter.chat || filter.kind || filter.since
    const scan = filtered ? Math.max(display * 20, 1000) : display
    return matchTrace(this.deps.readTail(scan), { ...filter, limit: display })
  }
}

/** Filter + cap a list of records (most-recent `limit`). Pure. */
export function matchTrace(records: TraceRecord[], filter: TraceFilter = {}): TraceRecord[] {
  const sinceMs = filter.since
  const out = records.filter((r) =>
    (!filter.agent || r.agent === filter.agent) &&
    (!filter.chat || r.chat === filter.chat) &&
    (!filter.kind || r.kind === filter.kind) &&
    (sinceMs === undefined || Date.parse(r.ts) >= sinceMs))
  return filter.limit === undefined ? out : out.slice(-filter.limit)
}

/** Parse a JSONL trace tail, skipping junk lines, returning the last `n`. */
export function parseTraceTail(raw: string, n: number): TraceRecord[] {
  const out: TraceRecord[] = []
  for (const line of raw.split("\n")) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s) as TraceRecord) } catch { /* skip junk */ }
  }
  return n <= 0 ? [] : out.slice(-n)
}

/** Render records as compact timestamped lines for a chat reply. */
export function renderTrace(records: TraceRecord[], fmtTs: (ts: string) => string): string {
  if (records.length === 0) return "_no trace records_"
  return records.map((r) => {
    const head = `\`${fmtTs(r.ts)}\` **${r.agent}** ${r.kind}`
    let tail = ""
    if (r.kind === "tool_use" && r.tools) tail = " " + r.tools.map((t) => t.name).join(", ")
    else if (r.kind === "tool_result" && r.results) {
      const errs = r.results.filter((x) => x.isError).length
      tail = ` ${r.results.length} result${r.results.length === 1 ? "" : "s"}${errs ? ` (${errs}✗)` : ""}`
    } else if (r.text) {
      const oneLine = r.text.replace(/\s+/g, " ").trim()
      tail = " " + (oneLine.length > 160 ? oneLine.slice(0, 157) + "…" : oneLine)
    }
    return head + tail
  }).join("\n")
}
