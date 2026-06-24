import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"
import { Cron } from "croner"
import type { ScheduleRoute } from "./types"

export const DEFAULT_TZ = "Europe/London"

/** Returns true if `now` is within the target UTC hour and we haven't already
 *  run in this Y-M-D-H bucket (tracked by the caller via lastRunBucket).
 *  Legacy daily-at-hourUtc path; kept for backward compatibility. */
export function shouldRunDailyAt(now: Date, hourUtc: number, lastRunBucket: string | null): boolean {
  if (now.getUTCHours() !== hourUtc) return false
  const bucket = now.toISOString().slice(0, 13) // "YYYY-MM-DDTHH"
  return bucket !== lastRunBucket
}

export function currentBucket(now: Date): string { return now.toISOString().slice(0, 13) }

/** UTC minute bucket "YYYY-MM-DDTHH:MM" — the dedupe key for cron jobs. A job
 *  fires at most once per matching minute, identified by this wall-clock minute. */
export function minuteBucket(now: Date): string { return now.toISOString().slice(0, 16) }

/** True if `expr` (standard 5-field cron) fires during the minute that contains
 *  `now`, evaluated in timezone `tz`. We anchor to the start of `now`'s minute
 *  and ask croner for the next run strictly after the previous instant; if that
 *  next run is exactly this minute, the expression matches. Timezone-correct
 *  (e.g. an 08:15 Europe/London job is 07:15 UTC in BST, 08:15 UTC in GMT). */
export function shouldFireCron(now: Date, expr: string, tz: string = DEFAULT_TZ): boolean {
  const minuteStart = new Date(now)
  minuteStart.setUTCSeconds(0, 0)
  const justBefore = new Date(minuteStart.getTime() - 1)
  let next: Date | null
  try {
    next = new Cron(expr, { timezone: tz }).nextRun(justBefore)
  } catch {
    return false // invalid expression — never fire (caller may log)
  }
  return next != null && next.getTime() === minuteStart.getTime()
}

/** Decide whether a single schedule entry should fire now. `cron` takes
 *  precedence over the legacy `hourUtc`; entries with neither never fire. */
export function shouldFireSchedule(now: Date, s: ScheduleRoute, hubTz: string): boolean {
  if (s.cron && s.cron.trim()) return shouldFireCron(now, s.cron, s.tz ?? hubTz)
  if (typeof s.hourUtc === "number") {
    // Re-expressed as a per-minute check so the 1-min tick fires it once, at HH:00.
    return now.getUTCHours() === s.hourUtc && now.getUTCMinutes() === 0
  }
  return false
}

/** Persisted per-job last-fired minute bucket, atomic-written like bindings.json
 *  so a hub restart within the same minute does not double-fire. */
export class CronState {
  private map: Record<string, string> = {}
  constructor(private path: string) {
    try { this.map = JSON.parse(readFileSync(path, "utf8")) } catch { this.map = {} }
  }
  lastFired(id: string): string | null { return this.map[id] ?? null }
  /** Marks `id` as fired in `bucket`. Returns false if it already fired this
   *  bucket (i.e. caller should NOT fire); true if newly recorded (fire). */
  tryFire(id: string, bucket: string): boolean {
    if (this.map[id] === bucket) return false
    this.map[id] = bucket
    this.save()
    return true
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }
}

export interface CronDeps {
  deliver: (agent: string, channelId: string, idTag: string, message: string) => void
  state: CronState
  /** Injectable clock for tests; defaults to Date.now via wrapper. */
  now?: () => Date
  onInvalid?: (id: string, expr: string) => void
}

/** Evaluate every schedule against the current minute and fire the due ones,
 *  deduped per job per minute. Exposed for tests (deterministic via deps.now). */
export function runCronTick(schedules: ScheduleRoute[], hubTz: string, deps: CronDeps): void {
  const now = (deps.now ?? (() => new Date()))()
  const bucket = minuteBucket(now)
  for (const s of schedules) {
    let due: boolean
    try {
      due = shouldFireSchedule(now, s, hubTz)
    } catch {
      due = false
    }
    if (!due) continue
    if (s.cron && s.cron.trim()) {
      try { new Cron(s.cron, { timezone: s.tz ?? hubTz }) } catch { deps.onInvalid?.(s.id, s.cron) }
    }
    if (deps.state.tryFire(s.id, bucket)) {
      deps.deliver(s.agent, s.channelId, `schedule:${s.id}`, s.message)
    }
  }
}

/** Start the 1-minute scheduler loop. Returns the interval handle (unref'd). */
export function startCron(schedules: ScheduleRoute[], hubTz: string, deps: CronDeps): ReturnType<typeof setInterval> {
  return setInterval(() => runCronTick(schedules, hubTz, deps), 60 * 1000)
}
