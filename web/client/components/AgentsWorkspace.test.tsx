import "../testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiError } from "../api"
import { AgentStream, type EventSourceHandlers } from "../agentStream"
import type { AgentDetail, AgentSummary, Session } from "../types"
import { AgentsWorkspace, type AgentsApi } from "./AgentsWorkspace"

const screen = within(document.body)
const session: Session = {
  identity: "viewer@example.com",
  features: { agents: true },
  permissions: { agents: "viewer" },
  agents: [{ name: "qa", alive: true, busy: true }],
}

const summary = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  name: "qa", emoji: "🧪", description: "Release verification", mode: "persistent",
  status: "busy", queueDepth: 2, contextFill: 41, costUsd: 1.25, replicas: 1,
  lastActivityMs: 1_700_000_000_000, currentTool: "bun test",
  lastTool: { name: "typecheck", error: false },
  currentWork: { state: "prodding", goal: "Verify release", round: 2, max: 4 },
  model: "gpt-5", version: "v3",
  permissions: { configure: false, reset: false, restart: false, remove: false },
  ...overrides,
})

const detail = (overrides: Partial<AgentDetail> = {}): AgentDetail => ({
  ...summary(),
  config: {
    emoji: "🧪", description: "Release verification", mode: "persistent",
    access: { roles: ["viewer"] },
    runtime: { cwd: "/workspace/qa", model: "gpt-5", allowedTools: ["bun"] },
  },
  ...overrides,
})

function fakeApi(options: { agents?: AgentSummary[]; detail?: AgentDetail; listError?: unknown; detailError?: unknown } = {}): AgentsApi {
  return {
    listAgents: async () => {
      if (options.listError) throw options.listError
      return options.agents ?? [summary(), summary({ name: "writer", status: "idle", currentWork: null, currentTool: null })]
    },
    getAgent: async () => {
      if (options.detailError) throw options.detailError
      return options.detail ?? detail()
    },
  }
}

afterEach(() => { cleanup(); history.replaceState(null, "", "/agents") })

describe("AgentsWorkspace", () => {
  test("searches status-labeled agents and opens read-only detail", async () => {
    render(<AgentsWorkspace api={fakeApi()} session={session} routeAgent={null} connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect(await screen.findByRole("list", { name: "Agents" })).toBeTruthy()
    expect(screen.getByText("Busy")).toBeTruthy()
    await userEvent.type(screen.getByRole("searchbox", { name: "Search agents" }), "qa")
    expect(screen.queryByRole("button", { name: "Open writer" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Open qa" }))
    expect(await screen.findByRole("heading", { name: "qa" })).toBeTruthy()
    expect(screen.getByText("Verify release")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull()
  })

  test("renders loading, empty, forbidden, missing, and unavailable states", async () => {
    let resolve!: (agents: AgentSummary[]) => void
    const pending = new Promise<AgentSummary[]>(yes => { resolve = yes })
    const view = render(<AgentsWorkspace api={{ listAgents: () => pending, getAgent: async () => detail() }} session={session} routeAgent={null} connection="connecting" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect(screen.getByRole("status").textContent).toContain("Loading agents")
    resolve([])
    expect(await screen.findByText("No agents available")).toBeTruthy()

    view.rerender(<AgentsWorkspace api={fakeApi({ listError: new ApiError(403, "forbidden") })} session={session} routeAgent={null} connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect((await screen.findByRole("alert")).textContent).toContain("Agent access denied")
    view.rerender(<AgentsWorkspace api={fakeApi({ detailError: new ApiError(404, "not_found") })} session={session} routeAgent="missing" connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect((await screen.findByRole("alert")).textContent).toContain("Agent not found")
    view.rerender(<AgentsWorkspace api={fakeApi({ listError: new ApiError(503, "offline") })} session={session} routeAgent={null} connection="offline" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect((await screen.findByRole("alert")).textContent).toContain("Agents are unavailable offline")
  })

  test("uses browser history on mobile back and restores focus to the selected row", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 })
    const navigations: Array<string | null> = []
    const api = fakeApi()
    const view = render(<AgentsWorkspace api={api} session={session} routeAgent={null} connection="live" streamFactory={null} onNavigate={(_destination, agent) => navigations.push(agent ?? null)} onNewConversation={() => {}} />)
    const row = await screen.findByRole("button", { name: "Open qa" })
    await userEvent.click(row)
    view.rerender(<AgentsWorkspace api={api} session={session} routeAgent="qa" connection="live" streamFactory={null} onNavigate={(_destination, agent) => navigations.push(agent ?? null)} onNewConversation={() => {}} />)
    await screen.findByRole("heading", { name: "qa" })
    await userEvent.click(screen.getByRole("button", { name: "Back to agents" }))
    view.rerender(<AgentsWorkspace api={api} session={session} routeAgent={null} connection="live" streamFactory={null} onNavigate={(_destination, agent) => navigations.push(agent ?? null)} onNewConversation={() => {}} />)
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Open qa"))
    expect(navigations).toEqual(["qa", null])
  })

  test("reloads the list and open detail when the stream invalidates its snapshot", async () => {
    let sourceHandlers: EventSourceHandlers | null = null
    let listCalls = 0
    let detailCalls = 0
    const api: AgentsApi = {
      listAgents: async () => { listCalls++; return [summary()] },
      getAgent: async () => { detailCalls++; return detail({ version: `v${detailCalls}` }) },
    }
    const stream = new AgentStream({
      online: () => true,
      open: (_url, handlers) => { sourceHandlers = handlers; return { close() {} } },
    })
    render(<AgentsWorkspace api={api} session={session} routeAgent="qa" connection="live" streamFactory={() => stream} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect(await screen.findByText("v1")).toBeTruthy()
    expect(listCalls).toBe(1)
    expect(detailCalls).toBe(1)

    await act(async () => { sourceHandlers?.message(JSON.stringify({ kind: "snapshot_required", sequence: 1, ts: Date.now() })) })

    expect(await screen.findByText("v2")).toBeTruthy()
    expect(listCalls).toBe(2)
    expect(detailCalls).toBe(2)
  })
})
