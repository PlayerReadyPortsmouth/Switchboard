import "../testSetup"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, within } from "@testing-library/react"
import { ConversationView } from "../App"
import { DraftStore } from "../drafts"
import { isPinnedToBottom, PIN_THRESHOLD_PX } from "./useTranscriptAutoscroll"
import type { Conversation, Message } from "../types"

const screen = within(document.body)

/*
 * happy-dom has no layout engine, so scrollHeight/clientHeight are always 0 and
 * every element reads as "already at the bottom". These accessors simulate a
 * transcript viewport: the scroll container is 400px tall and each rendered
 * message adds 200px of content, with scrollTop clamped the way a browser
 * clamps it. Everything else keeps happy-dom's zeroes.
 */
const VIEWPORT = 400
const MESSAGE_HEIGHT = 200
const scrollTops = new WeakMap<Element, number>()
const scrollToCalls: { top: number; behavior?: string }[] = []

function isScroller(element: Element): boolean {
  return element instanceof HTMLElement && element.dataset.region === "transcript-scroll"
}
function contentHeight(element: Element): number {
  return VIEWPORT + element.querySelectorAll(".message-item").length * MESSAGE_HEIGHT
}
function maxScrollTop(element: Element): number {
  return contentHeight(element) - VIEWPORT
}

Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) { return isScroller(this) ? VIEWPORT : 0 },
})
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) { return isScroller(this) ? contentHeight(this) : 0 },
})
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get(this: HTMLElement) { return scrollTops.get(this) ?? 0 },
  set(this: HTMLElement, value: number) {
    scrollTops.set(this, isScroller(this) ? Math.max(0, Math.min(value, maxScrollTop(this))) : value)
  },
})
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value(this: HTMLElement, options: { top: number; behavior?: string }) {
    scrollToCalls.push(options)
    this.scrollTop = options.top
  },
})

const conversation: Conversation = {
  id: "c1", title: "Release review", primaryAgent: "architect", createdBy: "ada@example.com",
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000, archivedAt: null,
}
function messages(count: number, conversationId = "c1"): Message[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${conversationId}-m${index + 1}`, conversationId, sequence: index + 1, author: "Ada",
    origin: "web" as const, content: `Message ${index + 1}`, replyTo: null, state: "committed" as const,
    clientKey: `k${index + 1}`, createdAt: 1_700_000_000_000 + index * 60_000,
  }))
}
function drafts() {
  const storage = new Map<string, string>()
  return new DraftStore({
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) },
    removeItem: key => { storage.delete(key) },
  }, () => "key-1", () => 123)
}
function view(overrides: { conversation?: Conversation; messages?: Message[] } = {}) {
  return <ConversationView api={{}} drafts={drafts()} conversation={overrides.conversation ?? conversation} messages={overrides.messages ?? messages(6)} />
}
function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-region="transcript-scroll"]')
  if (!element) throw new Error("transcript scroll container not rendered")
  return element
}
function scrollTo(element: HTMLElement, top: number) {
  act(() => {
    element.scrollTop = top
    fireEvent.scroll(element)
  })
}

beforeEach(() => { scrollToCalls.length = 0 })
afterEach(cleanup)

describe("isPinnedToBottom", () => {
  test("counts a reader within the threshold of the bottom as pinned", () => {
    expect(isPinnedToBottom({ scrollTop: 1000, scrollHeight: 1400, clientHeight: 400 })).toBe(true)
    expect(isPinnedToBottom({ scrollTop: 1000 - PIN_THRESHOLD_PX, scrollHeight: 1400, clientHeight: 400 })).toBe(true)
  })
  test("counts a reader further up as not pinned", () => {
    expect(isPinnedToBottom({ scrollTop: 1000 - PIN_THRESHOLD_PX - 1, scrollHeight: 1400, clientHeight: 400 })).toBe(false)
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 1400, clientHeight: 400 })).toBe(false)
  })
  test("treats content shorter than the viewport as pinned", () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toBe(true)
  })
})

describe("transcript autoscroll", () => {
  test("opens at the newest message, not the top", () => {
    render(view())
    const element = scroller()
    expect(element.scrollTop).toBe(maxScrollTop(element))
    expect(element.scrollTop).toBeGreaterThan(0)
  })

  test("lands at the bottom without a smooth scroll animation", () => {
    render(view())
    expect(scrollToCalls.filter(call => call.behavior === "smooth")).toHaveLength(0)
  })

  test("follows a new message while the reader is pinned to the bottom", () => {
    const { rerender } = render(view({ messages: messages(6) }))
    const element = scroller()
    const before = element.scrollTop
    rerender(view({ messages: messages(7) }))
    expect(element.scrollTop).toBe(maxScrollTop(element))
    expect(element.scrollTop).toBeGreaterThan(before)
  })

  // The regression that matters: a message arriving mid-read must never move
  // the viewport out from under the reader.
  test("does not scroll when the user has scrolled up", () => {
    const { rerender } = render(view({ messages: messages(6) }))
    const element = scroller()
    scrollTo(element, 0)
    expect(element.scrollTop).toBe(0)
    rerender(view({ messages: messages(7) }))
    expect(element.scrollTop).toBe(0)
    rerender(view({ messages: messages(8) }))
    expect(element.scrollTop).toBe(0)
  })

  test("resumes following once the reader scrolls back to the bottom", () => {
    const { rerender } = render(view({ messages: messages(6) }))
    const element = scroller()
    scrollTo(element, 0)
    rerender(view({ messages: messages(7) }))
    expect(element.scrollTop).toBe(0)
    scrollTo(element, maxScrollTop(element))
    rerender(view({ messages: messages(8) }))
    expect(element.scrollTop).toBe(maxScrollTop(element))
  })

  test("opens each conversation at its own bottom without leaking scroll position", () => {
    const other: Conversation = { ...conversation, id: "c2", title: "Incident review" }
    const { rerender } = render(view({ messages: messages(6) }))
    scrollTo(scroller(), 0)
    rerender(view({ conversation: other, messages: messages(9, "c2") }))
    const element = scroller()
    expect(element.scrollTop).toBe(maxScrollTop(element))
    expect(element.scrollTop).toBeGreaterThan(0)
  })

  test("offers jump-to-latest only while scrolled away from the newest message", () => {
    render(view({ messages: messages(6) }))
    const element = scroller()
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()
    scrollTo(element, 0)
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy()
  })

  test("jump-to-latest returns to the bottom and re-pins", () => {
    const { rerender } = render(view({ messages: messages(6) }))
    const element = scroller()
    scrollTo(element, 0)
    act(() => { screen.getByRole("button", { name: "Jump to latest" }).click() })
    expect(element.scrollTop).toBe(maxScrollTop(element))
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()
    rerender(view({ messages: messages(7) }))
    expect(element.scrollTop).toBe(maxScrollTop(element))
  })

  test("never renders jump-to-latest for an empty transcript", () => {
    render(view({ messages: [] }))
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull()
  })
})
