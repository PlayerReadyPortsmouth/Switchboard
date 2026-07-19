import { resetViewport, setViewport } from "../testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { ApiError } from "../api"
import { AgentStream, type EventSourceHandlers } from "../agentStream"
import type { AgentDetail, AgentSummary, Session } from "../types"
import { AgentsWorkspace, type AgentsApi } from "./AgentsWorkspace"

const screen = within(document.body)
const session: Session = {
  identity: "viewer@example.com",
  features: { agents: true, documents: false, turnSteps: false, cards: false },
  permissions: { agents: "viewer" },
  agents: [{ name: "qa", alive: true, busy: true }],
}

const summary = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  name: "qa", emoji: "🧪", description: "Release verification", mode: "persistent",
  status: "busy", queueDepth: 2, contextFill: .41, costUsd: 1.25, replicas: 1,
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
    previewAgentConfig: async (_name, next) => ({ id: "config-preview", before: detail().config, after: next, classification: { tier: "safe", fullRestart: [] }, expiresAt: Date.now() + 60_000 }),
    confirmAgentConfig: async () => ({ state: "applied", restarted: [], fullRestart: [] }),
    previewAgentAction: async (_name, action) => ({ id: "action-preview", actor: "operator@example.com", agent: "qa", action, statusVersion: "v1", impact: { busy: true, queueDepth: 2 }, expiresAt: Date.now() + 60_000 }),
    confirmAgentAction: async (_name, _id, _key) => ({ state: "applied", agent: "qa", action: "restart" }),
  }
}

afterEach(() => {
  cleanup()
  history.replaceState(null, "", "/agents")
  resetViewport()
})

describe("AgentsWorkspace", () => {
  test("searches status-labeled agents and opens read-only detail", async () => {
    render(<AgentsWorkspace api={fakeApi()} session={session} routeAgent={null} connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect(await screen.findByRole("list", { name: "Agents" })).toBeTruthy()
    expect(screen.getByText("Busy")).toBeTruthy()
    await userEvent.type(screen.getByRole("searchbox", { name: "Search agents" }), "qa")
    expect(screen.queryByRole("button", { name: "Open writer" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Open qa" }))
    expect(await screen.findByRole("heading", { name: "qa" })).toBeTruthy()
    expect(screen.getByText("41%")).toBeTruthy()
    expect(screen.getByText("Verify release")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull()
  })

  test("shows real mutation flows to permitted operators but omits them for viewers", async () => {
    const mutable = detail({ permissions: { configure: true, reset: true, restart: true, remove: false } })
    const view = render(<AgentsWorkspace api={fakeApi({ detail: mutable })} session={session} routeAgent="qa" connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    await screen.findByRole("heading", { name: "qa" })
    expect(screen.queryByRole("button", { name: "Configure agent" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Reset agent" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Restart agent" })).toBeNull()

    const operator = { ...session, permissions: { agents: "operator" as const } }
    view.rerender(<AgentsWorkspace api={fakeApi({ detail: mutable })} session={operator} routeAgent="qa" connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    expect(await screen.findByRole("tab", { name: "Overview" })).toBeTruthy()
    const overviewTab = screen.getByRole("tab", { name: "Overview" })
    overviewTab.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Sessions" }))
    expect(screen.getByRole("tab", { name: "Sessions" }).getAttribute("aria-selected")).toBe("true")
    await userEvent.keyboard("{End}")
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Activity" }))
    await userEvent.keyboard("{Home}")
    expect(document.activeElement).toBe(overviewTab)
    for (const label of ["Overview", "Sessions", "Configuration", "Activity"]) {
      const tab = screen.getByRole("tab", { name: label })
      const panel = document.getElementById(tab.getAttribute("aria-controls")!)
      expect(tab.id).toBeTruthy()
      expect(panel).toBeTruthy()
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id)
    }
    expect((screen.getByRole("button", { name: "Reset agent" }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole("button", { name: "Restart agent" }) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }))
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(false)
    await userEvent.clear(screen.getByLabelText("Description"))
    await userEvent.type(screen.getByLabelText("Description"), "Preserved local draft")
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }))
    expect(screen.getByText("Last tool invocation")).toBeTruthy()
    expect(screen.getByText(/Operations vertical/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Operations/ })).toBeNull()
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }))
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Preserved local draft")
  })

  test("renders loading, empty, forbidden, missing, and unavailable states", async () => {
    let resolve!: (agents: AgentSummary[]) => void
    const pending = new Promise<AgentSummary[]>(yes => { resolve = yes })
    const view = render(<AgentsWorkspace api={{ ...fakeApi(), listAgents: () => pending, getAgent: async () => detail() }} session={session} routeAgent={null} connection="connecting" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
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
    setViewport(500)
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
      ...fakeApi(),
      listAgents: async () => { listCalls++; return [summary()] },
      getAgent: async () => { detailCalls++; return detail({ version: `v${detailCalls}` }) },
    }
    const stream = new AgentStream({
      online: () => true,
      open: (_url, handlers) => { sourceHandlers = handlers; return { close() {} } },
    })
    render(<AgentsWorkspace api={api} session={session} routeAgent="qa" connection="live" streamFactory={() => stream} onNavigate={() => {}} onNewConversation={() => {}} />)
    const panel = await screen.findByRole("tabpanel")
    expect(await within(panel).findByText("v1")).toBeTruthy()
    expect(listCalls).toBe(1)
    expect(detailCalls).toBe(1)

    await act(async () => { sourceHandlers?.message(JSON.stringify({ kind: "snapshot_required", sequence: 1, ts: Date.now() })) })

    expect(await within(screen.getByRole("tabpanel")).findByText("v2")).toBeTruthy()
    expect(listCalls).toBe(2)
    expect(detailCalls).toBe(2)
  })

  test("uses a closed tablet detail drawer, moves focus into it, and restores focus on Escape", async () => {
    setViewport(900)
    render(<AgentsWorkspace api={fakeApi()} session={session} routeAgent={null} connection="live" streamFactory={null} onNavigate={() => {}} onNewConversation={() => {}} />)
    const row = await screen.findByRole("button", { name: "Open qa" })
    const shell = document.querySelector(".agents-shell")!
    const drawer = document.querySelector<HTMLElement>('.agent-detail[aria-label="Agent detail"]')!
    expect(shell.getAttribute("data-layout")).toBe("tablet")
    expect(drawer.getAttribute("data-open")).toBe("false")
    expect(drawer.getAttribute("aria-hidden")).toBe("true")

    await userEvent.click(row)
    await screen.findByRole("heading", { name: "qa" })
    expect(drawer.getAttribute("data-open")).toBe("true")
    expect(drawer.getAttribute("aria-hidden")).toBe("false")
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Back to agents"))

    await userEvent.keyboard("{Escape}")
    expect(drawer.getAttribute("data-open")).toBe("false")
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Open qa"))
  })

  test("defines tablet drawer geometry and prevents horizontal viewport overflow", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
    expect(css).toContain("html, body, #root { min-height: 100%; max-width: 100%; overflow-x: hidden; }")
    expect(css).toContain('.agents-shell[data-layout="tablet"] .agent-detail')
    expect(css).toContain('.agents-shell[data-layout="tablet"] .agent-detail[data-open="false"]')
    expect(css).toContain("inset: 0 0 0 calc(var(--rail-width) + var(--list-width))")
  })
})
