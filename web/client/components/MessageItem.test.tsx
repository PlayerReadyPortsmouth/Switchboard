import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import type { Message, MessageOrigin } from "../types"
import { MessageItem } from "./MessageItem"

const screen = within(document.body)
afterEach(cleanup)

const message = (content: string, origin: MessageOrigin = "agent"): Message => ({
  id: "m1", conversationId: "c1", sequence: 1, author: "Ada", origin, content,
  replyTo: null, state: "completed", clientKey: null, createdAt: 1_700_000_000_000,
})

const show = (content: string, origin: MessageOrigin = "agent") =>
  render(<MessageItem message={message(content, origin)} grouped={false} onReply={() => {}} />)

test("markdown in a message renders as real elements", () => {
  show("**bold** and *italic* and `code`\n\n- one\n- two")
  expect(document.querySelector(".message-body strong")?.textContent).toBe("bold")
  expect(document.querySelector(".message-body em")?.textContent).toBe("italic")
  expect(document.querySelector(".message-body code")?.textContent).toBe("code")
  expect(document.querySelectorAll(".message-body ul li").length).toBe(2)
})

// The regression this whole change had to avoid: before markdown, the transcript relied on
// `white-space: pre-wrap`, so every single newline was a visible break. Parsing naively would
// collapse them into spaces and silently reflow every plain multi-line message ever sent.
test("a plain multi-line message keeps its line breaks", () => {
  show("Deploy finished.\nThree files changed.\nNo tests failed.")
  const paragraph = document.querySelector(".message-body p") as HTMLElement
  expect(paragraph.querySelectorAll("br").length).toBe(2)
  expect(document.querySelectorAll(".message-body p").length).toBe(1)
})

test("a fenced block renders as a code block carrying its language", () => {
  show("Here:\n\n```python\nprint('hi')\n```")
  const pre = document.querySelector(".message-body pre") as HTMLElement
  expect(pre.getAttribute("data-language")).toBe("python")
  expect(pre.textContent).toBe("print('hi')")
  expect(document.querySelector(".markdown-code-language")?.textContent).toBe("python")
})

test("a table renders inside its own horizontal scroll wrapper", () => {
  show("| a | b |\n| --- | --- |\n| 1 | 2 |")
  expect(document.querySelector(".message-body .markdown-table-scroll table")).not.toBeNull()
  expect(screen.getByRole("columnheader", { name: "a" })).toBeTruthy()
})

// Discord renders everyone's markdown, so a web-origin message is not a special case.
test("web-origin messages render markdown too", () => {
  show("**mine**", "web")
  expect(document.querySelector(".message-body strong")?.textContent).toBe("mine")
})

test("injected markup and javascript: links in a message stay inert", () => {
  show('<script>alert(1)</script> [x](javascript:alert(2)) <img src=y onerror="alert(3)">')
  expect(document.querySelector(".message-body script")).toBeNull()
  expect(document.querySelector(".message-body img")).toBeNull()
  expect(document.querySelectorAll(".message-body a").length).toBe(0)
  expect(document.body.textContent).toContain("alert(1)")
})

test("the reply affordance survives markdown rendering", () => {
  show("**bold**")
  expect(screen.getByRole("button", { name: /Reply to message from Ada/ })).toBeTruthy()
})
