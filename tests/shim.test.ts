import { test, expect } from "bun:test"
import { inboundToChannelNotification, toolCallToWire } from "../shim/server"

test("socket inbound → channel notification params", () => {
  const params = inboundToChannelNotification({
    chatKey: "dm:u",
    inbound: { chatId: "c", messageId: "m", userId: "u", user: "bob",
      content: "hello", ts: "t", isDM: true },
  })
  expect(params.content).toBe("hello")
  expect(params.meta.chat_id).toBe("c")
  expect(params.meta.message_id).toBe("m")
  expect(params.meta.user).toBe("bob")
})

test("reply tool call → wire reply message", () => {
  const wire = toolCallToWire("reply", { chat_id: "c", text: "hi", reply_to: "m" })
  expect(wire).toEqual({ t: "reply", chatId: "c", text: "hi", replyTo: "m", files: undefined })
})

test("react tool call → wire react message", () => {
  const wire = toolCallToWire("react", { chat_id: "c", message_id: "m", emoji: "👍" })
  expect(wire).toEqual({ t: "react", chatId: "c", messageId: "m", emoji: "👍" })
})
