import { test, expect } from "bun:test"
import { toolCallToWire } from "./server"

test("post_card maps to a notify wire message", () => {
  const wire = toolCallToWire("post_card", {
    chat_id: "C1",
    card: { title: "t", body: "b", buttons: [{ customId: "action:dismiss:T1", label: "Close" }] },
    correlation_id: "T1",
  })
  expect(wire).toEqual({
    t: "notify", chatId: "C1",
    card: { title: "t", body: "b", buttons: [{ customId: "action:dismiss:T1", label: "Close" }] },
    correlationId: "T1",
  })
})

test("react and edit_message map to wire messages", () => {
  expect(toolCallToWire("react", { chat_id: "C1", message_id: "m", emoji: "✅" }))
    .toEqual({ t: "react", chatId: "C1", messageId: "m", emoji: "✅" })
  expect(toolCallToWire("edit_message", { chat_id: "C1", message_id: "m", text: "x" }))
    .toEqual({ t: "edit", chatId: "C1", messageId: "m", text: "x" })
})

test("reply tool is no longer mapped (replies come via stdout result)", () => {
  expect(toolCallToWire("reply", { chat_id: "C1", text: "x" })).toBeNull()
})
