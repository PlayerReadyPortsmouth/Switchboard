import { test, expect } from "bun:test"
import { sweepTrace } from "./traceSweep"
import type { TraceRecord } from "./turnTrace"

const rec = (ts: string): TraceRecord => ({ v: 1, ts, agent: "a", chat: "c", kind: "reply", bytes: 0 })

test("drops records older than maxAgeMs, keeps records at or after the cutoff", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z")
  const maxAgeMs = 14 * 24 * 60 * 60_000 // 14 days
  const cutoff = now - maxAgeMs
  const records = [
    rec(new Date(cutoff - 1000).toISOString()),   // 1s before cutoff — dropped
    rec(new Date(cutoff).toISOString()),           // exactly at cutoff — kept
    rec(new Date(cutoff + 1000).toISOString()),    // 1s after cutoff — kept
    rec(new Date(now).toISOString()),               // now — kept
  ]
  const kept = sweepTrace(records, now, maxAgeMs)
  expect(kept).toEqual([records[1], records[2], records[3]])
})

test("empty input returns empty output", () => {
  expect(sweepTrace([], Date.now(), 1000)).toEqual([])
})

test("maxAgeMs larger than the data's span keeps everything", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z")
  const records = [rec(new Date(now - 1000).toISOString()), rec(new Date(now).toISOString())]
  expect(sweepTrace(records, now, 365 * 24 * 60 * 60_000)).toEqual(records)
})
