import { test, expect } from "bun:test"
import { enrich, foldQuote, foldAttachments } from "../hub/enrich"

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

test("foldAttachments is a no-op with no files", () => {
  expect(foldAttachments("look at this", [])).toBe("look at this")
  expect(foldAttachments("look at this", undefined)).toBe("look at this")
})

test("foldAttachments lists downloaded files as readable local paths", () => {
  const out = foldAttachments("see the screenshot", [
    { name: "shot.png", type: "image/png", size: 2048, path: "/state/att/0_shot.png" },
  ])
  expect(out).toBe(
    "📎 Attached file(s) — use the Read tool on these local paths:\n" +
    "  • /state/att/0_shot.png (image/png, 2.0 KB)\n" +
    "\nsee the screenshot",
  )
})

test("foldAttachments humanizes sizes and flags undownloaded files", () => {
  const out = foldAttachments("msg", [
    { name: "a.bin", type: "application/octet-stream", size: 500 },
    { name: "big.zip", type: "application/zip", size: 5_242_880, path: "/d/1_big.zip" },
  ])
  expect(out).toBe(
    "📎 Attached file(s) — use the Read tool on these local paths:\n" +
    "  • a.bin (application/octet-stream, 500 B) — NOT downloaded\n" +
    "  • /d/1_big.zip (application/zip, 5.0 MB)\n" +
    "\nmsg",
  )
})
