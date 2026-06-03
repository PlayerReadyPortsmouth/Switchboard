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
