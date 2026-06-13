import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  shouldRunDailyAt,
  currentBucket,
  minuteBucket,
  shouldFireCron,
  shouldFireSchedule,
  CronState,
  runCronTick,
  DEFAULT_TZ,
} from "./scheduler";
import type { ScheduleRoute } from "./types";

// ---------- legacy daily-at-hourUtc (unchanged behaviour) ----------

test("legacy: fires once when the UTC hour matches and not again same hour", () => {
  const at2 = new Date("2026-06-04T02:05:00Z");
  expect(shouldRunDailyAt(at2, 2, null)).toBe(true);
  expect(shouldRunDailyAt(at2, 2, "2026-06-04T02")).toBe(false);
  expect(shouldRunDailyAt(new Date("2026-06-04T03:00:00Z"), 2, "2026-06-04T02")).toBe(false);
});

test("legacy: does not fire when UTC hour does not match", () => {
  const at5 = new Date("2026-06-04T05:10:00Z");
  expect(shouldRunDailyAt(at5, 2, null)).toBe(false);
});

test("legacy: currentBucket returns YYYY-MM-DDTHH slice", () => {
  expect(currentBucket(new Date("2026-06-04T02:05:00Z"))).toBe("2026-06-04T02");
});

// ---------- minuteBucket ----------

test("minuteBucket returns YYYY-MM-DDTHH:MM", () => {
  expect(minuteBucket(new Date("2026-06-04T02:05:30Z"))).toBe("2026-06-04T02:05");
  expect(minuteBucket(new Date("2026-06-04T23:59:59Z"))).toBe("2026-06-04T23:59");
});

// ---------- cron firing, timezone-correct ----------

test("cron fires at the right Europe/London minute (BST: 08:15 local = 07:15 UTC)", () => {
  expect(shouldFireCron(new Date("2026-06-14T07:15:30Z"), "15 8 * * *", "Europe/London")).toBe(true);
});

test("cron does NOT fire at other minutes", () => {
  expect(shouldFireCron(new Date("2026-06-14T07:14:30Z"), "15 8 * * *", "Europe/London")).toBe(false);
  expect(shouldFireCron(new Date("2026-06-14T07:16:30Z"), "15 8 * * *", "Europe/London")).toBe(false);
  // 08:15 UTC is 09:15 London in BST — must NOT fire
  expect(shouldFireCron(new Date("2026-06-14T08:15:30Z"), "15 8 * * *", "Europe/London")).toBe(false);
});

test("DST correctness: an 08:15 London job is 07:15 UTC in BST but 08:15 UTC in GMT", () => {
  // Summer (BST, UTC+1): fires at 07:15 UTC
  expect(shouldFireCron(new Date("2026-06-14T07:15:00Z"), "15 8 * * *", "Europe/London")).toBe(true);
  expect(shouldFireCron(new Date("2026-06-14T08:15:00Z"), "15 8 * * *", "Europe/London")).toBe(false);
  // Winter (GMT, UTC+0): fires at 08:15 UTC
  expect(shouldFireCron(new Date("2026-01-14T08:15:00Z"), "15 8 * * *", "Europe/London")).toBe(true);
  expect(shouldFireCron(new Date("2026-01-14T07:15:00Z"), "15 8 * * *", "Europe/London")).toBe(false);
});

test("every-15-min style (*/15 8-21) fires on the right ticks only", () => {
  // 08:00 London BST = 07:00 UTC -> fires
  expect(shouldFireCron(new Date("2026-06-14T07:00:10Z"), "*/15 8-21 * * *", "Europe/London")).toBe(true);
  // 08:15 London BST = 07:15 UTC -> fires
  expect(shouldFireCron(new Date("2026-06-14T07:15:10Z"), "*/15 8-21 * * *", "Europe/London")).toBe(true);
  // 08:07 -> no
  expect(shouldFireCron(new Date("2026-06-14T07:07:10Z"), "*/15 8-21 * * *", "Europe/London")).toBe(false);
  // 07:00 London (06:00 UTC) -> outside 8-21 hour range, no
  expect(shouldFireCron(new Date("2026-06-14T06:00:10Z"), "*/15 8-21 * * *", "Europe/London")).toBe(false);
});

test("invalid cron expression never fires (no throw)", () => {
  expect(shouldFireCron(new Date("2026-06-14T07:15:00Z"), "not a cron", "Europe/London")).toBe(false);
});

test("default tz is Europe/London", () => {
  expect(DEFAULT_TZ).toBe("Europe/London");
  expect(shouldFireCron(new Date("2026-06-14T07:15:00Z"), "15 8 * * *")).toBe(true);
});

// ---------- shouldFireSchedule: cron precedence + legacy fallback ----------

test("shouldFireSchedule: cron takes precedence over hourUtc", () => {
  const s: ScheduleRoute = { id: "x", agent: "a", channelId: "c", message: "m", cron: "15 8 * * *", hourUtc: 3 };
  expect(shouldFireSchedule(new Date("2026-06-14T07:15:00Z"), s, "Europe/London")).toBe(true);
  // hourUtc=3 would NOT fire here; cron path wins and also true above only at its minute
  expect(shouldFireSchedule(new Date("2026-06-14T03:00:00Z"), s, "Europe/London")).toBe(false);
});

test("shouldFireSchedule: legacy hourUtc entry fires once daily at HH:00 UTC", () => {
  const s: ScheduleRoute = { id: "nightly-backlog-sweep", agent: "a", channelId: "c", message: "m", hourUtc: 2 };
  expect(shouldFireSchedule(new Date("2026-06-14T02:00:00Z"), s, "Europe/London")).toBe(true);
  expect(shouldFireSchedule(new Date("2026-06-14T02:01:00Z"), s, "Europe/London")).toBe(false);
  expect(shouldFireSchedule(new Date("2026-06-14T03:00:00Z"), s, "Europe/London")).toBe(false);
});

test("shouldFireSchedule: per-entry tz overrides hub tz", () => {
  const s: ScheduleRoute = { id: "x", agent: "a", channelId: "c", message: "m", cron: "15 8 * * *", tz: "UTC" };
  // tz=UTC -> 08:15 fires at 08:15 UTC regardless of hub tz
  expect(shouldFireSchedule(new Date("2026-06-14T08:15:00Z"), s, "Europe/London")).toBe(true);
  expect(shouldFireSchedule(new Date("2026-06-14T07:15:00Z"), s, "Europe/London")).toBe(false);
});

// ---------- dedupe / restart safety ----------

function freshState() {
  const dir = mkdtempSync(join(tmpdir(), "cron-state-"));
  return new CronState(join(dir, "cron-state.json"));
}

test("CronState.tryFire dedupes within the same minute bucket", () => {
  const st = freshState();
  expect(st.tryFire("job", "2026-06-14T07:15")).toBe(true);
  expect(st.tryFire("job", "2026-06-14T07:15")).toBe(false);
  expect(st.tryFire("job", "2026-06-14T07:16")).toBe(true);
});

test("CronState dedupe survives a simulated restart (reloads from disk)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-state-"));
  const path = join(dir, "cron-state.json");
  const a = new CronState(path);
  expect(a.tryFire("job", "2026-06-14T07:15")).toBe(true);
  // restart: new instance reads persisted state
  const b = new CronState(path);
  expect(b.tryFire("job", "2026-06-14T07:15")).toBe(false); // same minute -> no double-fire
  expect(b.tryFire("job", "2026-06-14T07:16")).toBe(true);
});

test("runCronTick delivers due cron jobs once per minute, deduped across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-state-"));
  const path = join(dir, "cron-state.json");
  const schedules: ScheduleRoute[] = [
    { id: "morning", agent: "assistant", channelId: "C1", message: "go", cron: "15 8 * * *" },
    { id: "noise", agent: "assistant", channelId: "C2", message: "no", cron: "30 9 * * *" },
  ];
  const fired: string[] = [];
  const deliver = (agent: string, channelId: string, idTag: string) => fired.push(`${agent}|${channelId}|${idTag}`);

  // 08:15 London (BST) = 07:15 UTC
  const now = () => new Date("2026-06-14T07:15:20Z");
  runCronTick(schedules, "Europe/London", { deliver, state: new CronState(path), now });
  expect(fired).toEqual(["assistant|C1|schedule:morning"]);

  // tick again same minute (e.g. a restart) -> no double fire (fresh state from disk)
  runCronTick(schedules, "Europe/London", { deliver, state: new CronState(path), now });
  expect(fired).toEqual(["assistant|C1|schedule:morning"]);
});

test("runCronTick fires legacy hourUtc entry once at the hour", () => {
  const st = freshState();
  const schedules: ScheduleRoute[] = [
    { id: "nightly-backlog-sweep", agent: "assistant", channelId: "C", message: "sweep", hourUtc: 2 },
  ];
  const fired: string[] = [];
  const deliver = (a: string, c: string, t: string) => fired.push(t);
  runCronTick(schedules, "Europe/London", { deliver, state: st, now: () => new Date("2026-06-14T02:00:30Z") });
  runCronTick(schedules, "Europe/London", { deliver, state: st, now: () => new Date("2026-06-14T02:00:50Z") });
  expect(fired).toEqual(["schedule:nightly-backlog-sweep"]); // exactly once
});
