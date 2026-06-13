import { test, expect } from "bun:test"
import { enrich } from "../hub/enrich"

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
