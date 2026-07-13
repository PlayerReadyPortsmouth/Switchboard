import "./testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiError } from "./api"
import { App, createWorkspaceStream, type AppApi } from "./App"
import type { ConversationStreamHandlers } from "./conversationStream"
import { DraftStore } from "./drafts"
import type { Conversation, ConversationInput, Message, Session } from "./types"

const screen = within(document.body)

const session: Session = {
  identity: "ada@example.com",
  agents: [
    { name: "architect", alive: true, busy: false },
    { name: "reviewer", alive: true, busy: true },
  ],
}

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: "design/review",
  title: "Design review",
  primaryAgent: "architect",
  createdBy: session.identity,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
  archivedAt: null,
  ...overrides,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

function fakeApi(options: {
  conversations?: Conversation[]
  session?: Session
  sessionResult?: Promise<Session>
  conversationsResult?: Promise<Conversation[]>
} = {}): AppApi & { created: ConversationInput[]; archived: string[] } {
  let conversations = [...(options.conversations ?? [conversation()])]
  const created: ConversationInput[] = []
  const archived: string[] = []
  return {
    created,
    archived,
    session: () => options.sessionResult ?? Promise.resolve(options.session ?? session),
    listConversations: () => options.conversationsResult ?? Promise.resolve(conversations),
    createConversation: async input => {
      created.push(input)
      const result = conversation({ id: "created-id", title: input.title, primaryAgent: input.primaryAgent })
      conversations = [result, ...conversations]
      return result
    },
    archiveConversation: async id => {
      archived.push(id)
      const existing = conversations.find(item => item.id === id) ?? conversation({ id })
      const result = { ...existing, archivedAt: Date.now() }
      conversations = conversations.filter(item => item.id !== id)
      return result
    },
  }
}

afterEach(() => {
  cleanup()
  history.replaceState(null, "", "/")
  setViewport(1280)
})

describe("responsive workspace shell", () => {
  test("loads session and conversations, then opens the selected transcript", async () => {
    render(<App api={fakeApi({ conversations: [conversation()] })} />)

    expect(await screen.findByRole("heading", { name: "Switchboard" })).toBeTruthy()
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))

    expect(await screen.findByRole("region", { name: "Transcript" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Design review" })).toBeTruthy()
    expect(location.pathname).toBe("/conversations/design%2Freview")
  })

  test("keyboard navigation reaches rail, list, transcript and composer in order", async () => {
    render(<App api={fakeApi()} />)
    await screen.findByRole("heading", { name: "Switchboard" })
    const newConversation = screen.getByRole("button", { name: "New conversation" })
    const conversations = screen.getByRole("link", { name: "Conversations" })
    const legacy = screen.getByRole("link", { name: "Legacy console" })
    const search = screen.getByRole("searchbox", { name: "Search conversations" })
    const conversationButton = screen.getByRole("button", { name: /Design review/ })
    const precedes = (left: HTMLElement, right: HTMLElement) => Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(precedes(newConversation, conversations)).toBe(true)
    expect(precedes(conversations, legacy)).toBe(true)
    expect(precedes(legacy, search)).toBe(true)
    expect(precedes(search, conversationButton)).toBe(true)
    newConversation.focus()
    expect(document.activeElement).toBe(newConversation)

    act(() => conversationButton.click())
    const archive = screen.getByRole("button", { name: "Archive conversation" })
    const composer = screen.getByRole("textbox", { name: "Message" })
    expect(precedes(conversationButton, archive)).toBe(true)
    expect(precedes(archive, composer)).toBe(true)
    composer.focus()
    expect(document.activeElement).toBe(composer)
  })

  test("shows a legible loading state", () => {
    const pending = deferred<Session>()
    render(<App api={fakeApi({ sessionResult: pending.promise })} />)

    expect(screen.getByRole("status").textContent).toContain("Loading your workspace")
  })

  test("empty state directs the user to create a conversation", async () => {
    render(<App api={fakeApi({ conversations: [] })} />)

    expect(await screen.findByText("No conversations yet")).toBeTruthy()
    expect(screen.getByText("Create a conversation to start working with an agent.")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "New conversation" }).length).toBeGreaterThan(0)
  })

  test("forbidden state explains how to regain access", async () => {
    render(<App api={fakeApi({ sessionResult: Promise.reject(new ApiError(403, "forbidden")) })} />)

    expect((await screen.findByRole("alert")).textContent).toContain("Workspace access denied")
    expect(screen.getByRole("alert").textContent).toContain("Ask a Switchboard administrator to grant your identity access.")
  })

  test("unavailable state offers a retry", async () => {
    let attempts = 0
    const api = fakeApi()
    api.session = async () => {
      attempts++
      if (attempts === 1) throw new ApiError(503, "unavailable")
      return session
    }
    render(<App api={api} />)

    expect((await screen.findByRole("alert")).textContent).toContain("Switchboard is unavailable")
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByRole("heading", { name: "Switchboard" })).toBeTruthy()
    expect(attempts).toBe(2)
  })

  test("filters conversations locally by title", async () => {
    render(<App api={fakeApi({ conversations: [conversation(), conversation({ id: "release", title: "Release notes" })] })} />)
    const search = await screen.findByRole("searchbox", { name: "Search conversations" })

    await userEvent.type(search, "release")

    expect(screen.getByRole("button", { name: /Release notes/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Design review/ })).toBeNull()
  })

  test("creates a conversation with a title and primary agent", async () => {
    const api = fakeApi({ conversations: [] })
    render(<App api={api} />)
    await screen.findByText("No conversations yet")

    await userEvent.click(screen.getAllByRole("button", { name: "New conversation" })[0])
    const dialog = screen.getByRole("dialog", { name: "New conversation" })
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), "Incident follow-up")
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Primary agent" }), "reviewer")
    await userEvent.click(within(dialog).getByRole("button", { name: "Create conversation" }))

    expect(api.created).toEqual([{ title: "Incident follow-up", primaryAgent: "reviewer" }])
    expect(await screen.findByRole("heading", { name: "Incident follow-up" })).toBeTruthy()
    expect(location.pathname).toBe("/conversations/created-id")
  })

  test("archives only after confirmation and returns to the conversation list", async () => {
    const api = fakeApi()
    render(<App api={api} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))

    await userEvent.click(screen.getByRole("button", { name: "Archive conversation" }))
    const dialog = screen.getByRole("dialog", { name: "Archive conversation" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }))

    expect(api.archived).toEqual(["design/review"])
    await waitFor(() => expect(location.pathname).toBe("/"))
    expect(await screen.findByText("No conversations yet")).toBeTruthy()
  })

  test("reads a conversation route and follows popstate without a router", async () => {
    const first = conversation()
    const second = conversation({ id: "ops 1", title: "Operations" })
    history.replaceState(null, "", "/conversations/ops%201")
    render(<App api={fakeApi({ conversations: [first, second] })} />)

    expect(await screen.findByRole("heading", { name: "Operations" })).toBeTruthy()
    act(() => {
      history.pushState(null, "", "/conversations/design%2Freview")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })

    expect(await screen.findByRole("heading", { name: "Design review" })).toBeTruthy()
  })

  test("exposes the required semantic shell regions", async () => {
    render(<App api={fakeApi()} />)
    await screen.findByRole("heading", { name: "Switchboard" })

    expect(screen.getByRole("navigation", { name: "Application navigation" })).toBeTruthy()
    expect(screen.getByRole("navigation", { name: "Conversation navigation" })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy()
    expect(screen.getByRole("region", { name: "Conversation inspector" })).toBeTruthy()
    expect(document.querySelector('[data-region="application-navigation"]')).not.toBeNull()
    expect(document.querySelector('[data-region="conversation-navigation"]')).not.toBeNull()
    expect(document.querySelector('[data-region="transcript"]')).not.toBeNull()
    expect(document.querySelector('[data-region="conversation-inspector"]')).not.toBeNull()
  })

  test("renders install only when installation is available", async () => {
    const install = () => {}
    const api = fakeApi()
    const { rerender } = render(<App api={api} />)
    await screen.findByRole("heading", { name: "Switchboard" })
    expect(screen.queryByRole("button", { name: "Install Switchboard" })).toBeNull()

    rerender(<App api={api} install={{ run: install }} />)
    expect(screen.getByRole("button", { name: "Install Switchboard" })).toBeTruthy()
  })

  test("creates the production conversation stream from the workspace API", async () => {
    const urls: string[] = []
    const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource")
    class FakeEventSource {
      constructor(url: string) { urls.push(url) }
      addEventListener() {}
      close() {}
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource })
    const api = fakeApi()
    api.listMessages = async () => []

    try {
      const stream = createWorkspaceStream(api)
      await stream.start("design/review", 0, { onMessages() {}, onEvent() {}, onState() {} })
      expect(urls).toEqual(["/api/conversations/design%2Freview/events?after=0"])
      stream.stop()
    } finally {
      if (originalEventSource) Object.defineProperty(globalThis, "EventSource", originalEventSource)
      else Reflect.deleteProperty(globalThis, "EventSource")
    }
  })

  test("keeps the default API stable across state renders", async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")
    const requests: string[] = []
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (request: Request) => {
      requests.push(new URL(request.url).pathname)
      return Response.json(request.url.endsWith("/api/session") ? session : [])
    } })
    try {
      render(<App />)
      await screen.findByRole("heading", { name: "Switchboard" })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(requests).toEqual(["/api/session", "/api/conversations"])
    } finally {
      if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch)
    }
  })

  test("remounts the composer draft when switching conversations", async () => {
    const storage = new Map<string, string>([
      ["switchboard:draft:design/review", JSON.stringify({ text: "Design draft", clientKey: "a", updatedAt: 1 })],
      ["switchboard:draft:ops", JSON.stringify({ text: "Ops draft", clientKey: "b", updatedAt: 2 })],
    ])
    const drafts = new DraftStore({
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: key => { storage.delete(key) },
    })
    render(<App api={fakeApi({ conversations: [conversation(), conversation({ id: "ops", title: "Operations" })] })} drafts={drafts} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Design draft")

    await userEvent.click(screen.getByRole("button", { name: /Operations/ }))
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Ops draft")
  })

  test("opens create as a native modal dialog", async () => {
    const originalShowModal = HTMLDialogElement.prototype.showModal
    let calls = 0
    HTMLDialogElement.prototype.showModal = function () { calls++; return originalShowModal.call(this) }
    try {
      render(<App api={fakeApi()} />)
      await userEvent.click(await screen.findByRole("button", { name: "New conversation" }))
      expect(await screen.findByRole("dialog", { name: "New conversation" })).toBeTruthy()
      expect(calls).toBe(1)
    } finally {
      HTMLDialogElement.prototype.showModal = originalShowModal
    }
  })

  test("disables the conversation drawer close action when no workspace is open", async () => {
    render(<App api={fakeApi({ conversations: [] })} />)
    await screen.findByText("No conversations yet")
    expect((screen.getByRole("button", { name: "Close conversations" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("clears an action error before opening a different dialog", async () => {
    const api = fakeApi()
    api.archiveConversation = async () => { throw new ApiError(503, "unavailable") }
    render(<App api={api} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    await userEvent.click(screen.getByRole("button", { name: "Archive conversation" }))
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }))
    expect((await screen.findByRole("alert")).textContent).toContain("could not be archived")
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }))
    await userEvent.click(screen.getByRole("button", { name: "New conversation" }))
    expect(screen.queryByText(/could not be archived/)).toBeNull()
  })

  test("reduces committed stream messages into canonical transcript state", async () => {
    let handlers: ConversationStreamHandlers | undefined
    const api = fakeApi()
    api.listMessages = async () => []
    const stream = {
      start: async (_id: string, _after: number, next: ConversationStreamHandlers) => { handlers = next },
      stop() {},
    }
    render(<App api={api} streamFactory={() => stream as ReturnType<typeof createWorkspaceStream>} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    await waitFor(() => expect(handlers).toBeDefined())
    const message: Message = {
      id: "m1", conversationId: "design/review", sequence: 1, author: "architect", origin: "agent",
      content: "Ready", replyTo: null, state: "committed", clientKey: null, createdAt: 1,
    }

    act(() => handlers!.onEvent({ kind: "message_committed", conversationId: "design/review", sequence: 1, ts: 1, message }))

    expect(screen.getByRole("region", { name: "Transcript" }).dataset.messageCount).toBe("1")
    act(() => handlers!.onEvent({ kind: "turn_state", conversationId: "design/review", sequence: 1, ts: 2, state: "working" }))
    expect(document.querySelector("[data-workspace-announcer]")?.textContent).toBe("Live. Turn working.")
    act(() => handlers!.onState("offline"))
    expect(document.querySelector("[data-workspace-announcer]")?.textContent).toBe("Offline. Turn working.")
  })

  test("restores focus to the archive trigger when its modal is cancelled", async () => {
    render(<App api={fakeApi()} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    const trigger = screen.getByRole("button", { name: "Archive conversation" })
    await userEvent.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "Archive conversation" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  test("uses one global connection and turn announcer outside the responsive rail", async () => {
    setViewport(500)
    render(<App api={fakeApi()} />)
    await screen.findByRole("heading", { name: "Switchboard" })

    const announcers = document.querySelectorAll('[aria-live="polite"]')
    expect(announcers.length).toBe(1)
    expect(announcers[0]?.getAttribute("data-workspace-announcer")).not.toBeNull()
    expect(announcers[0]?.textContent).toBe("Live.")
    expect(document.querySelector(".app-rail [aria-live]")).toBeNull()
  })

  test("keeps tablet header actions at least 44px high", async () => {
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text()
    expect(css).toMatch(/@media \(max-width: 1199px\)[\s\S]*?\.header-actions button\s*\{[^}]*min-height:\s*44px/)
  })

  test("moves focus into the tablet inspector and restores it on Escape", async () => {
    setViewport(900)
    render(<App api={fakeApi()} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    const trigger = screen.getByRole("button", { name: "Conversation details" })

    await userEvent.click(trigger)
    const close = screen.getByRole("button", { name: "Close conversation details" })
    await waitFor(() => expect(document.activeElement).toBe(close))
    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  test("moves focus through mobile pane switches and restores it when drawers close", async () => {
    setViewport(500)
    render(<App api={fakeApi()} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    const composer = screen.getByRole("textbox", { name: "Message" })
    await waitFor(() => expect(document.activeElement).toBe(composer))
    const mobile = screen.getByRole("navigation", { name: "Mobile workspace navigation" })
    const details = within(mobile).getByRole("button", { name: "Details" })

    await userEvent.click(details)
    const inspectorClose = screen.getByRole("button", { name: "Close conversation details" })
    await waitFor(() => expect(document.activeElement).toBe(inspectorClose))
    await userEvent.click(inspectorClose)
    await waitFor(() => expect(document.activeElement).toBe(details))

    const conversations = within(mobile).getByRole("button", { name: "Conversations" })
    await userEvent.click(conversations)
    const search = screen.getByRole("searchbox", { name: "Search conversations" })
    await waitFor(() => expect(document.activeElement).toBe(search))
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(document.activeElement).toBe(conversations))
  })

  test("submits archive once while the canonical request is pending", async () => {
    const pending = deferred<Conversation>()
    const api = fakeApi()
    let attempts = 0
    api.archiveConversation = id => { attempts++; return pending.promise }
    render(<App api={api} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    const trigger = screen.getByRole("button", { name: "Archive conversation" })
    await userEvent.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "Archive conversation" })
    const archive = within(dialog).getByRole("button", { name: "Archive" }) as HTMLButtonElement

    fireEvent.click(archive)
    expect(archive.disabled).toBe(true)
    fireEvent.submit(dialog.querySelector("form")!)
    expect(attempts).toBe(1)

    await act(async () => {
      pending.resolve(conversation({ archivedAt: Date.now() }))
      await pending.promise
    })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Archive conversation" })).toBeNull())
    expect(location.pathname).toBe("/")
  })
})
