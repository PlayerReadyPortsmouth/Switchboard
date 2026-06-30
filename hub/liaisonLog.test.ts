// hub/liaisonLog.test.ts
import { expect, test } from "bun:test"
import { LiaisonLog, parseLiaisonTail } from "./liaisonLog"

test("write stamps v+ts+bytes and appends one JSON line", () => {
  const lines: string[] = []
  const log = new LiaisonLog({ append: (l) => lines.push(l), now: () => 1700000000000 })
  const rec = log.write({ dir: "out", kind: "notify", corrId: "c1", peer: "p",
    localAgent: "agent-a", remoteAgent: "agent-b", text: "hello", ok: true })
  expect(rec.v).toBe(1)
  expect(rec.bytes).toBe(5)
  expect(rec.ts).toBe(new Date(1700000000000).toISOString())
  expect(lines.length).toBe(1)
  expect(JSON.parse(lines[0]).corrId).toBe("c1")
})

test("missing text → bytes 0", () => {
  const log = new LiaisonLog({ append: () => {}, now: () => 0 })
  expect(log.write({ dir: "in", kind: "timeout", corrId: "c2", peer: "p", ok: false }).bytes).toBe(0)
})

test("parseLiaisonTail returns last n valid records, skips junk", () => {
  const raw = [`{"v":1,"corrId":"a"}`, `not json`, `{"v":1,"corrId":"b"}`].join("\n")
  const out = parseLiaisonTail(raw, 1)
  expect(out.length).toBe(1)
  expect(out[0].corrId).toBe("b")
})
