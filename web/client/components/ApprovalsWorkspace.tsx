import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ApiError } from "../api"
import { pathForApproval, type WorkspaceDestination } from "../routes"
import type {
  ApprovalDecision,
  ApprovalDecisionResult,
  ApprovalDetail as ApprovalDetailValue,
  ApprovalListPage,
  ApprovalListQuery,
  ApprovalRisk,
  ApprovalState,
  ApprovalSummary,
  ConnectionState,
  Session,
} from "../types"
import { ApprovalDetail, type ApprovalDetailError } from "./ApprovalDetail"
import { ApprovalList, type ApprovalFilterState, type ApprovalListError } from "./ApprovalList"
import { AppRail, workspaceDestinationFeatures } from "./AppRail"
import { DestinationMobileNav } from "./DestinationMobileNav"

export interface ApprovalsApi {
  listApprovals(query: ApprovalListQuery): Promise<ApprovalListPage>
  getApproval(approvalId: string): Promise<ApprovalDetailValue>
  decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    expectedVersion: string,
    idempotencyKey: string,
  ): Promise<ApprovalDecisionResult>
}

type ApprovalsLayout = "desktop" | "tablet" | "mobile"

const risks = new Set<ApprovalRisk>(["low", "elevated", "destructive"])
const states = new Set<ApprovalState>(["pending", "granted", "denied", "expired", "interrupted"])

function readLayout(): ApprovalsLayout {
  return window.innerWidth < 768 ? "mobile" : window.innerWidth < 1200 ? "tablet" : "desktop"
}

function readFilters(): ApprovalFilterState {
  const parameters = new URLSearchParams(location.search)
  const risk = parameters.get("risk") ?? ""
  const state = parameters.get("state") ?? ""
  return {
    group: parameters.get("group") === "history" ? "history" : "pending",
    search: parameters.get("search") ?? "",
    risk: risks.has(risk as ApprovalRisk) ? risk as ApprovalRisk : "",
    kind: parameters.get("kind") ?? "",
    requester: parameters.get("requester") ?? "",
    state: states.has(state as ApprovalState) ? state as ApprovalState : "",
    conversationId: parameters.get("conversationId") ?? "",
    createdFrom: parameters.get("createdFrom") ?? "",
    createdTo: parameters.get("createdTo") ?? "",
    decisionFrom: parameters.get("decisionFrom") ?? "",
    decisionTo: parameters.get("decisionTo") ?? "",
  }
}

function writeFilters(filters: ApprovalFilterState): void {
  const parameters = new URLSearchParams()
  parameters.set("group", filters.group)
  for (const [key, value] of Object.entries(filters)) {
    if (key === "group" || !value) continue
    parameters.set(key, value)
  }
  const search = parameters.toString()
  const pathname = location.pathname.startsWith("/approvals") ? location.pathname : pathForApproval(null)
  history.replaceState(null, "", `${pathname}${search ? `?${search}` : ""}`)
}

const optionalText = (value: string): string | undefined => value.trim() || undefined
const optionalTime = (value: string): number | undefined => {
  if (!value) return undefined
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

function toListQuery(filters: ApprovalFilterState, cursor?: string): ApprovalListQuery {
  return {
    group: filters.group,
    search: optionalText(filters.search),
    risk: filters.risk || undefined,
    kind: optionalText(filters.kind),
    requester: optionalText(filters.requester),
    state: filters.state || undefined,
    conversationId: optionalText(filters.conversationId),
    createdFrom: optionalTime(filters.createdFrom),
    createdTo: optionalTime(filters.createdTo),
    decisionFrom: optionalTime(filters.decisionFrom),
    decisionTo: optionalTime(filters.decisionTo),
    limit: 50,
    cursor,
  }
}

function mergeCanonical(current: ApprovalSummary[], incoming: ApprovalSummary[]): ApprovalSummary[] {
  const positions = new Map(current.map((item, index) => [item.id, index]))
  const merged = [...current]
  for (const item of incoming) {
    const position = positions.get(item.id)
    if (position === undefined) {
      positions.set(item.id, merged.length)
      merged.push(item)
    } else {
      merged[position] = item
    }
  }
  return merged
}

const listError = (error: unknown): ApprovalListError => error instanceof ApiError && (error.status === 401 || error.status === 403) ? "forbidden" : "unavailable"
const detailError = (error: unknown): ApprovalDetailError => error instanceof ApiError && (error.status === 401 || error.status === 403)
  ? "forbidden"
  : error instanceof ApiError && error.status === 404
    ? "not_found"
    : "unavailable"

export function ApprovalsWorkspace({ api, session, routeApprovalId, connection, revision, pendingCount, install, onNavigate, onNewConversation }: {
  api: ApprovalsApi
  session: Session
  routeApprovalId: string | null
  connection: ConnectionState
  revision: number
  pendingCount: number
  install?: { available: boolean; run(): Promise<void> }
  onNavigate(destination: WorkspaceDestination, id?: string | null): void
  onNewConversation(): void
}) {
  const [filters, setFilters] = useState<ApprovalFilterState>(() => readFilters())
  const [items, setItems] = useState<ApprovalSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<ApprovalListError>(null)
  const [activeApproval, setActiveApproval] = useState(routeApprovalId)
  const [selected, setSelected] = useState<ApprovalDetailValue | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedError, setSelectedError] = useState<ApprovalDetailError>(null)
  const [layout, setLayout] = useState<ApprovalsLayout>(() => readLayout())
  const [now, setNow] = useState(() => Date.now())
  const destinationFeatures = workspaceDestinationFeatures(session)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const detailCloseRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<string | null>(null)
  const activeApprovalRef = useRef(routeApprovalId)
  const listGeneration = useRef(0)
  const detailGeneration = useRef(0)

  useEffect(() => {
    const resize = () => setLayout(readLayout())
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const pop = () => setFilters(readFilters())
    window.addEventListener("popstate", pop)
    return () => window.removeEventListener("popstate", pop)
  }, [])

  useEffect(() => {
    activeApprovalRef.current = routeApprovalId
    setActiveApproval(routeApprovalId)
    if (routeApprovalId === null) {
      setSelected(null)
      setSelectedError(null)
      setDetailLoading(false)
    }
  }, [routeApprovalId])

  useEffect(() => writeFilters(filters), [filters])

  const loadList = useCallback(async (append = false, cursor?: string) => {
    const generation = ++listGeneration.current
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const response = await api.listApprovals(toListQuery(filters, cursor))
      if (generation !== listGeneration.current) return
      setItems(current => append ? mergeCanonical(current, response.items) : response.items)
      setNextCursor(response.nextCursor)
      setLoadError(null)
    } catch (error) {
      if (generation !== listGeneration.current) return
      if (!append) {
        setItems([])
        setNextCursor(null)
        setLoadError(listError(error))
      }
    } finally {
      if (generation === listGeneration.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [api, filters])

  useEffect(() => {
    void loadList()
    return () => { listGeneration.current++ }
  }, [loadList, revision])

  const loadDetail = useCallback(async (approvalId: string) => {
    const generation = ++detailGeneration.current
    setDetailLoading(true)
    setSelectedError(null)
    try {
      const response = await api.getApproval(approvalId)
      if (generation !== detailGeneration.current) return
      setSelected(response)
    } catch (error) {
      if (generation !== detailGeneration.current) return
      setSelected(null)
      setSelectedError(detailError(error))
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (!activeApproval) return
    void loadDetail(activeApproval)
    return () => { detailGeneration.current++ }
  }, [activeApproval, loadDetail, revision])

  useLayoutEffect(() => {
    if (activeApproval || !restoreFocus.current) return
    const id = restoreFocus.current
    const row = rows.current.get(id)
    if (!row?.isConnected) return
    restoreFocus.current = null
    row.focus()
  }, [activeApproval, items, loading])

  useLayoutEffect(() => {
    if ((layout === "tablet" || layout === "mobile") && activeApproval && selected) detailCloseRef.current?.focus()
  }, [activeApproval, layout, selected])

  const changeFilters = (next: ApprovalFilterState) => {
    setItems([])
    setNextCursor(null)
    setFilters(next)
  }

  const selectApproval = (item: ApprovalSummary) => {
    restoreFocus.current = item.id
    activeApprovalRef.current = item.id
    setActiveApproval(item.id)
    onNavigate("approvals", item.id)
  }

  const showList = () => {
    const current = activeApprovalRef.current
    if (current) restoreFocus.current = current
    if (layout === "mobile") {
      history.back()
      return
    }
    activeApprovalRef.current = null
    setActiveApproval(null)
    setSelected(null)
    setSelectedError(null)
    onNavigate("approvals", null)
  }

  const registerRow = (id: string, element: HTMLButtonElement | null) => {
    if (!element) {
      rows.current.delete(id)
      return
    }
    rows.current.set(id, element)
    if (activeApprovalRef.current === null && restoreFocus.current === id) {
      restoreFocus.current = null
      element.focus()
    }
  }

  const hiddenDetail = layout !== "desktop" && !activeApproval
  return <main className="approvals-shell" data-layout={layout} data-mobile-pane={activeApproval ? "detail" : "list"}>
    <span className="sr-only" aria-live="polite">{connection === "live" ? `${pendingCount} approvals pending.` : `Approval updates ${connection}.`}</span>
    <AppRail active="approvals" features={destinationFeatures} pendingApprovals={pendingCount} connection={connection} install={install} onNew={onNewConversation} onNavigate={destination => onNavigate(destination)} />
    <ApprovalList items={items} selectedId={activeApproval} filters={filters} now={now} pendingCount={pendingCount} loading={loading} error={loadError} connection={connection} nextCursor={nextCursor} loadingMore={loadingMore} onFiltersChange={changeFilters} onSelect={selectApproval} onLoadMore={() => { if (nextCursor) void loadList(true, nextCursor) }} rowRef={registerRow} />
    <ApprovalDetail approval={selected} loading={detailLoading} error={selectedError} hidden={hiddenDetail} producing={session.approvalState.producing} connection={connection} closeRef={detailCloseRef} onBack={showList} onConversation={conversationId => onNavigate("conversations", conversationId)} />
    <DestinationMobileNav active="approvals" features={destinationFeatures} pendingApprovals={pendingCount} onNavigate={destination => onNavigate(destination)} />
  </main>
}
