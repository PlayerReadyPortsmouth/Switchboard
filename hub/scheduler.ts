/** Returns true if `now` is within the target UTC hour and we haven't already
 *  run in this Y-M-D-H bucket (tracked by the caller via lastRunBucket). */
export function shouldRunDailyAt(now: Date, hourUtc: number, lastRunBucket: string | null): boolean {
  if (now.getUTCHours() !== hourUtc) return false;
  const bucket = now.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  return bucket !== lastRunBucket;
}

export function currentBucket(now: Date): string { return now.toISOString().slice(0, 13); }
