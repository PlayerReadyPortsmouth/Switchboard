import { test, expect } from "bun:test"
import { cronMatches, minuteBucket, scheduleCron } from "../hub/scheduler"

const at = (iso: string) => new Date(iso)

test("wildcard matches every minute", () => {
  expect(cronMatches("* * * * *", at("2026-06-13T09:17:00Z"))).toBe(true)
})

test("exact minute+hour (e.g. the 8:15 job)", () => {
  expect(cronMatches("15 8 * * *", at("2026-06-13T08:15:00Z"))).toBe(true)
  expect(cronMatches("15 8 * * *", at("2026-06-13T08:16:00Z"))).toBe(false)
  expect(cronMatches("15 8 * * *", at("2026-06-13T09:15:00Z"))).toBe(false)
})

test("hourly on the hour (#parkinson)", () => {
  expect(cronMatches("0 * * * *", at("2026-06-13T00:00:00Z"))).toBe(true)
  expect(cronMatches("0 * * * *", at("2026-06-13T13:00:00Z"))).toBe(true)
  expect(cronMatches("0 * * * *", at("2026-06-13T13:01:00Z"))).toBe(false)
})

test("step every 15 minutes (Meta)", () => {
  for (const m of [0, 15, 30, 45]) expect(cronMatches("*/15 * * * *", at(`2026-06-13T10:${String(m).padStart(2, "0")}:00Z`))).toBe(true)
  expect(cronMatches("*/15 * * * *", at("2026-06-13T10:07:00Z"))).toBe(false)
})

test("single-value step (5/10 = 5,15,25,...)", () => {
  expect(cronMatches("5/10 * * * *", at("2026-06-13T10:05:00Z"))).toBe(true)
  expect(cronMatches("5/10 * * * *", at("2026-06-13T10:25:00Z"))).toBe(true)
  expect(cronMatches("5/10 * * * *", at("2026-06-13T10:15:00Z"))).toBe(true)   // 5,15,25,…
  expect(cronMatches("5/10 * * * *", at("2026-06-13T10:10:00Z"))).toBe(false)
})

test("weekday range (payroll: 09:00 Mon–Fri)", () => {
  // 2026-06-15 is a Monday; 2026-06-13 is a Saturday
  expect(cronMatches("0 9 * * 1-5", at("2026-06-15T09:00:00Z"))).toBe(true)
  expect(cronMatches("0 9 * * 1-5", at("2026-06-13T09:00:00Z"))).toBe(false)
})

test("Monday board meeting (09:30 Mon)", () => {
  expect(cronMatches("30 9 * * 1", at("2026-06-15T09:30:00Z"))).toBe(true)  // Mon
  expect(cronMatches("30 9 * * 1", at("2026-06-16T09:30:00Z"))).toBe(false) // Tue
})

test("Sunday accepts both 0 and 7", () => {
  const sun = at("2026-06-14T12:00:00Z")   // Sunday
  expect(cronMatches("0 12 * * 0", sun)).toBe(true)
  expect(cronMatches("0 12 * * 7", sun)).toBe(true)
})

test("lists in a field", () => {
  expect(cronMatches("0,30 * * * *", at("2026-06-13T10:30:00Z"))).toBe(true)
  expect(cronMatches("0,30 * * * *", at("2026-06-13T10:15:00Z"))).toBe(false)
})

test("day-of-month + month (1am audit on the 1st of June)", () => {
  expect(cronMatches("0 1 1 6 *", at("2026-06-01T01:00:00Z"))).toBe(true)
  expect(cronMatches("0 1 1 6 *", at("2026-06-02T01:00:00Z"))).toBe(false)
})

test("malformed expressions never match", () => {
  expect(cronMatches("0 1 1", at("2026-06-01T01:00:00Z"))).toBe(false)
  expect(cronMatches("", at("2026-06-01T01:00:00Z"))).toBe(false)
})

test("minuteBucket is minute-resolution", () => {
  expect(minuteBucket(at("2026-06-13T09:17:42Z"))).toBe("2026-06-13T09:17")
})

test("scheduleCron resolves cron, falls back to hourUtc, else null", () => {
  expect(scheduleCron({ cron: "*/5 * * * *" })).toBe("*/5 * * * *")
  expect(scheduleCron({ hourUtc: 7 })).toBe("0 7 * * *")
  expect(scheduleCron({})).toBeNull()
})
