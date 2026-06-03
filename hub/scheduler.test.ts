import { test, expect } from "bun:test";
import { shouldRunDailyAt, currentBucket } from "./scheduler";

test("fires once when the UTC hour matches and not again same hour", () => {
  const at2 = new Date("2026-06-04T02:05:00Z");
  expect(shouldRunDailyAt(at2, 2, null)).toBe(true);                       // first time at 02:00 hour
  expect(shouldRunDailyAt(at2, 2, "2026-06-04T02")).toBe(false);          // already ran this hour
  expect(shouldRunDailyAt(new Date("2026-06-04T03:00:00Z"), 2, "2026-06-04T02")).toBe(false);
});

test("does not fire when UTC hour does not match", () => {
  const at5 = new Date("2026-06-04T05:10:00Z");
  expect(shouldRunDailyAt(at5, 2, null)).toBe(false);
  expect(shouldRunDailyAt(at5, 2, "2026-06-03T02")).toBe(false);
});

test("fires again the next day in the same hour slot", () => {
  const day1 = new Date("2026-06-04T02:00:00Z");
  const day2 = new Date("2026-06-05T02:00:00Z");
  expect(shouldRunDailyAt(day1, 2, null)).toBe(true);
  const bucket1 = currentBucket(day1);
  expect(shouldRunDailyAt(day2, 2, bucket1)).toBe(true);
});

test("currentBucket returns YYYY-MM-DDTHH slice", () => {
  expect(currentBucket(new Date("2026-06-04T02:05:00Z"))).toBe("2026-06-04T02");
  expect(currentBucket(new Date("2026-06-04T23:59:59Z"))).toBe("2026-06-04T23");
});
