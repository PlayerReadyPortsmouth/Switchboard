import { test, expect } from "bun:test"
import { toolCallToWire, validateCard, validateToolArgs } from "./server"

test("validateCard accepts a well-formed card", () => {
  expect(validateCard({ title: "t", body: "b", buttons: [] })).toBeNull()
  expect(validateCard({ title: "t", body: "", buttons: [{ customId: "a:b:c", label: "Go" }] })).toBeNull()
})

test("validateCard rejects a missing or non-object card with a clear reason", () => {
  expect(validateCard(undefined)).toMatch(/card is required/)
  expect(validateCard(null)).toMatch(/card is required/)
  expect(validateCard("nope")).toMatch(/card is required/)
  expect(validateCard([])).toMatch(/card is required/)
})

test("validateCard rejects an empty/missing title", () => {
  expect(validateCard({ body: "b", buttons: [] })).toMatch(/card\.title/)
  expect(validateCard({ title: "", body: "b", buttons: [] })).toMatch(/card\.title/)
  expect(validateCard({ title: "   ", body: "b", buttons: [] })).toMatch(/card\.title/)
  expect(validateCard({ title: 42, body: "b", buttons: [] })).toMatch(/card\.title/)
})

test("validateCard rejects a non-string body and non-array buttons", () => {
  expect(validateCard({ title: "t", body: 1, buttons: [] })).toMatch(/card\.body/)
  expect(validateCard({ title: "t", body: "b", buttons: "x" })).toMatch(/card\.buttons/)
  expect(validateCard({ title: "t", body: "b" })).toMatch(/card\.buttons/)
})

test("validateCard rejects a button missing customId or label, naming the index", () => {
  expect(validateCard({ title: "t", body: "b", buttons: [{ label: "Go" }] })).toMatch(/buttons\[0\]\.customId/)
  expect(validateCard({ title: "t", body: "b", buttons: [{ customId: "a" }] })).toMatch(/buttons\[0\]\.label/)
  expect(validateCard({ title: "t", body: "b", buttons: [{ customId: "a", label: "ok" }, {}] })).toMatch(/buttons\[1\]/)
})

test("validateToolArgs delegates card tools to validateCard", () => {
  expect(validateToolArgs("post_card", { chat_id: "C1", card: { title: "t", body: "b", buttons: [] } })).toBeNull()
  expect(validateToolArgs("post_card", { chat_id: "C1", card: { body: "b", buttons: [] } })).toMatch(/card\.title/)
  expect(validateToolArgs("update_card", { chat_id: "C1", correlation_id: "T1", card: { title: "t", body: "b", buttons: [] } })).toBeNull()
  expect(validateToolArgs("update_card", { chat_id: "C1", correlation_id: "T1", card: "nope" })).toMatch(/card is required/)
})

test("validateToolArgs requires chat_id on card tools", () => {
  expect(validateToolArgs("post_card", { card: { title: "t", body: "b", buttons: [] } })).toMatch(/chat_id/)
  expect(validateToolArgs("post_card", { chat_id: "", card: { title: "t", body: "b", buttons: [] } })).toMatch(/chat_id/)
})

test("validateToolArgs validates react required string fields", () => {
  expect(validateToolArgs("react", { chat_id: "C1", message_id: "m", emoji: "✅" })).toBeNull()
  expect(validateToolArgs("react", { chat_id: "C1", message_id: "m" })).toMatch(/emoji/)
  expect(validateToolArgs("react", { chat_id: "C1", emoji: "✅" })).toMatch(/message_id/)
  expect(validateToolArgs("react", { message_id: "m", emoji: "✅" })).toMatch(/chat_id/)
})

test("validateToolArgs validates edit_message required string fields", () => {
  expect(validateToolArgs("edit_message", { chat_id: "C1", message_id: "m", text: "x" })).toBeNull()
  expect(validateToolArgs("edit_message", { chat_id: "C1", message_id: "m", text: "" })).toMatch(/text/)
})

test("validateToolArgs validates attach_file required string fields", () => {
  expect(validateToolArgs("attach_file", { chat_id: "C1", path: "r.pdf" })).toBeNull()
  expect(validateToolArgs("attach_file", { chat_id: "C1" })).toMatch(/path/)
})

test("validateToolArgs validates post_webhook, remember, notify_peer", () => {
  expect(validateToolArgs("post_webhook", { target: "deploy-done" })).toBeNull()
  expect(validateToolArgs("post_webhook", {})).toMatch(/target/)
  expect(validateToolArgs("remember", { title: "T", body: "B" })).toBeNull()
  expect(validateToolArgs("remember", { title: "T" })).toMatch(/body/)
  expect(validateToolArgs("notify_peer", { target: "p:a", text: "hi" })).toBeNull()
  expect(validateToolArgs("notify_peer", { target: "p:a" })).toMatch(/text/)
})

test("validateToolArgs returns null for tools without required fields", () => {
  expect(validateToolArgs("finish", {})).toBeNull()
  expect(validateToolArgs("something_unknown", {})).toBeNull()
})

test("validateToolArgs does not validate request/response tools handled separately", () => {
  // publish_link / recall / ask_* run in their own handler branches before the
  // generic validate+write path, so they are intentionally not covered here.
  expect(validateToolArgs("publish_link", {})).toBeNull()
})

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

import { test as ut, expect as ue } from "bun:test"
import { toolCallToWire as wire } from "./server"

ut("update_card maps to an update wire message", () => {
  ue(wire("update_card", { chat_id: "c", correlation_id: "T1", card: { title: "x" } }) as any)
    .toEqual({ t: "update", chatId: "c", correlationId: "T1", card: { title: "x" } })
})

ut("finish maps to a finish wire message", () => {
  ue(wire("finish", {})).toEqual({ t: "finish" } as any)
})

ut("remember maps to a remember wire message", () => {
  ue(wire("remember", { scope: "global", title: "T", tags: ["a"], body: "B" }) as any)
    .toEqual({ t: "remember", scope: "global", title: "T", tags: ["a"], body: "B" })
})

ut("recall is not a fire-and-forget wire message (handled request/response)", () => {
  ue(wire("recall", { query: "x" })).toBeNull()
})

ut("post_webhook maps to a post_webhook wire message addressed by target", () => {
  ue(wire("post_webhook", { target: "deploy-done", body: '{"ref":"v2"}' }) as any)
    .toEqual({ t: "post_webhook", target: "deploy-done", body: '{"ref":"v2"}' })
})

ut("attach_file maps to an attach wire message", () => {
  ue(wire("attach_file", {
    chat_id: "C1", path: "report.pdf", caption: "here you go", filename: "Report.pdf",
  }) as any).toEqual({
    t: "attach", chatId: "C1", path: "report.pdf", caption: "here you go", filename: "Report.pdf",
  })
})

ut("publish_link maps to a publish wire message", () => {
  ue(wire("publish_link", { path: "r.pdf", mode: "view", title: "R", scope: "staff", ttl_days: 7 }) as any)
    .toEqual({ t: "publish", path: "r.pdf", mode: "view", title: "R", scope: "staff", ttlDays: 7 })
})

ut("notify_peer maps to a fire-and-forget wire frame", () => {
  ue(wire("notify_peer", { target: "p:agent", text: "hi" }) as any)
    .toEqual({ t: "notify_peer", target: "p:agent", text: "hi" })
})
