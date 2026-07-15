import { test, expect } from "bun:test"
import { buildWebInboundMessage, formatMirrorLine } from "./webActions"

test("buildWebInboundMessage tags the actor as web:<email> and isn't a DM", () => {
  const m = buildWebInboundMessage("chan-1", "aurora@player-ready.co.uk", "hello", 1000, () => "web-1")
  expect(m).toEqual({
    chatId: "chan-1", messageId: "web-1", userId: "web:aurora@player-ready.co.uk",
    user: "aurora@player-ready.co.uk", content: "hello", ts: new Date(1000).toISOString(), isDM: false,
  })
})

test("formatMirrorLine matches the Discord mirror convention", () => {
  expect(formatMirrorLine("aurora@player-ready.co.uk", "hello")).toBe(
    "**aurora@player-ready.co.uk (web):** hello",
  )
})
