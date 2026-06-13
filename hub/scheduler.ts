/** Returns true if `now` is within the target UTC hour and we haven't already
 *  run in this Y-M-D-H bucket (tracked by the caller via lastRunBucket). */
export function shouldRunDailyAt(now: Date, hourUtc: number, lastRunBucket: string | null): boolean {
  if (now.getUTCHours() !== hourUtc) return false;
  const bucket = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return bucket !== lastRunBucket;
}

export function currentBucket(now: Date): string { return now.toISOString().slice(0, 13); }

/** Minute-resolution dedupe bucket ("YYYY-MM-DDTHH:MM") for cron schedules. */
export function minuteBucket(now: Date): string { return now.toISOString().slice(0, 16); }

/** Match one cron field against a value. Supports `*`, lists (`a,b`), ranges
 *  (`a-b`), and steps (`*​/n`, `a/n`, `a-b/n`). */
function matchField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) continue;
    let lo: number, hi: number;
    if (range === "*" || range === "") { lo = min; hi = max; }
    else if (range.includes("-")) { const [a, b] = range.split("-").map(Number); lo = a; hi = b; }
    else { lo = Number(range); hi = stepStr ? max : lo; }   // "5/10" → 5..max step 10
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    for (let v = lo; v <= hi; v += step) if (v === value) return true;
  }
  return false;
}

/** Day-of-week field: 0=Sun..6=Sat, and cron also allows 7 for Sunday. */
function matchDow(field: string, dow: number): boolean {
  return matchField(field, dow, 0, 7) || (dow === 0 && matchField(field, 7, 0, 7));
}

/** True if `now` (UTC) satisfies a 5-field cron expression: `min hour dom mon dow`. */
export function cronMatches(expr: string, now: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return (
    matchField(f[0], now.getUTCMinutes(), 0, 59) &&
    matchField(f[1], now.getUTCHours(), 0, 23) &&
    matchField(f[2], now.getUTCDate(), 1, 31) &&
    matchField(f[3], now.getUTCMonth() + 1, 1, 12) &&
    matchDow(f[4], now.getUTCDay())
  );
}

/** Resolve a schedule's cron expression — explicit `cron`, or a daily shorthand
 *  built from the legacy `hourUtc`. Returns null if neither is set. */
export function scheduleCron(s: { cron?: string; hourUtc?: number }): string | null {
  if (s.cron) return s.cron;
  if (typeof s.hourUtc === "number") return `0 ${s.hourUtc} * * *`;
  return null;
}

