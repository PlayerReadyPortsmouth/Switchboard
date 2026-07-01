import type { TraceRecord } from "./turnTrace"

/** Keep only records at or after `now - maxAgeMs`. Pure — the IO (read the whole
 *  trace file, filter, atomically rewrite) lives in hub/index.ts's periodic job. */
export function sweepTrace(records: TraceRecord[], now: number, maxAgeMs: number): TraceRecord[] {
  const cutoff = now - maxAgeMs
  return records.filter((r) => Date.parse(r.ts) >= cutoff)
}
