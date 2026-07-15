import "./testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode, useLayoutEffect, useState } from "react"
import { ApiError } from "./api"
import { App, ConversationWorkspace, createWorkspaceStream, type AppApi } from "./App"
import { ApprovalStream, type ApprovalStreamHandlers } from "./approvalStream"
import type { ConversationStreamHandlers } from "./conversationStream"
import { DraftStore } from "./drafts"
import type { AgentDetail, AgentSummary, ApprovalDetail, ApprovalListPage, ApprovalListQuery, ApprovalOperationsEvent, ApprovalPendingAggregate, ApprovalSummary, Conversation, ConversationInput, Message, Session } from "./types"

const screen = within(document.body)

const session: Session = {
  identity: "ada@example.com",
  features: { agents: true, approvals: false },
  permissions: { agents: "operator", approvals: "hidden" },
  approvalState: { producing: false, canDecide: false, pendingCount: 0 },
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

const approvalSummary = (): ApprovalSummary => ({
  id: "approval-1", version: "v1", kind: "outbound_http", target: "https://example.test/deploy",
  summary: "Deploy release", risk: "elevated", requestedBy: { surface: "agent", id: "architect" },
  createdAt: 1_700_000_000_000, expiresAt: 1_700_000_300_000, terminalAt: null,
  state: "pending", execution: "not_applicable", conversationId: "design/review",
})

const approvalDetail = (): ApprovalDetail => ({
  ...approvalSummary(), detail: { method: "POST" }, executionDetail: null, decisionBy: null,
  decisionAt: null, outcomeReason: null, audit: [], permissions: { canDecide: false },
})

function visibleApprovalSession(overrides: Partial<Session> = {}): Session {
  return {
    ...session,
    features: { ...session.features, approvals: true },
    permissions: { ...session.permissions, approvals: "viewer" },
    approvalState: { producing: true, canDecide: false, pendingCount: 1 },
    ...overrides,
  }
}

type ApprovalTestApi = ReturnType<typeof fakeApi> & {
  listApprovals: NonNullable<AppApi["listApprovals"]>
  getApproval: NonNullable<AppApi["getApproval"]>
  decideApproval: NonNullable<AppApi["decideApproval"]>
}

function approvalApi(approvalSession: Session = visibleApprovalSession()): ApprovalTestApi {
  return Object.assign(fakeApi({ session: approvalSession }), {
    listApprovals: async (_query: ApprovalListQuery): Promise<ApprovalListPage> => ({ items: [approvalSummary()], nextCursor: null, pendingCount: approvalSession.approvalState.pendingCount, querySummary: null }),
    getApproval: async () => approvalDetail(),
    decideApproval: async () => ({ approval: approvalDetail() }),
  })
}

function countedApprovalStreams() {
  let handlers: ApprovalStreamHandlers | null = null
  let starts = 0
  let stops = 0
  const stream = {
    async start(_afterSequence: number, next: ApprovalStreamHandlers) {
      starts++
      handlers = next
      next.onState("live")
    },
    stop() {
      stops++
      handlers = null
    },
  }
  return {
    get starts() { return starts },
    get stops() { return stops },
    factory: () => stream as unknown as ApprovalStream,
    event(event: ApprovalOperationsEvent) { handlers?.onEvent(event) },
    invalidate() { handlers?.onInvalidate() },
  }
}

type NavigationStep = "approval-detail" | "agents" | "conversation" | "approval-list"
async function navigateThrough(...steps: NavigationStep[]) {
  for (const step of steps) {
    if (step === "approval-detail") {
      await userEvent.click(await screen.findByRole("link", { name: /Approvals/ }))
      await screen.findByRole("heading", { name: "Approvals" })
      await userEvent.click(await screen.findByRole("button", { name: "Open approval Deploy release" }))
      await screen.findByRole("heading", { name: "Deploy release" })
    } else if (step === "agents") {
      await userEvent.click(await screen.findByRole("link", { name: "Agents" }))
      await screen.findByRole("heading", { name: "Agents" })
    } else if (step === "conversation") {
      await userEvent.click(await screen.findByRole("link", { name: "Conversations" }))
      await screen.findByRole("heading", { name: "Switchboard" })
    } else {
      await userEvent.click(await screen.findByRole("link", { name: /Approvals/ }))
      await screen.findByRole("heading", { name: "Approvals" })
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const approvalAggregate = (overrides: Partial<ApprovalPendingAggregate> = {}): ApprovalPendingAggregate => ({
  count: 1,
  highestRisk: "elevated",
  nearestExpiry: 1_700_000_300_000,
  firstId: "approval-1",
  ...overrides,
})

const approvalPage = (querySummary: ApprovalPendingAggregate | null, items = [approvalSummary()]): ApprovalListPage => ({
  items,
  nextCursor: null,
  pendingCount: 91,
  querySummary,
})

async function browserBack() {
  await act(async () => {
    history.back()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
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
    listAgents: async (): Promise<AgentSummary[]> => [],
    getAgent: async (): Promise<AgentDetail> => { throw new ApiError(404, "not_found") },
  }
}

afterEach(() => {
  cleanup()
  history.replaceState(null, "", "/")
  setViewport(1280)
})

describe("responsive workspace shell", () => {
  test("shows the Agents destination, routes to it, and responds to popstate", async () => {
    render(<App api={fakeApi()} streamFactory={null} agentStreamFactory={null} />)
    const agents = await screen.findByRole("link", { name: "Agents" })
    await userEvent.click(agents)
    expect(location.pathname).toBe("/agents")
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy()
    history.pushState(null, "", "/")
    act(() => window.dispatchEvent(new PopStateEvent("popstate")))
    expect(await screen.findByRole("heading", { name: "Switchboard" })).toBeTruthy()
  })

  test("hides Agents and rejects direct access when the feature is disabled", async () => {
    const disabled = {
      ...session,
      features: { ...session.features, agents: false },
      permissions: { ...session.permissions, agents: "hidden" as const },
    }
    const view = render(<App api={fakeApi({ session: disabled })} />)
    await screen.findByRole("heading", { name: "Switchboard" })
    expect(screen.queryByRole("link", { name: "Agents" })).toBeNull()
    view.unmount()
    history.replaceState(null, "", "/agents")
    render(<App api={fakeApi({ session: disabled })} />)
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy()
  })

  test("shows an accessible Approvals badge and renders the authorized viewer destination", async () => {
    const visible: Session = {
      ...session,
      features: { ...session.features, approvals: true },
      permissions: { ...session.permissions, approvals: "viewer" },
      approvalState: { producing: true, canDecide: false, pendingCount: 3 },
    }
    render(<App api={approvalApi(visible)} streamFactory={null} agentStreamFactory={null} />)
    const approvals = await screen.findByRole("link", { name: "Approvals, 3 pending" })
    expect(approvals.querySelector(".rail-count")?.textContent).toBe("3")
    await userEvent.click(approvals)
    expect(location.pathname).toBe("/approvals")
    expect(await screen.findByRole("heading", { name: "Approvals" })).toBeTruthy()
  })

  test("offers top-level destinations alongside conversation panes on mobile", async () => {
    setViewport(500)
    const visible: Session = {
      ...session,
      features: { agents: true, approvals: true },
      permissions: { agents: "operator", approvals: "viewer" },
      approvalState: { producing: true, canDecide: false, pendingCount: 3 },
    }
    render(<App api={approvalApi(visible)} streamFactory={null} agentStreamFactory={null} />)
    await screen.findByRole("heading", { name: "Switchboard" })

    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toBeTruthy()
    const destinations = screen.getByRole("navigation", { name: "Destinations" })
    const approvals = within(destinations).getByRole("button", { name: "Approvals, 3 pending" })
    await userEvent.click(approvals)

    expect(location.pathname).toBe("/approvals")
    expect(await screen.findByRole("heading", { name: "Approvals" })).toBeTruthy()
    const css = await Bun.file(new URL("./styles.css", import.meta.url)).text()
    expect(css).toMatch(/\.workspace-shell \.mobile-nav\s*\{[^}]*bottom:\s*calc\(64px \+ env\(safe-area-inset-bottom\)\)/)
  })

  test("omits hidden Approvals navigation and rejects direct list and detail routes", async () => {
    const hidden: Session = {
      ...session,
      features: { ...session.features, approvals: true },
      permissions: { ...session.permissions, approvals: "hidden" },
    }
    const view = render(<App api={approvalApi(hidden)} streamFactory={null} agentStreamFactory={null} />)
    await screen.findByRole("heading", { name: "Switchboard" })
    expect(screen.queryByRole("link", { name: /Approvals/ })).toBeNull()
    view.unmount()

    for (const path of ["/approvals", "/approvals/approval-1"]) {
      history.replaceState(null, "", path)
      const direct = render(<App api={approvalApi(hidden)} streamFactory={null} agentStreamFactory={null} />)
      expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy()
      direct.unmount()
    }
  })

  test("one approval stream survives internal destination navigation", async () => {
    const streams = countedApprovalStreams()
    render(<App api={approvalApi()} approvalStreamFactory={streams.factory} agentStreamFactory={null} />)
    await screen.findByRole("link", { name: /Approvals/ })
    await waitFor(() => expect(streams.starts).toBe(1))

    await navigateThrough("approval-detail", "agents", "conversation", "approval-list")

    expect(streams.starts).toBe(1)
    expect(streams.stops).toBe(0)
    cleanup()
    expect(streams.stops).toBe(1)
  })

  test("approval changes update the global count, announce it, and invalidate the canonical queue", async () => {
    const streams = countedApprovalStreams()
    const api = approvalApi()
    let listCalls = 0
    api.listApprovals = async () => {
      listCalls++
      return { items: [approvalSummary()], nextCursor: null, pendingCount: 1, querySummary: null }
    }
    render(<App api={api} approvalStreamFactory={streams.factory} agentStreamFactory={null} />)
    await userEvent.click(await screen.findByRole("link", { name: /Approvals/ }))
    await screen.findByRole("heading", { name: "Approvals" })
    await waitFor(() => expect(listCalls).toBeGreaterThan(0))
    const before = listCalls

    act(() => streams.event({
      kind: "approval_changed",
      approvalId: "approval-1",
      pendingCount: 3,
      sequence: 1,
      ts: 1_700_000_000_000,
    }))

    expect(await screen.findByRole("link", { name: "Approvals, 3 pending" })).toBeTruthy()
    await waitFor(() => expect(listCalls).toBeGreaterThan(before))
    expect(document.querySelector("[data-approval-announcer]")?.textContent).toBe("3 approvals pending")

    await userEvent.click(screen.getByRole("link", { name: "Agents" }))
    expect(await screen.findByRole("link", { name: "Approvals, 3 pending" })).toBeTruthy()
    await userEvent.click(screen.getByRole("link", { name: "Conversations" }))
    await screen.findByRole("heading", { name: "Switchboard" })
    expect(await screen.findByRole("link", { name: "Approvals, 3 pending" })).toBeTruthy()
  })

  test("snapshot invalidation reloads session, queue, and canonical detail", async () => {
    history.replaceState(null, "", "/approvals/approval-1")
    const streams = countedApprovalStreams()
    const initial = visibleApprovalSession()
    const refreshed = visibleApprovalSession({ approvalState: { producing: true, canDecide: false, pendingCount: 5 } })
    const api = approvalApi(initial)
    let sessionCalls = 0
    let listCalls = 0
    let detailCalls = 0
    api.session = async () => ++sessionCalls === 1 ? initial : refreshed
    api.listApprovals = async () => {
      listCalls++
      return { items: [approvalSummary()], nextCursor: null, pendingCount: 1, querySummary: null }
    }
    api.getApproval = async () => { detailCalls++; return approvalDetail() }
    render(<App api={api} approvalStreamFactory={streams.factory} agentStreamFactory={null} />)
    await screen.findByRole("heading", { name: "Deploy release" })
    const beforeList = listCalls
    const beforeDetail = detailCalls

    act(() => streams.invalidate())

    await waitFor(() => expect(sessionCalls).toBe(2))
    await waitFor(() => expect(listCalls).toBeGreaterThan(beforeList))
    await waitFor(() => expect(detailCalls).toBeGreaterThan(beforeDetail))
    expect(await screen.findByRole("link", { name: "Approvals, 5 pending" })).toBeTruthy()
  })

  test("a newer approval event wins over a stale snapshot session while both revisions refresh conversation context", async () => {
    const streams = countedApprovalStreams()
    const initial = visibleApprovalSession()
    const staleSnapshot = visibleApprovalSession({ approvalState: { producing: true, canDecide: false, pendingCount: 4 } })
    const refresh = deferred<Session>()
    const api = approvalApi(initial)
    let sessionCalls = 0
    const contextQueries: ApprovalListQuery[] = []
    api.session = () => ++sessionCalls === 1 ? Promise.resolve(initial) : refresh.promise
    api.listApprovals = async query => {
      contextQueries.push(query)
      return approvalPage(approvalAggregate({ count: contextQueries.length + 1 }))
    }
    render(<App api={api} approvalStreamFactory={streams.factory} agentStreamFactory={null} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    expect(await screen.findByText("2 approvals pending")).toBeTruthy()

    act(() => streams.invalidate())
    await waitFor(() => expect(sessionCalls).toBe(2))
    act(() => streams.event({
      kind: "approval_changed",
      approvalId: "approval-2",
      pendingCount: 7,
      sequence: 2,
      ts: 1_700_000_001_000,
    }))
    await waitFor(() => expect(contextQueries.length).toBeGreaterThanOrEqual(3))
    await act(async () => refresh.resolve(staleSnapshot))

    expect(await screen.findByRole("link", { name: "Approvals, 7 pending" })).toBeTruthy()
    expect(contextQueries.every(query => JSON.stringify(query) === JSON.stringify({ group: "pending", conversationId: "design/review", limit: 1 }))).toBe(true)
  })

  test("a session refresh that hides approvals stops the application stream", async () => {
    const streams = countedApprovalStreams()
    const visible = visibleApprovalSession()
    const hidden = {
      ...visible,
      features: { ...visible.features, approvals: false },
      permissions: { ...visible.permissions, approvals: "hidden" as const },
    }
    const api = approvalApi(visible)
    let calls = 0
    api.session = async () => ++calls === 1 ? visible : hidden
    render(<App api={api} approvalStreamFactory={streams.factory} agentStreamFactory={null} />)
    await screen.findByRole("link", { name: /Approvals/ })
    await waitFor(() => expect(streams.starts).toBe(1))

    act(() => streams.invalidate())

    await waitFor(() => expect(streams.stops).toBe(1))
    expect(screen.queryByRole("link", { name: /Approvals/ })).toBeNull()
  })

  test("queries the selected conversation exactly and projects only querySummary", async () => {
    const visible = visibleApprovalSession({ approvalState: { producing: true, canDecide: false, pendingCount: 91 } })
    const api = approvalApi(visible)
    const queries: ApprovalListQuery[] = []
    api.listApprovals = async query => {
      queries.push(query)
      return approvalPage(approvalAggregate({
        count: 137,
        highestRisk: "destructive",
        nearestExpiry: 1_700_000_060_000,
        firstId: "server-first",
      }), [approvalSummary()])
    }
    render(<App api={api} streamFactory={null} agentStreamFactory={null} approvalStreamFactory={null} />)

    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))

    expect(await screen.findByText("137 approvals pending")).toBeTruthy()
    expect(screen.getByText("Destructive risk")).toBeTruthy()
    expect(queries).toEqual([{ group: "pending", conversationId: "design/review", limit: 1 }])
    expect(document.body.textContent).not.toContain("91 approvals pending")
  })

  test("a late prior-conversation aggregate cannot replace the selected conversation banner", async () => {
    const first = deferred<ApprovalListPage>()
    const second = deferred<ApprovalListPage>()
    const api = approvalApi()
    api.listConversations = async () => [conversation(), conversation({ id: "ops", title: "Operations" })]
    api.listApprovals = query => query.conversationId === "design/review" ? first.promise : second.promise
    render(<App api={api} streamFactory={null} agentStreamFactory={null} approvalStreamFactory={null} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    await userEvent.click(screen.getByRole("button", { name: /Operations/ }))

    await act(async () => second.resolve(approvalPage(approvalAggregate({ count: 2, firstId: "ops-first" }))))
    expect(await screen.findByText("2 approvals pending")).toBeTruthy()
    await act(async () => first.resolve(approvalPage(approvalAggregate({ firstId: "stale-secret-id" }))))

    expect(screen.getByText("2 approvals pending")).toBeTruthy()
    expect(document.body.textContent).not.toContain("stale-secret-id")
    expect((screen.getByRole("link", { name: "Review 2 pending approvals" }) as HTMLAnchorElement).href).toContain("conversationId=ops")
  })

  for (const [label, result] of [
    ["forbidden", () => Promise.reject(new ApiError(403, "forbidden"))],
    ["not found", () => Promise.reject(new ApiError(404, "not_found"))],
    ["offline", () => Promise.reject(new ApiError(0, "request_failed"))],
    ["zero aggregate", () => Promise.resolve(approvalPage(approvalAggregate({ count: 0, highestRisk: null, nearestExpiry: null, firstId: null })))],
    ["missing aggregate", () => Promise.resolve(approvalPage(null))],
  ] as const) {
    test(`${label} conversation approval data renders no banner or leaked ID`, async () => {
      const api = approvalApi()
      let queries = 0
      api.listApprovals = async () => { queries++; return result() }
      render(<App api={api} streamFactory={null} agentStreamFactory={null} approvalStreamFactory={null} />)

      await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
      await waitFor(() => expect(queries).toBe(1))

      expect(screen.queryByRole("complementary", { name: "Pending approval context" })).toBeNull()
      expect(document.body.textContent).not.toContain("approval-1")
    })
  }

  test("permission revocation removes approval context in the revocation commit", async () => {
    const visible = visibleApprovalSession()
    const hidden: Session = {
      ...visible,
      permissions: { ...visible.permissions, approvals: "hidden" },
    }
    const api = approvalApi(visible)
    api.listApprovals = async () => approvalPage(approvalAggregate())
    let revoke!: () => void
    const revocationCommitBanners: boolean[] = []

    function RevocationHarness() {
      const [current, setCurrent] = useState(visible)
      revoke = () => setCurrent(hidden)
      useLayoutEffect(() => {
        if (current.permissions.approvals === "hidden") {
          revocationCommitBanners.push(document.querySelector(".approval-context-banner") !== null)
        }
      }, [current])
      return <ConversationWorkspace api={api} session={current} streamFactory={null} />
    }

    render(<RevocationHarness />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    expect(await screen.findByRole("complementary", { name: "Pending approval context" })).toBeTruthy()

    act(() => revoke())

    expect(revocationCommitBanners).toEqual([false])
    expect(screen.queryByRole("complementary", { name: "Pending approval context" })).toBeNull()
  })

  test("browser Back restores a direct-banner conversation and focuses its link", async () => {
    const api = approvalApi()
    api.listApprovals = async query => query.limit === 1
      ? approvalPage(approvalAggregate())
      : approvalPage(null)
    render(<App api={api} streamFactory={null} agentStreamFactory={null} approvalStreamFactory={null} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    await userEvent.click(await screen.findByRole("link", { name: "Review approval" }))

    expect(location.pathname).toBe("/approvals/approval-1")
    expect(history.state?.approvalReturn).toEqual({ conversationId: "design/review", focus: "approval-detail" })
    await screen.findByRole("heading", { name: "Deploy release" })
    await browserBack()

    await waitFor(() => expect(location.pathname).toBe("/conversations/design%2Freview"))
    const restored = await screen.findByRole("link", { name: "Review approval" })
    await waitFor(() => expect(document.activeElement).toBe(restored))
  })

  test("browser Back restores focus to a multiple-request queue trigger", async () => {
    const api = approvalApi()
    api.listApprovals = async query => query.limit === 1
      ? approvalPage(approvalAggregate({ count: 3 }))
      : approvalPage(null)
    render(<App api={api} streamFactory={null} agentStreamFactory={null} approvalStreamFactory={null} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    await userEvent.click(await screen.findByRole("link", { name: "Review 3 pending approvals" }))

    expect(`${location.pathname}${location.search}`).toBe("/approvals?group=pending&conversationId=design%2Freview")
    expect(history.state?.approvalReturn).toEqual({ conversationId: "design/review", focus: "approval-queue" })
    await screen.findByRole("heading", { name: "Approvals" })
    await browserBack()

    const restored = await screen.findByRole("link", { name: "Review 3 pending approvals" })
    await waitFor(() => expect(document.activeElement).toBe(restored))
  })

  test("browser Back focuses the transcript heading when the banner resolved away", async () => {
    let context: ApprovalPendingAggregate | null = approvalAggregate()
    const api = approvalApi()
    api.listApprovals = async query => query.limit === 1 ? approvalPage(context) : approvalPage(null)
    render(<App api={api} streamFactory={null} agentStreamFactory={null} approvalStreamFactory={null} />)
    await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
    await userEvent.click(await screen.findByRole("link", { name: "Review approval" }))
    await screen.findByRole("heading", { name: "Deploy release" })
    context = null
    await browserBack()

    const heading = await screen.findByRole("heading", { name: "Design review" })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.queryByRole("complementary", { name: "Pending approval context" })).toBeNull()
  })

  test("uses live PWA install availability and issue feedback on the Agents route", async () => {
    history.replaceState(null, "", "/agents")
    let listener: ((state: { installAvailable: boolean; online: boolean; issue: { source: "install"; message: string } | null }) => void) | undefined
    let installs = 0
    const pwa = {
      state: () => ({ installAvailable: false, online: true, issue: null }),
      subscribe: (next: typeof listener) => { listener = next; next?.(pwa.state()); return () => { listener = undefined } },
      install: async () => { installs++ },
    }
    render(<App api={fakeApi()} pwa={pwa} streamFactory={null} agentStreamFactory={null} />)
    await screen.findByRole("heading", { name: "Agents" })
    expect(screen.queryByRole("button", { name: "Install Switchboard" })).toBeNull()

    act(() => listener?.({ installAvailable: true, online: true, issue: { source: "install", message: "Install prompt unavailable." } }))
    await userEvent.click(await screen.findByRole("button", { name: "Install Switchboard" }))
    expect(installs).toBe(1)
    expect(screen.getByRole("status").textContent).toContain("Install prompt unavailable.")
  })

  test("keeps the default agent stream alive across internal agent routes", async () => {
    history.replaceState(null, "", "/agents")
    const originalEventSource = globalThis.EventSource
    let opens = 0
    let closes = 0
    class CountingEventSource {
      constructor() { opens++ }
      addEventListener() {}
      close() { closes++ }
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: CountingEventSource })
    const api = fakeApi()
    api.listAgents = async () => [{
      name: "qa", emoji: "🧪", description: "Release verification", mode: "persistent", status: "idle", queueDepth: 0,
      contextFill: .1, costUsd: 0, replicas: 1, lastActivityMs: 1, currentTool: null, lastTool: null, currentWork: null,
      model: "gpt-5", version: "v1", permissions: { configure: false, reset: false, restart: false, remove: false },
    }]
    api.getAgent = async () => ({ ...(await api.listAgents!())[0], config: { emoji: "🧪", description: "Release verification", mode: "persistent", access: { roles: [] }, runtime: { cwd: "/qa" } } })
    try {
      render(<App api={api} streamFactory={null} />)
      await userEvent.click(await screen.findByRole("button", { name: "Open qa" }))
      await screen.findByRole("heading", { name: "qa" })
      expect(opens).toBe(1)
      expect(closes).toBe(0)
      await userEvent.click(screen.getByRole("button", { name: "Back to agents" }))
      expect(opens).toBe(1)
      expect(closes).toBe(0)
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: originalEventSource })
    }
  })

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

  test("offline deep routes recover a device draft without API data", async () => {
    history.replaceState(null, "", "/conversations/design%2Freview")
    const storage = new Map([["switchboard:draft:design/review", JSON.stringify({ text: "offline draft", clientKey: "draft-key", updatedAt: 1 })]])
    const drafts = new DraftStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } })
    const pwa = { state: () => ({ installAvailable: false, online: false, issue: null }), subscribe: (listener: any) => { listener(pwa.state()); return () => {} }, install: async () => {} }
    render(<App api={fakeApi({ sessionResult: Promise.reject(new ApiError(503, "offline")) })} drafts={drafts} pwa={pwa} />)
    expect((await screen.findByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("offline draft")
  })

  test("coming online replaces offline deep-route placeholders with canonical metadata and preserves the draft", async () => {
    history.replaceState(null, "", "/conversations/design%2Freview")
    const storage = new Map([["switchboard:draft:design/review", JSON.stringify({ text: "offline draft", clientKey: "draft-key", updatedAt: 1 })]])
    const drafts = new DraftStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) } })
    let online = false; let notify: ((state: { installAvailable: boolean; online: boolean; issue: null }) => void) | undefined; let sessionCalls = 0
    const pwa = {
      state: () => ({ installAvailable: false, online, issue: null }),
      subscribe: (listener: typeof notify) => { notify = listener; listener?.(pwa.state()); return () => { notify = undefined } },
      install: async () => {},
    }
    const api = fakeApi({ conversations: [conversation()] })
    api.session = async () => { if (sessionCalls++ === 0) throw new ApiError(503, "offline"); return session }
    render(<App api={api} drafts={drafts} pwa={pwa} />)
    const composer = await screen.findByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
    expect(composer.value).toBe("offline draft")
    expect(screen.getByRole("heading", { name: "design/review" })).toBeTruthy()

    await act(async () => { online = true; notify?.(pwa.state()); await Promise.resolve() })

    expect(await screen.findByRole("heading", { name: "Design review" })).toBeTruthy()
    expect((screen.getByRole("combobox", { name: "Primary agent" }) as HTMLSelectElement).value).toBe("architect")
    expect(screen.getAllByText("ada@example.com")).toHaveLength(2)
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("offline draft")
    expect(sessionCalls).toBe(2)
  })

  test("an older failed load cannot overwrite a newer successful API load", async () => {
    const oldSession = deferred<Session>()
    const oldConversations = deferred<Conversation[]>()
    const oldApi = fakeApi({ sessionResult: oldSession.promise, conversationsResult: oldConversations.promise })
    const fresh = conversation({ id: "fresh", title: "Fresh workspace" })
    const { rerender } = render(<App api={oldApi} />)
    rerender(<App api={fakeApi({ conversations: [fresh] })} />)
    expect(await screen.findByRole("button", { name: /Fresh workspace/ })).toBeTruthy()
    await act(async () => { oldSession.reject(new ApiError(503, "old")); oldConversations.resolve([]); await Promise.resolve() })
    expect(screen.queryByText("Switchboard is unavailable")).toBeNull()
    expect(screen.getByRole("button", { name: /Fresh workspace/ })).toBeTruthy()
  })

  test("an older successful load cannot overwrite a newer failed API load", async () => {
    const oldSession = deferred<Session>()
    const oldConversations = deferred<Conversation[]>()
    const { rerender } = render(<App api={fakeApi({ sessionResult: oldSession.promise, conversationsResult: oldConversations.promise })} />)
    rerender(<App api={fakeApi({ sessionResult: Promise.reject(new ApiError(503, "new")) })} />)
    expect((await screen.findByRole("alert")).textContent).toContain("Switchboard is unavailable")
    await act(async () => { oldSession.resolve(session); oldConversations.resolve([conversation({ title: "Stale" })]); await Promise.resolve() })
    expect(screen.getByRole("alert").textContent).toContain("Switchboard is unavailable")
  })

  test("unmount invalidates a pending workspace load", async () => {
    const pending = deferred<Session>()
    const { unmount } = render(<App api={fakeApi({ sessionResult: pending.promise })} />)
    unmount()
    await act(async () => { pending.resolve(session); await Promise.resolve() })
    expect(document.body.textContent).toBe("")
  })

  test("StrictMode effect replay leaves only the current workspace load active", async () => {
    const pending = deferred<Session>()
    let calls = 0
    const api = fakeApi()
    api.session = () => { calls++; return pending.promise }
    render(<StrictMode><App api={api} /></StrictMode>)
    expect(calls).toBe(2)
    await act(async () => { pending.resolve(session); await pending.promise })
    expect(await screen.findByRole("heading", { name: "Switchboard" })).toBeTruthy()
  })

  test("a stale retry failure cannot replace a later retry success", async () => {
    const stale = deferred<Session>()
    const api = fakeApi()
    let calls = 0
    api.session = () => ++calls === 1 ? Promise.reject(new ApiError(503, "initial")) : stale.promise
    const { rerender } = render(<App api={api} />)
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    rerender(<App api={fakeApi()} />)
    expect(await screen.findByRole("heading", { name: "Switchboard" })).toBeTruthy()
    await act(async () => { stale.reject(new ApiError(503, "stale")); await Promise.resolve() })
    expect(screen.queryByText("Switchboard is unavailable")).toBeNull()
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
    const mobile = screen.getByRole("navigation", { name: "Mobile navigation" })
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

  for (const [layout, width] of [["desktop", 1280], ["tablet", 900], ["mobile", 500]] as const) {
    test(`focuses the visible composer after successful create on ${layout}`, async () => {
      setViewport(width)
      const api = fakeApi({ conversations: [] })
      render(<App api={api} />)
      await screen.findByText("No conversations yet")
      const conversationNav = screen.getByRole("navigation", { name: "Conversation navigation" })
      const createTrigger = layout === "mobile"
        ? within(conversationNav).getByRole("button", { name: "New conversation" })
        : screen.getAllByRole("button", { name: "New conversation" })[0]

      await userEvent.click(createTrigger)
      const dialog = screen.getByRole("dialog", { name: "New conversation" })
      await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), `${layout} follow-up`)
      await userEvent.click(within(dialog).getByRole("button", { name: "Create conversation" }))

      expect(await screen.findByRole("heading", { name: `${layout} follow-up` })).toBeTruthy()
      const composer = screen.getByRole("textbox", { name: "Message" })
      expect(document.activeElement === composer).toBe(true)
      expect(composer.closest('[data-region="transcript"]')).not.toBeNull()
      expect(document.querySelector(".workspace-shell")?.getAttribute("data-mobile-pane")).toBe("transcript")
    })

    test(`focuses the visible conversation search after successful archive on ${layout}`, async () => {
      setViewport(width)
      render(<App api={fakeApi()} />)
      await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
      await userEvent.click(screen.getByRole("button", { name: "Archive conversation" }))
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }))

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Archive conversation" })).toBeNull())
      const search = screen.getByRole("searchbox", { name: "Search conversations" })
      expect(document.activeElement === search).toBe(true)
      expect(search.closest('[data-region="conversation-navigation"]')).not.toBeNull()
      expect(document.querySelector(".workspace-shell")?.getAttribute("data-mobile-pane")).toBe("conversations")
      expect(location.pathname).toBe("/")
    })
  }
})
