import { test, expect } from "bun:test"
import { TurnTrace, parseTraceTail, matchTrace, renderTrace, type TraceRecord } from "../hub/turnTrace"

function fixture(): { trace: TurnTrace; lines: string[] } {
  const lines: string[] = []
  const trace = new TurnTrace({
    append: (l) => lines.push(l),
    readTail: (n) => parseTraceTail(lines.join(""), n),
    now: () => 1_700_000_000_000,
    enabled: true,
  })
  return { trace, lines }
}

test("record stamps v/ts/bytes and appends a JSONL line", () => {
  const { trace, lines } = fixture()
  trace.record({ agent: "ori", chat: "c1", kind: "inbound", text: "hello" })
  expect(lines.length).toBe(1)
  const rec = JSON.parse(lines[0]!) as TraceRecord
  expect(rec).toMatchObject({ v: 1, agent: "ori", chat: "c1", kind: "inbound", text: "hello", bytes: 5 })
  expect(rec.ts).toBe(new Date(1_700_000_000_000).toISOString())
})

test("record is a no-op when disabled", () => {
  const lines: string[] = []
  const trace = new TurnTrace({ append: (l) => lines.push(l), readTail: () => [], now: () => 0, enabled: false })
  trace.record({ agent: "ori", chat: "c1", kind: "reply", text: "hi" })
  expect(lines.length).toBe(0)
})

test("record never throws when append fails", () => {
  const trace = new TurnTrace({ append: () => { throw new Error("disk full") }, readTail: () => [], now: () => 0, enabled: true })
  expect(() => trace.record({ agent: "a", chat: "c", kind: "reply", text: "x" })).not.toThrow()
})

test("record captures tool_use / tool_result payloads in full", () => {
  const { trace, lines } = fixture()
  trace.record({ agent: "ori", chat: "c1", kind: "tool_use", tools: [{ id: "t1", name: "Bash" }] })
  trace.record({ agent: "ori", chat: "c1", kind: "tool_result", results: [{ id: "t1", isError: true }] })
  expect(JSON.parse(lines[0]!).tools).toEqual([{ id: "t1", name: "Bash" }])
  expect(JSON.parse(lines[1]!).results).toEqual([{ id: "t1", isError: true }])
})

test("recent returns the filtered tail", () => {
  const { trace } = fixture()
  trace.record({ agent: "ori", chat: "c1", kind: "inbound", text: "a" })
  trace.record({ agent: "skippy", chat: "c2", kind: "reply", text: "b" })
  trace.record({ agent: "ori", chat: "c1", kind: "reply", text: "c" })
  expect(trace.recent({ agent: "ori" }).map((r) => r.text)).toEqual(["a", "c"])
  expect(trace.recent({ kind: "reply" }).map((r) => r.text)).toEqual(["b", "c"])
  expect(trace.recent({ chat: "c2" }).map((r) => r.text)).toEqual(["b"])
})

test("matchTrace applies since and limit", () => {
  const recs: TraceRecord[] = [
    { v: 1, ts: new Date(1000).toISOString(), agent: "a", chat: "c", kind: "reply", text: "old", bytes: 3 },
    { v: 1, ts: new Date(3000).toISOString(), agent: "a", chat: "c", kind: "reply", text: "new", bytes: 3 },
  ]
  expect(matchTrace(recs, { since: 2000 }).map((r) => r.text)).toEqual(["new"])
  expect(matchTrace(recs, { limit: 1 }).map((r) => r.text)).toEqual(["new"])
})

test("parseTraceTail skips junk lines and returns the last n", () => {
  const raw = [
    JSON.stringify({ v: 1, ts: "t1", agent: "a", chat: "c", kind: "reply", text: "1", bytes: 1 }),
    "not json",
    JSON.stringify({ v: 1, ts: "t2", agent: "a", chat: "c", kind: "reply", text: "2", bytes: 1 }),
  ].join("\n") + "\n"
  const out = parseTraceTail(raw, 1)
  expect(out.map((r) => r.text)).toEqual(["2"])
})

test("renderTrace formats each record as a timestamped line", () => {
  const recs: TraceRecord[] = [
    { v: 1, ts: new Date(1_700_000_000_000).toISOString(), agent: "ori", chat: "c1", kind: "tool_use", tools: [{ id: "t1", name: "Bash" }], bytes: 0 },
  ]
  const out = renderTrace(recs, (ts) => new Date(ts).toISOString().slice(11, 19))
  expect(out).toContain("ori")
  expect(out).toContain("tool_use")
  expect(out).toContain("Bash")
})
