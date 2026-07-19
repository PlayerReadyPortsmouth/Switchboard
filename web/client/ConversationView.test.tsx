import "./testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConversationView, type ConversationViewApi } from "./App"
import { DraftStore } from "./drafts"
import type { Conversation, ConversationEvent, DocumentAttachment, Message, Session, TransportLink } from "./types"

const screen = within(document.body)
const conversation: Conversation = {
  id: "c1", title: "Release review", primaryAgent: "architect", createdBy: "ada@example.com",
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000, archivedAt: null,
}
const session: Session = {
  identity: "ada@example.com",
  features: { agents: true, documents: false, turnSteps: false, cards: false },
  permissions: { agents: "operator" },
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
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
    expect(screen.getByRole("status", { name: "Message send status" }).textContent).toContain("Message not sent")

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

  test("folds turn states into the execution spine without repeating streaming announcements", () => {
    const activity: ConversationEvent[] = [
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 1, state: "queued" },
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 2, state: "working" },
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 3, state: "streaming", detail: { chunk: "a" } },
      { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 4, state: "streaming", detail: { chunk: "b" } },
    ]
    render(<ConversationView api={api()} conversation={conversation} activity={activity} />)
    const spine = screen.getByRole("list", { name: "Turn activity" })
    expect(within(spine).getAllByText("Streaming")).toHaveLength(1)
    expect(within(spine).getByText("Queued")).toBeTruthy()
    expect(document.querySelectorAll("[data-activity-announcement='streaming']")).toHaveLength(1)
  })

  test("renders tool steps inline in the spine only when the turnSteps feature is on", () => {
    const toolSteps = [
      { id: "t1", name: "Read", summary: "hub/index.ts", status: "ok" as const, durationMs: 420 },
      { id: "t2", name: "Grep", summary: "shareLinks", status: "running" as const },
    ]
    const off = render(<ConversationView api={api()} conversation={conversation} session={session} toolSteps={toolSteps} />)
    expect(screen.queryByText("Read")).toBeNull()
    off.unmount()

    render(<ConversationView api={api()} conversation={conversation} session={{ ...session, features: { ...session.features, turnSteps: true } }} toolSteps={toolSteps} />)
    const spine = screen.getByRole("list", { name: "Turn activity" })
    expect(within(spine).getByText("Read")).toBeTruthy()
    expect(within(spine).getByText("hub/index.ts")).toBeTruthy()
    expect(within(spine).getByText("420ms")).toBeTruthy()
    expect(spine.querySelector("[data-tool='Grep']")?.getAttribute("data-status")).toBe("running")
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

  test("restores the canonical agent, announces PATCH failure, and remains usable for retry", async () => {
    const first = deferred<Conversation>()
    const second = deferred<Conversation>()
    let attempts = 0
    render(<ConversationView api={api({ updateConversation: () => attempts++ === 0 ? first.promise : second.promise })} conversation={conversation} session={session} inspectorOpen />)
    const selector = screen.getByRole("combobox", { name: "Primary agent" }) as HTMLSelectElement

    await userEvent.selectOptions(selector, "reviewer")
    await act(async () => first.reject(new Error("offline")))

    expect(selector.value).toBe("architect")
    expect(selector.disabled).toBe(false)
    const error = screen.getByRole("status", { name: "Primary agent update status" })
    expect(error.textContent).toContain("Primary agent could not be updated")
    expect(error.getAttribute("aria-live")).toBe("polite")

    await userEvent.selectOptions(selector, "reviewer")
    await act(async () => second.resolve({ ...conversation, primaryAgent: "reviewer", updatedAt: 3 }))
    expect(await screen.findByText("reviewer", { selector: ".transcript-header .eyebrow" })).toBeTruthy()
    expect(error.textContent).toBe("")
  })

  test("ignores an older PATCH failure after a newer canonical success", async () => {
    const reviewer = deferred<Conversation>()
    const operator = deferred<Conversation>()
    render(<ConversationView api={api({ updateConversation: (_id, input) => input.primaryAgent === "reviewer" ? reviewer.promise : operator.promise })} conversation={conversation} session={session} inspectorOpen />)
    const selector = screen.getByRole("combobox", { name: "Primary agent" })

    await userEvent.selectOptions(selector, "reviewer")
    await userEvent.selectOptions(selector, "operator")
    await act(async () => operator.resolve({ ...conversation, primaryAgent: "operator", updatedAt: 3 }))
    await act(async () => reviewer.reject(new Error("late failure")))

    expect(screen.getByText("operator", { selector: ".transcript-header .eyebrow" })).toBeTruthy()
    expect(screen.getByRole("status", { name: "Primary agent update status" }).textContent).toBe("")
  })

  test("ignores PATCH failure after switching conversations", async () => {
    const pending = deferred<Conversation>()
    const viewApi = api({ updateConversation: () => pending.promise })
    const { rerender } = render(<ConversationView api={viewApi} conversation={conversation} session={session} inspectorOpen />)
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Primary agent" }), "reviewer")

    rerender(<ConversationView api={viewApi} conversation={{ ...conversation, id: "c2", title: "Other conversation" }} session={session} inspectorOpen />)
    await act(async () => pending.reject(new Error("late failure")))

    expect(screen.getByRole("heading", { name: "Other conversation" })).toBeTruthy()
    expect(screen.getByRole("status", { name: "Primary agent update status" }).textContent).toBe("")
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

  test("groups same-author adjacent messages exactly five minutes apart", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message(), message({ id: "m2", sequence: 2, createdAt: 1_700_000_300_000 })]} />)
    expect(screen.getAllByRole("article")[1].getAttribute("data-grouped")).toBe("true")
  })

  test("does not group messages over five minutes apart", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message(), message({ id: "m2", sequence: 2, createdAt: 1_700_000_300_001 })]} />)
    expect(screen.getAllByRole("article")[1].getAttribute("data-grouped")).toBe("false")
  })

  test("does not group a later sequence with an earlier timestamp", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message(), message({ id: "m2", sequence: 2, createdAt: 1_699_999_999_999 })]} />)
    expect(screen.getAllByRole("article")[1].getAttribute("data-grouped")).toBe("false")
  })

  test("does not group adjacent messages when the author changes", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message(), message({ id: "m2", sequence: 2, author: "architect", createdAt: 1_700_000_001_000 })]} />)
    expect(screen.getAllByRole("article")[1].getAttribute("data-grouped")).toBe("false")
  })

  test("does not group adjacent replies", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message(), message({ id: "m2", sequence: 2, replyTo: "m1", createdAt: 1_700_000_001_000 })]} />)
    expect(screen.getAllByRole("article")[1].getAttribute("data-grouped")).toBe("false")
  })
})

describe("transcript attachments", () => {
  const attachment = (overrides: Partial<DocumentAttachment> = {}): DocumentAttachment => ({
    token: "tok-1", title: "sprint-notes.md", contentType: "text/markdown", mode: "view",
    visibility: "org", createdAt: 0, ...overrides,
  })

  test("renders one labelled group holding a card per attachment", () => {
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[message()]}
      attachments={[attachment(), attachment({ token: "tok-2", title: "budget.csv", contentType: "text/csv", visibility: "private" })]}
    />)
    const group = screen.getByRole("region", { name: "2 documents shared" })
    const cards = within(group).getAllByRole("article")
    expect(cards).toHaveLength(2)
    expect(within(cards[0]).getByText("sprint-notes.md")).toBeTruthy()
    expect(within(cards[0]).getByText("MD")).toBeTruthy()
    expect(within(cards[1]).getByText("budget.csv")).toBeTruthy()
    expect(within(cards[1]).getByText("CSV")).toBeTruthy()
  })

  test("labels a single attachment in the singular", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message()]} attachments={[attachment()]} />)
    expect(screen.getByRole("region", { name: "1 document shared" })).toBeTruthy()
  })

  test("shows each attachment's visibility with the Documents workspace's vocabulary", () => {
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[message()]}
      attachments={[attachment({ visibility: "org" }), attachment({ token: "tok-2", visibility: "private" })]}
    />)
    const chips = Array.from(document.querySelectorAll(".document-visibility"))
    expect(chips.map(chip => chip.textContent)).toEqual(["org", "private"])
    expect(chips.map(chip => chip.getAttribute("data-visibility"))).toEqual(["org", "private"])
  })

  test("clicking a card opens the document in page rather than navigating away", async () => {
    const user = userEvent.setup()
    const opened: string[] = []
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[message()]}
      attachments={[attachment(), attachment({ token: "tok-2", title: "budget.csv" })]}
      onOpenDocument={token => opened.push(token)}
    />)
    const group = screen.getByRole("region", { name: "2 documents shared" })
    expect(within(group).queryByRole("link")).toBeNull()
    await user.click(within(group).getByRole("button", { name: /budget\.csv/ }))
    expect(opened).toEqual(["tok-2"])
  })

  test("without an in-page opener the cards degrade to /share links", () => {
    render(<ConversationView api={api()} conversation={conversation} messages={[message()]} attachments={[attachment()]} />)
    const group = screen.getByRole("region", { name: "1 document shared" })
    expect((within(group).getByRole("link") as HTMLAnchorElement).getAttribute("href")).toBe("/share/tok-1")
  })

  test("an image attachment previews inline from the documents content endpoint", () => {
    render(<ConversationView
      api={api({ documentContentUrl: token => `/api/documents/${token}/content` })}
      conversation={conversation}
      messages={[message()]}
      attachments={[attachment({ token: "tok-img", title: "screenshot.png", contentType: "image/png" })]}
    />)
    expect(document.querySelector("img.document-card-thumb")?.getAttribute("src")).toBe("/api/documents/tok-img/content")
  })
})

describe("attachment cards belong to the agent message that produced them", () => {
  const attach = (token: string, createdAt: number): DocumentAttachment => ({
    token, title: `${token}.md`, contentType: "text/markdown", mode: "view", visibility: "org", createdAt,
  })
  const agentMessage = (over: Partial<Message> = {}) =>
    message({ id: "a1", sequence: 2, author: "architect", origin: "agent", content: "Done", createdAt: 2_000, ...over })

  test("a document published mid-turn nests INSIDE the agent reply that followed it", () => {
    // The publish is stamped BEFORE the reply commits — that is the real turn ordering, and
    // the reason the anchor looks forward rather than back.
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[message({ id: "u1", sequence: 1, createdAt: 1_000 }), agentMessage({ createdAt: 3_000 })]}
      attachments={[attach("tok-1", 2_000)]}
    />)
    const agentArticle = screen.getByLabelText("Message from architect (Agent)")
    const group = within(agentArticle).getByRole("region", { name: "1 document shared" })
    expect(group.getAttribute("data-nested")).toBe("true")
    expect(within(group).getByText("tok-1.md")).toBeTruthy()
  })

  test("a document is NOT hung off the previous turn's agent reply", () => {
    // Two turns. The document is published during the second, so it must land on the second
    // reply — anchoring to the nearest PRECEDING agent message would have picked the first.
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[
        agentMessage({ id: "a1", sequence: 1, content: "First", createdAt: 1_000 }),
        agentMessage({ id: "a2", sequence: 2, content: "Second", createdAt: 5_000 }),
      ]}
      attachments={[attach("tok-1", 4_000)]}
    />)
    const articles = screen.getAllByLabelText("Message from architect (Agent)")
    expect(within(articles[0]).queryByRole("region")).toBeNull()
    expect(within(articles[1]).getByRole("region", { name: "1 document shared" })).toBeTruthy()
  })

  test("before the reply lands, the card renders at the tail rather than vanishing", () => {
    // The live moment between publish and commit: no agent message follows it yet.
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[message({ id: "u1", sequence: 1, createdAt: 1_000 })]}
      attachments={[attach("tok-1", 2_000)]}
    />)
    const group = screen.getByRole("region", { name: "1 document shared" })
    expect(group.getAttribute("data-nested")).toBe("false")
    // Not inside any message article.
    expect(group.closest(".message-item")).toBeNull()
  })

  test("several documents from one turn group under that turn's single reply", () => {
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[agentMessage({ createdAt: 9_000 })]}
      attachments={[attach("tok-1", 2_000), attach("tok-2", 3_000)]}
    />)
    const agentArticle = screen.getByLabelText("Message from architect (Agent)")
    const group = within(agentArticle).getByRole("region", { name: "2 documents shared" })
    expect(within(group).getAllByRole("article")).toHaveLength(2)
  })

  test("a nested card still opens in page and still shows its size", () => {
    const opened: string[] = []
    render(<ConversationView
      api={api()}
      conversation={conversation}
      messages={[agentMessage({ createdAt: 9_000 })]}
      attachments={[{ ...attach("tok-1", 2_000), sizeBytes: 2048 }]}
      onOpenDocument={token => opened.push(token)}
    />)
    const agentArticle = screen.getByLabelText("Message from architect (Agent)")
    // sizeBytes now arrives from the hub, so the card's size line finally renders.
    expect(within(agentArticle).getByText(/2\.0 KB/)).toBeTruthy()
    within(agentArticle).getByRole("button", { name: /tok-1\.md/ }).click()
    expect(opened).toEqual(["tok-1"])
  })
})
