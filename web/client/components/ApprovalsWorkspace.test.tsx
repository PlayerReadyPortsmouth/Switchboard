import "../testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, useState } from "react"
import { ApiError } from "../api"
import { parseWorkspaceRoute, pathForApproval } from "../routes"
import type {
  ApprovalDecisionResult,
  ApprovalDetail,
  ApprovalListPage,
  ApprovalListQuery,
  ApprovalSummary,
  ConnectionState,
  Session,
  WorkspaceRole,
} from "../types"
import { ApprovalsWorkspace, type ApprovalsApi } from "./ApprovalsWorkspace"

const screen = within(document.body)
const NOW = 1_700_000_000_000

const approval = (overrides: Partial<ApprovalSummary> = {}): ApprovalSummary => ({
  id: "approval-1",
  version: "v1",
  kind: "outbound_http",
  target: "https://release.example/deploy",
  summary: "Deploy the release candidate",
  risk: "elevated",
  requestedBy: { surface: "agent", id: "architect@example.com" },
  createdAt: NOW - 60_000,
  expiresAt: NOW + 300_000,
  terminalAt: null,
  state: "pending",
  execution: "not_applicable",
  conversationId: "conversation/1",
  ...overrides,
})

const detail = (overrides: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  ...approval(),
  detail: { method: "POST", hostname: "release.example", body: "<b>not markup</b>" },
  executionDetail: null,
  decisionBy: null,
  decisionAt: null,
  outcomeReason: null,
  audit: [{ ts: NOW - 60_000, actor: "agent:architect@example.com", action: "requested", outcome: "pending" }],
  permissions: { canDecide: true },
  ...overrides,
})

function workspaceSession(options: {
  role?: WorkspaceRole
  producing?: boolean
  pendingCount?: number
} = {}): Session {
  const role = options.role ?? "viewer"
  return {
    identity: "viewer@example.com",
    agents: [],
    features: { agents: false, approvals: true },
    permissions: { agents: "hidden", approvals: role },
    approvalState: {
      producing: options.producing ?? true,
      canDecide: role === "operator",
      pendingCount: options.pendingCount ?? 2,
    },
  }
}

function page(items: ApprovalSummary[], nextCursor: string | null = null): ApprovalListPage {
  return { items, nextCursor, pendingCount: 2, querySummary: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeApi(options: {
  list?: (query: ApprovalListQuery) => Promise<ApprovalListPage>
  get?: (id: string) => Promise<ApprovalDetail>
} = {}) {
  const calls = { list: [] as ApprovalListQuery[], get: [] as string[] }
  const api: ApprovalsApi = {
    listApprovals: async query => {
      calls.list.push({ ...query })
      return options.list ? options.list(query) : page([approval()])
    },
    getApproval: async id => {
      calls.get.push(id)
      return options.get ? options.get(id) : detail({ id })
    },
    decideApproval: async (): Promise<ApprovalDecisionResult> => ({ approval: detail() }),
  }
  return { api, calls }
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

function renderWorkspace(options: {
  api?: ApprovalsApi
  session?: Session
  routeApprovalId?: string | null
  connection?: ConnectionState
  revision?: number
  pendingCount?: number
  onNavigate?: (destination: "conversations" | "agents" | "approvals", id?: string | null) => void
} = {}) {
  return render(<ApprovalsWorkspace
    api={options.api ?? fakeApi().api}
    session={options.session ?? workspaceSession()}
    routeApprovalId={options.routeApprovalId ?? null}
    connection={options.connection ?? "live"}
    revision={options.revision ?? 0}
    pendingCount={options.pendingCount ?? 2}
    onNavigate={options.onNavigate ?? (() => {})}
    onNewConversation={() => {}}
  />)
}

afterEach(() => {
  cleanup()
  history.replaceState(null, "", "/approvals")
  setViewport(1280)
})

describe("ApprovalsWorkspace", () => {
  test("viewer can search pending and history and inspect sanitized detail without controls", async () => {
    const { api, calls } = fakeApi()
    renderWorkspace({ api })

    await userEvent.type(await screen.findByRole("searchbox", { name: "Search approvals" }), "deploy")
    await waitFor(() => expect(calls.list.at(-1)).toMatchObject({ group: "pending", search: "deploy", limit: 50 }))
    await userEvent.click(screen.getByRole("tab", { name: "History" }))
    await waitFor(() => expect(calls.list.at(-1)).toMatchObject({ group: "history", search: "deploy", limit: 50 }))

    await userEvent.click(await screen.findByRole("button", { name: /Open approval Deploy the release candidate/ }))
    expect(await screen.findByRole("heading", { name: "Deploy the release candidate" })).toBeTruthy()
    expect(screen.getByText("<b>not markup</b>")).toBeTruthy()
    expect(document.querySelector("b")?.textContent).not.toBe("not markup")
    expect(screen.queryByRole("button", { name: /approve|deny/i })).toBeNull()
  })

  test("uses every list filter, a removable conversation chip, exact cursors, and canonical overlap dedupe", async () => {
    history.replaceState(null, "", "/approvals?conversationId=conversation%2F1")
    const first = approval()
    const { api, calls } = fakeApi({
      list: async query => query.cursor === "cursor/2"
        ? page([
          approval({ id: first.id, version: "v2", summary: "Canonical deploy request" }),
          approval({ id: "approval-2", summary: "Rotate signing key", risk: "destructive" }),
        ])
        : page([first], "cursor/2"),
    })
    renderWorkspace({ api })

    expect(await screen.findByRole("button", { name: "Clear conversation filter conversation/1" })).toBeTruthy()
    await userEvent.selectOptions(screen.getByLabelText("Risk"), "destructive")
    await userEvent.type(screen.getByLabelText("Kind"), "outbound/http")
    await userEvent.type(screen.getByLabelText("Requester"), "agent:qa@example.com")
    await userEvent.selectOptions(screen.getByLabelText("State"), "pending")
    await userEvent.type(screen.getByLabelText("Created from"), "2023-11-14T10:00")
    await userEvent.type(screen.getByLabelText("Created to"), "2023-11-14T11:00")
    await userEvent.type(screen.getByLabelText("Decision from"), "2023-11-14T12:00")
    await userEvent.type(screen.getByLabelText("Decision to"), "2023-11-14T13:00")

    await waitFor(() => expect(calls.list.at(-1)).toMatchObject({
      group: "pending",
      risk: "destructive",
      kind: "outbound/http",
      requester: "agent:qa@example.com",
      state: "pending",
      conversationId: "conversation/1",
      createdFrom: new Date("2023-11-14T10:00").getTime(),
      createdTo: new Date("2023-11-14T11:00").getTime(),
      decisionFrom: new Date("2023-11-14T12:00").getTime(),
      decisionTo: new Date("2023-11-14T13:00").getTime(),
    }))

    await userEvent.click(await screen.findByRole("button", { name: "Load more" }))
    await waitFor(() => expect(calls.list.at(-1)?.cursor).toBe("cursor/2"))
    expect(screen.getAllByRole("button", { name: /Open approval/ })).toHaveLength(2)
    expect(screen.getByText("Canonical deploy request")).toBeTruthy()

    await userEvent.click(screen.getByRole("tab", { name: "History" }))
    await waitFor(() => expect(calls.list.at(-1)?.group).toBe("history"))
    expect(calls.list.at(-1)?.cursor).toBeUndefined()
    expect((screen.getByRole("searchbox", { name: "Search approvals" }) as HTMLInputElement).value).toBe("")

    await userEvent.click(screen.getByRole("button", { name: "Clear conversation filter conversation/1" }))
    await waitFor(() => expect(calls.list.at(-1)?.conversationId).toBeUndefined())
  }, 10_000)

  test("desktop shows master and detail while tablet opens a focus-managed detail drawer", async () => {
    const { api } = fakeApi()
    const desktop = renderWorkspace({ api })
    await screen.findByRole("list", { name: "Approvals" })
    expect(document.querySelector(".approvals-shell")?.getAttribute("data-layout")).toBe("desktop")
    expect(screen.getByRole("region", { name: "Approval detail" })).toBeTruthy()
    desktop.unmount()

    setViewport(900)
    renderWorkspace({ api })
    const row = await screen.findByRole("button", { name: /Open approval/ })
    const drawer = document.querySelector<HTMLElement>('.approval-detail[aria-label="Approval detail"]')!
    expect(drawer.getAttribute("data-open")).toBe("false")
    expect(drawer.getAttribute("aria-hidden")).toBe("true")

    await userEvent.click(row)
    expect(await screen.findByRole("heading", { name: "Deploy the release candidate" })).toBeTruthy()
    const back = screen.getByRole("button", { name: "Back to approvals" })
    await waitFor(() => expect(document.activeElement).toBe(back))
    await userEvent.keyboard("{Escape}")
    expect(drawer.getAttribute("data-open")).toBe("false")
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  test("stacks tablet drawer evidence so operational values keep a readable measure", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text()
    expect(css).toMatch(/\.approvals-shell\[data-layout="tablet"\] \.approval-detail-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(css).toMatch(/\.approvals-shell\[data-layout="tablet"\] \.approval-facts\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  test("keeps one focused Back control while tablet detail loads and fails", async () => {
    setViewport(900)
    const pendingDetail = deferred<ApprovalDetail>()
    const { api } = fakeApi({ get: async () => pendingDetail.promise })
    const navigations: Array<[string, string | null | undefined]> = []
    renderWorkspace({
      api,
      routeApprovalId: "approval-1",
      onNavigate: (destination, id) => navigations.push([destination, id]),
    })

    expect(await screen.findByText("Loading approval…")).toBeTruthy()
    const back = screen.getByRole("button", { name: "Back to approvals" })
    await waitFor(() => expect(document.activeElement).toBe(back))

    act(() => pendingDetail.reject(new ApiError(503, "unavailable")))
    expect((await screen.findByRole("alert")).textContent).toContain("Approval unavailable")
    expect(screen.getByRole("button", { name: "Back to approvals" })).toBe(back)
    expect(document.activeElement).toBe(back)

    await userEvent.keyboard("{Escape}")
    expect(navigations).toContainEqual(["approvals", null])
  })

  test("uses a canonical list fallback when mobile detail was opened directly", async () => {
    setViewport(500)
    history.replaceState(null, "", "/approvals/approval-1?group=history")
    const navigations: Array<[string, string | null | undefined]> = []
    renderWorkspace({
      routeApprovalId: "approval-1",
      onNavigate: (destination, id) => navigations.push([destination, id]),
    })

    expect(await screen.findByRole("heading", { name: "Deploy the release candidate" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Back to approvals" }))
    expect(navigations).toContainEqual(["approvals", null])
  })

  test("implements keyboard tabs with a labelled results panel", async () => {
    renderWorkspace()
    const pending = await screen.findByRole("tab", { name: "Pending" })
    pending.focus()
    await userEvent.keyboard("{ArrowRight}")

    const historyTab = screen.getByRole("tab", { name: "History" })
    expect(historyTab.getAttribute("aria-selected")).toBe("true")
    expect(document.activeElement).toBe(historyTab)
    expect(screen.getByRole("tabpanel", { name: "History" })).toBeTruthy()
  })

  test("mobile detail uses its encoded route and browser Back restores the selected row", async () => {
    setViewport(500)
    const { api } = fakeApi()

    function RoutedWorkspace() {
      const initial = parseWorkspaceRoute(location.pathname)
      const [routeId, setRouteId] = useState(initial.destination === "approvals" ? initial.approvalId : null)
      useEffect(() => {
        const pop = () => {
          const route = parseWorkspaceRoute(location.pathname)
          setRouteId(route.destination === "approvals" ? route.approvalId : null)
        }
        window.addEventListener("popstate", pop)
        return () => window.removeEventListener("popstate", pop)
      }, [])
      return <ApprovalsWorkspace api={api} session={workspaceSession()} routeApprovalId={routeId} connection="live" revision={0} pendingCount={2} onNewConversation={() => {}} onNavigate={(destination, id) => {
        if (destination !== "approvals") return
        const path = pathForApproval(id ?? null)
        history.pushState(null, "", path)
        setRouteId(id ?? null)
      }} />
    }

    render(<RoutedWorkspace />)
    const row = await screen.findByRole("button", { name: /Open approval/ })
    await userEvent.click(row)
    expect(location.pathname).toBe("/approvals/approval-1")
    expect(await screen.findByRole("heading", { name: "Deploy the release candidate" })).toBeTruthy()

    act(() => {
      history.replaceState(null, "", "/approvals")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toMatch(/Open approval/))
  })

  test("renders operational loading, empty, forbidden, offline, unavailable, missing, and core-disabled states", async () => {
    let resolve!: (value: ApprovalListPage) => void
    const pending = new Promise<ApprovalListPage>(yes => { resolve = yes })
    const loading = fakeApi({ list: async () => pending })
    const view = renderWorkspace({ api: loading.api })
    expect(screen.getByRole("status").textContent).toContain("Loading approvals")
    resolve(page([]))
    expect(await screen.findByText("No pending approvals")).toBeTruthy()
    view.unmount()

    renderWorkspace({ api: fakeApi({ list: async () => { throw new ApiError(403, "forbidden") } }).api })
    expect((await screen.findByRole("alert")).textContent).toContain("Approval access denied")
    cleanup()

    renderWorkspace({ api: fakeApi({ list: async () => { throw new ApiError(503, "unavailable") } }).api, connection: "offline" })
    expect((await screen.findByRole("alert")).textContent).toContain("Approvals are unavailable offline")
    cleanup()

    renderWorkspace({ api: fakeApi({ list: async () => { throw new ApiError(503, "unavailable") } }).api })
    expect((await screen.findByRole("alert")).textContent).toContain("Approvals are unavailable")
    cleanup()

    renderWorkspace({ api: fakeApi({ get: async () => { throw new ApiError(404, "not_found") } }).api, routeApprovalId: "missing" })
    expect((await screen.findByRole("alert")).textContent).toContain("Approval not found")
    cleanup()

    renderWorkspace({ session: workspaceSession({ producing: false }) })
    expect(await screen.findByText("Core approval production is off")).toBeTruthy()
  })

  test("revision reloads the filtered list and open detail without resetting filters", async () => {
    const { api, calls } = fakeApi()
    const view = renderWorkspace({ api, routeApprovalId: "approval-1", revision: 0 })
    await userEvent.type(await screen.findByRole("searchbox", { name: "Search approvals" }), "deploy")
    await waitFor(() => expect(calls.list.at(-1)?.search).toBe("deploy"))
    await waitFor(() => expect(calls.get).toEqual(["approval-1"]))
    const listCalls = calls.list.length

    view.rerender(<ApprovalsWorkspace api={api} session={workspaceSession()} routeApprovalId="approval-1" connection="live" revision={1} pendingCount={3} onNavigate={() => {}} onNewConversation={() => {}} />)
    await waitFor(() => expect(calls.list.length).toBeGreaterThan(listCalls))
    await waitFor(() => expect(calls.get).toEqual(["approval-1", "approval-1"]))
    expect((screen.getByRole("searchbox", { name: "Search approvals" }) as HTMLInputElement).value).toBe("deploy")
  })

  test("long approval evidence wraps locally without horizontal viewport overflow", async () => {
    const long = "very-long-evidence-".repeat(40)
    const { api } = fakeApi({
      list: async () => page([approval({ summary: long, target: long, requestedBy: { surface: "agent", id: long } })]),
      get: async () => detail({ summary: long, target: long, requestedBy: { surface: "agent", id: long }, detail: { long } }),
    })
    renderWorkspace({ api, routeApprovalId: "approval-1" })
    expect(await screen.findByText(long, { selector: ".approval-detail h2" })).toBeTruthy()
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text()
    expect(css).toContain("html, body, #root { min-height: 100%; max-width: 100%; overflow-x: hidden; }")
    expect(css).toMatch(/\.approval-(?:copy|detail|safe-value)[^{]*\{[^}]*overflow-wrap:\s*anywhere/)
  })
})
