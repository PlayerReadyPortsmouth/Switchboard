import { test, expect } from "bun:test"
import { enrich, foldQuote } from "../hub/enrich"

test("returns the bare content when no blocks", () => {
  expect(enrich("hello", {})).toBe("hello")
})

test("orders memory, then context, then the message", () => {
  const out = enrich("the message", { memory: "MEM", context: "CTX" })
  expect(out).toBe("MEM\n\nCTX\n\nthe message")
})

test("drops empty/whitespace-only blocks", () => {
  expect(enrich("msg", { memory: "", context: "   " })).toBe("msg")
  expect(enrich("msg", { context: "CTX" })).toBe("CTX\n\nmsg")
})

test("foldQuote inlines a reply target, no-op without one", () => {
  expect(foldQuote("yes do that", { user: "alice", content: "should we ship?" }))
    .toBe('(replying to alice: "should we ship?")\nyes do that')
  expect(foldQuote("hi", undefined)).toBe("hi")
  expect(foldQuote("hi", { user: "a", content: "   " })).toBe("hi")
})
