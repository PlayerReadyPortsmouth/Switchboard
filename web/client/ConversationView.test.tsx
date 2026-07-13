import "./testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConversationView, type ConversationViewApi } from "./App"
import { DraftStore } from "./drafts"
import type { Conversation, ConversationEvent, Message, Session, TransportLink } from "./types"

const screen = within(document.body)
const conversation: Conversation = {
  id: "c1", title: "Release review", primaryAgent: "architect", createdBy: "ada@example.com",
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000, archivedAt: null,
}
const session: Session = {
  identity: "ada@example.com",
  agents: [{ name: "architect", alive: true, busy: false }, { name: "reviewer", alive: true, busy: false }, { name: "operator", alive: true, busy: false }],
}
const message = (overrides: Partial<Message> = {}): Message => ({
  id: "m1", conversationId: "c1", sequence: 1, author: "Ada", origin: "web", content: "Ship it",
  replyTo: null, state: "committed", clientKey: "canonical-key", createdAt: 1_700_000_000_000, ...overrides,
})

function draftStore(keys = ["key-1", "key-2", "key-3"]) {
  const storage = new Map<string, string>()
  let fallback = 0
  return new DraftStore({
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) },
    removeItem: key => { storage.delete(key) },
  }, () => keys.shift() ?? `fallback-key-${++fallback}`, () => 123)
}

function api(overrides: Partial<ConversationViewApi> = {}): ConversationViewApi {
  return {
    postMessage: async (_conversationId, input) => message({ id: "posted", sequence: 9, content: input.content, replyTo: input.replyTo ?? null, clientKey: input.clientKey }),
    updateConversation: async (_conversationId, input) => ({ ...conversation, ...input, updatedAt: conversation.updatedAt + 1 }),
    ...overrides,
  }
}

afterEach(cleanup)

describe("canonical conversation view", () => {
  test("keeps failed text and idempotency key, then clears only after success", async () => {
    const keys: string[] = []
    let attempts = 0
    const viewApi = api({ postMessage: async (_id, input) => {
      keys.push(input.clientKey)
      if (attempts++ === 0) throw new Error("offline")
      return message({ id: "posted", sequence: 2, content: input.content, clientKey: input.clientKey })
    } })
    render(<ConversationView api={viewApi} conversation={conversation} drafts={draftStore()} />)
    const composer = screen.getByRole("textbox", { name: "Message" })

    await userEvent.type(composer, "Ship it")
    await userEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect((composer as HTMLTextAreaElement).value).toBe("Ship it")
    expect(screen.getByRole("status").textContent).toContain("Message not sent")

    await userEvent.click(screen.getByRole("button", { name: "Retry send" }))
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""))
    expect(keys[0]).toBe(keys[1])
  })

  test("does not insert an optimistic row and clears only the matching draft", async () => {
    let resolve!: (value: Message) => void
    const pending = new Promise<Message>(yes => { resolve = yes })
    const drafts = draftStore(["send-key", "new-key"])
    render(<ConversationView api={api({ postMessage: () => pending })} conversation={conversation} drafts={drafts} />)
    const composer = screen.getByRole("textbox", { name: "Message" })

    await userEvent.type(composer, "First")
    await userEvent.click(screen.getByRole("button", { name: "Send message" }))
    expect(screen.queryByRole("article")).toBeNull()
    expect(screen.getAllByText("Sending…")).toHaveLength(2)
    await userEvent.clear(composer)
    await userEvent.type(composer, "New typing")
    act(() => resolve(message({ id: "canonical", content: "First", clientKey: "send-key" })))

    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("New typing"))
    expect(drafts.read("c1")?.text).toBe("New typing")
    expect(screen.getByRole("article", { name: /Message from Ada/ }).textContent).toContain("First")
  })

  test("supports Enter send, Shift+Enter newline, IME composition, blank disable, and a six-line cap", async () => {
    const sent: string[] = []
    render(<ConversationView api={api({ postMessage: async (_id, input) => { sent.push(input.content); return message({ content: input.content }) } })} conversation={conversation} drafts={draftStore()} />)
    const composer = screen.getByRole("textbox", { name: "Message" })
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.type(composer, "Line one")
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}Line two")
    expect((composer as HTMLTextAreaElement).value).toBe("Line one\nLine two")
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true })
    expect(sent).toEqual([])
    fireEvent.keyDown(composer, { key: "Enter" })

    await waitFor(() => expect(sent).toEqual(["Line one\nLine two"]))
    expect(composer.getAttribute("rows")).toBe("1")
    expect((composer as HTMLTextAreaElement).style.maxHeight).toBe("calc(6 * 1.5em + 24px)")
  })

  test("renders origins as distinct accessible message labels", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[
      message(),
      message({ id: "m2", sequence: 2, author: "architect", origin: "agent" }),
      message({ id: "m3", sequence: 3, author: "Discord", origin: "transport" }),
      message({ id: "m4", sequence: 4, author: "Switchboard", origin: "system" }),
    ]} />)

    expect(screen.getByRole("article", { name: "Message from Ada (Web)" })).toBeTruthy()
    expect(screen.getByRole("article", { name: "Message from architect (Agent)" })).toBeTruthy()
    expect(screen.getByRole("article", { name: "Message from Discord (Transport)" })).toBeTruthy()
    expect(screen.getByRole("article", { name: "Message from Switchboard (System)" })).toBeTruthy()
  })

  test("groups only adjacent same-author non-replies within five minutes", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[
      message(),
      message({ id: "m2", sequence: 2, createdAt: conversation.createdAt + 299_000 }),
      message({ id: "m3", sequence: 3, createdAt: conversation.createdAt + 600_000 }),
      message({ id: "m4", sequence: 4, createdAt: conversation.createdAt + 601_000, replyTo: "m1" }),
    ]} />)
    const rows = screen.getAllByRole("article")
    expect(rows[1].getAttribute("data-grouped")).toBe("true")
    expect(rows[2].getAttribute("data-grouped")).toBe("false")
    expect(rows[3].getAttribute("data-grouped")).toBe("false")
  })

  test("resolves reply preview and lets the user dismiss it", async () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message({ content: "Parent message" })]} />)
    await userEvent.click(screen.getByRole("button", { name: "Reply to message from Ada" }))
    expect(screen.getByText("Parent message", { selector: ".reply-preview blockquote" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss reply" }))
    expect(document.querySelector(".reply-preview")).toBeNull()
  })

  test("collapses live activity and does not repeat streaming announcements", () => {
    const activity: ConversationEvent[] = [
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 1, state: "queued" },
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 2, state: "working" },
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 3, state: "streaming", detail: { chunk: "a" } },
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 4, state: "streaming", detail: { chunk: "b" } },
    ]
    render(<ConversationView api={api()} conversation={conversation} activity={activity} />)
    const disclosure = screen.getByText("Live activity").closest("details")!
    expect(disclosure.hasAttribute("open")).toBe(false)
    expect(within(disclosure).getAllByText("Streaming")).toHaveLength(1)
    expect(document.querySelectorAll("[data-activity-announcement='streaming']")).toHaveLength(1)
  })

  test("refreshes the header from the canonical primary-agent PATCH response", async () => {
    render(<ConversationView api={api()} conversation={conversation} session={session} inspectorOpen />)
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Primary agent" }), "reviewer")
    expect(await screen.findByText("reviewer", { selector: ".transcript-header .eyebrow" })).toBeTruthy()
  })

  test("lists truthful link metadata without exposing internal or external identifiers", async () => {
    const links: TransportLink[] = [{
      id: "internal-link-id", conversationId: "c1", adapter: "discord", externalLocationId: "secret-channel-id",
      label: "Release room", syncMode: "two_way", enabled: true, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000,
    }]
    render(<ConversationView api={api({ listLinks: async () => links })} conversation={conversation} session={session} inspectorOpen />)

    expect(await screen.findByText("Release room")).toBeTruthy()
    expect(screen.getByText("Two-way sync")).toBeTruthy()
    expect(screen.getByText("Enabled")).toBeTruthy()
    expect(document.body.textContent).not.toContain("internal-link-id")
    expect(document.body.textContent).not.toContain("secret-channel-id")
  })

  test("deduplicates canonical transcript rows by id and sequence order", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[
      message({ id: "m2", sequence: 2, content: "Second" }),
      message({ id: "m1", sequence: 1, content: "First" }),
      message({ id: "m1", sequence: 1, content: "First" }),
    ]} />)
    const rows = screen.getAllByRole("article")
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain("First")
    expect(rows[1].textContent).toContain("Second")
  })

  test("does not reduce a late send response into a newly selected conversation", async () => {
    let resolve!: (value: Message) => void
    const pending = new Promise<Message>(yes => { resolve = yes })
    const drafts = draftStore()
    const { rerender } = render(<ConversationView api={api({ postMessage: () => pending })} conversation={conversation} drafts={drafts} />)
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Old request")
    await userEvent.click(screen.getByRole("button", { name: "Send message" }))

    rerender(<ConversationView api={api()} conversation={{ ...conversation, id: "c2", title: "Other conversation" }} drafts={drafts} />)
    act(() => resolve(message({ content: "Old request" })))

    await screen.findByRole("heading", { name: "Other conversation" })
    expect(screen.queryByRole("article")).toBeNull()
  })

  test("keeps the latest canonical primary-agent response when PATCH requests resolve out of order", async () => {
    const requests = new Map<string, (value: Conversation) => void>()
    render(<ConversationView api={api({ updateConversation: (_id, input) => new Promise(resolve => requests.set(input.primaryAgent!, resolve)) })} conversation={conversation} session={session} inspectorOpen />)
    const selector = screen.getByRole("combobox", { name: "Primary agent" })

    await userEvent.selectOptions(selector, "reviewer")
    await userEvent.selectOptions(selector, "operator")
    act(() => requests.get("operator")!({ ...conversation, primaryAgent: "operator", updatedAt: 3 }))
    act(() => requests.get("reviewer")!({ ...conversation, primaryAgent: "reviewer", updatedAt: 2 }))

    expect(await screen.findByText("operator", { selector: ".transcript-header .eyebrow" })).toBeTruthy()
  })

  test("traps focus inside a drawer inspector", () => {
    render(<ConversationView api={api()} conversation={conversation} session={session} inspectorOpen onInspectorEscape={() => {}} />)
    const inspector = screen.getByRole("region", { name: "Conversation inspector" })
    const selector = screen.getByRole("combobox", { name: "Primary agent" })
    const close = screen.getByRole("button", { name: "Close conversation details" })

    selector.focus()
    fireEvent.keyDown(inspector, { key: "Tab" })
    expect(document.activeElement === close).toBe(true)

    close.focus()
    fireEvent.keyDown(inspector, { key: "Tab", shiftKey: true })
    expect(document.activeElement === selector).toBe(true)
  })

  test("collapses the desktop inspector without reserving an empty grid column", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text()
    expect(css).toMatch(/\.workspace-shell:has\(\.inspector\[data-open="false"\]\)\s*\{[^}]*grid-template-columns:[^}]*0/)
    expect(css).toMatch(/\.inspector\[data-open="false"\]\s*\{[^}]*visibility:\s*hidden/)
  })
})
