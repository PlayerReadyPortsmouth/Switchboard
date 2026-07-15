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
import { ApprovalDecisionDialog } from "./ApprovalDecisionDialog"
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
const executions = new Set(["not_applicable", "pending", "succeeded", "failed", "interrupted"])

interface DecisionAttempt {
  approvalId: string
  decision: ApprovalDecision
  expectedVersion: string
  idempotencyKey: string
  ambiguous: boolean
}

interface DecisionDialogState {
  approvalId: string
  decision: ApprovalDecision
  expectedVersion: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isPrincipal = (value: unknown): boolean => isRecord(value) && typeof value.surface === "string" && typeof value.id === "string"
const isSafeValue = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
  if (Array.isArray(value)) return value.every(isSafeValue)
  return isRecord(value) && Object.values(value).every(isSafeValue)
}

function isApprovalDetail(value: unknown): value is ApprovalDetailValue {
  if (!isRecord(value)) return false
  return typeof value.id === "string"
    && typeof value.version === "string"
    && typeof value.kind === "string"
    && typeof value.target === "string"
    && typeof value.summary === "string"
    && risks.has(value.risk as ApprovalRisk)
    && isPrincipal(value.requestedBy)
    && typeof value.createdAt === "number"
    && typeof value.expiresAt === "number"
    && (value.terminalAt === null || typeof value.terminalAt === "number")
    && states.has(value.state as ApprovalState)
    && executions.has(value.execution as string)
    && (value.conversationId === undefined || typeof value.conversationId === "string")
    && isSafeValue(value.detail)
    && isSafeValue(value.executionDetail)
    && (value.decisionBy === null || isPrincipal(value.decisionBy))
    && (value.decisionAt === null || typeof value.decisionAt === "number")
    && (value.outcomeReason === null || typeof value.outcomeReason === "string")
    && Array.isArray(value.audit)
    && value.audit.every(item => isRecord(item) && typeof item.ts === "number" && typeof item.actor === "string" && typeof item.action === "string" && typeof item.outcome === "string")
    && isRecord(value.permissions)
    && typeof value.permissions.canDecide === "boolean"
}

function canonicalConflictHint(payload: unknown, approvalId: string): ApprovalDetailValue | null {
  if (!isRecord(payload) || !isApprovalDetail(payload.canonical)) return null
  return payload.canonical.id === approvalId ? payload.canonical : null
}

const freshIdempotencyKey = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
const approvalDecisionLiveStatus = (approval: ApprovalDetailValue): string | null => {
  if (approval.state === "granted" && approval.execution === "failed") return "Grant recorded. Delivery failed."
  if (approval.state === "granted" && approval.execution === "interrupted") return "Grant recorded. Execution result is unknown; do not retry."
  if (approval.state === "granted" && approval.execution === "succeeded") return "Grant recorded. Execution succeeded."
  if (approval.state === "denied") return "Denial recorded. The held effect did not run."
  if (approval.state === "expired") return "Approval expired. The held effect did not run."
  if (approval.state === "interrupted") return "Approval interrupted. The held effect did not run."
  return null
}

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
  const [canonicalLoaded, setCanonicalLoaded] = useState<{ approvalId: string; version: string; revision: number } | null>(null)
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogState | null>(null)
  const [decisionAttempt, setDecisionAttempt] = useState<DecisionAttempt | null>(null)
  const [decisionSubmitting, setDecisionSubmitting] = useState(false)
  const [decisionReconciling, setDecisionReconciling] = useState(false)
  const [decisionError, setDecisionError] = useState("")
  const [decisionStatus, setDecisionStatus] = useState("")
  const [reconciliationFailed, setReconciliationFailed] = useState(false)
  const [layout, setLayout] = useState<ApprovalsLayout>(() => readLayout())
  const [now, setNow] = useState(() => Date.now())
  const destinationFeatures = workspaceDestinationFeatures(session)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const detailCloseRef = useRef<HTMLButtonElement>(null)
  const detailFocusRef = useRef<HTMLElement>(null)
  const restoreFocus = useRef<string | null>(null)
  const activeApprovalRef = useRef(routeApprovalId)
  const internalMobileDetail = useRef<string | null>(null)
  const listGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const selectedRef = useRef<ApprovalDetailValue | null>(null)
  const attemptRef = useRef<DecisionAttempt | null>(null)
  const decisionPendingRef = useRef(false)
  const reconcilingRef = useRef(false)
  const decisionInvokerRef = useRef<HTMLElement | null>(null)
  const revisionRef = useRef(revision)
  selectedRef.current = selected
  revisionRef.current = revision

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
    if (internalMobileDetail.current !== routeApprovalId) internalMobileDetail.current = null
    activeApprovalRef.current = routeApprovalId
    setActiveApproval(routeApprovalId)
    setCanonicalLoaded(null)
    setReconciliationFailed(false)
    attemptRef.current = null
    setDecisionAttempt(null)
    setDecisionDialog(null)
    setDecisionError("")
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
    const requestedRevision = revisionRef.current
    setDetailLoading(true)
    setSelectedError(null)
    setCanonicalLoaded(null)
    try {
      const response = await api.getApproval(approvalId)
      if (generation !== detailGeneration.current) return
      setSelected(response)
      setCanonicalLoaded({ approvalId: response.id, version: response.version, revision: requestedRevision })
      setReconciliationFailed(false)
      const pendingAttempt = attemptRef.current
      const verifiedAmbiguousAttempt = Boolean(pendingAttempt?.ambiguous
        && pendingAttempt.approvalId === response.id
        && pendingAttempt.expectedVersion === response.version
        && response.state === "pending")
      if (verifiedAmbiguousAttempt) {
        setDecisionError("The request outcome was not confirmed. Canonical approval is still pending; retry will reuse this attempt.")
        setDecisionStatus("Canonical approval is still pending. Retry will reuse the same decision attempt.")
      } else {
        const terminalStatus = approvalDecisionLiveStatus(response)
        if (terminalStatus) setDecisionStatus(terminalStatus)
      }
    } catch (error) {
      if (generation !== detailGeneration.current) return
      setSelected(null)
      setCanonicalLoaded(null)
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

  const clearDecisionAttempt = useCallback(() => {
    attemptRef.current = null
    setDecisionAttempt(null)
  }, [])

  const restoreDecisionFocus = useCallback(() => {
    window.setTimeout(() => {
      const invoker = decisionInvokerRef.current
      const invokerDisabled = invoker instanceof HTMLButtonElement && invoker.disabled
      if (invoker?.isConnected && !invokerDisabled) {
        invoker.focus()
        return
      }
      const close = detailCloseRef.current
      if (close?.isConnected && window.getComputedStyle(close).display !== "none" && window.getComputedStyle(close).visibility !== "hidden") {
        close.focus()
        return
      }
      detailFocusRef.current?.focus()
    }, 0)
  }, [])

  const closeDecisionDialog = useCallback(() => {
    setDecisionDialog(null)
    setDecisionError("")
    restoreDecisionFocus()
  }, [restoreDecisionFocus])

  const canonicalReady = Boolean(selected
    && canonicalLoaded?.approvalId === selected.id
    && canonicalLoaded.version === selected.version
    && canonicalLoaded.revision === revision)

  useEffect(() => {
    const current = attemptRef.current
    if (!current || (selected && current.approvalId === selected.id && current.expectedVersion === selected.version)) return
    clearDecisionAttempt()
  }, [clearDecisionAttempt, selected?.id, selected?.version])

  useEffect(() => {
    if (!decisionDialog) return
    const dialogStillCanonical = Boolean(selected
      && selected.id === decisionDialog.approvalId
      && selected.version === decisionDialog.expectedVersion
      && selected.state === "pending"
      && (canonicalReady || decisionSubmitting || decisionReconciling))
    if (dialogStillCanonical) return
    closeDecisionDialog()
  }, [canonicalReady, closeDecisionDialog, decisionDialog, decisionReconciling, decisionSubmitting, selected])

  useLayoutEffect(() => {
    if (activeApproval || !restoreFocus.current) return
    const id = restoreFocus.current
    const row = rows.current.get(id)
    if (!row?.isConnected) return
    restoreFocus.current = null
    row.focus()
  }, [activeApproval, items, loading])

  useLayoutEffect(() => {
    if ((layout === "tablet" || layout === "mobile") && activeApproval) detailCloseRef.current?.focus()
  }, [activeApproval, detailLoading, layout, selected, selectedError])

  const changeFilters = (next: ApprovalFilterState) => {
    setItems([])
    setNextCursor(null)
    setFilters(next)
  }

  const selectApproval = (item: ApprovalSummary) => {
    restoreFocus.current = item.id
    activeApprovalRef.current = item.id
    internalMobileDetail.current = layout === "mobile" ? item.id : null
    setActiveApproval(item.id)
    onNavigate("approvals", item.id)
  }

  const showList = () => {
    const current = activeApprovalRef.current
    if (current) restoreFocus.current = current
    const returnThroughHistory = layout === "mobile" && internalMobileDetail.current === current
    internalMobileDetail.current = null
    activeApprovalRef.current = null
    setActiveApproval(null)
    setSelected(null)
    setSelectedError(null)
    setDetailLoading(false)
    if (returnThroughHistory) {
      history.back()
      return
    }
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

  const acceptCanonicalApproval = (canonical: ApprovalDetailValue, loaded: boolean) => {
    setItems(current => mergeCanonical(current, [canonical]))
    if (activeApprovalRef.current !== canonical.id) return
    selectedRef.current = canonical
    setSelected(canonical)
    setSelectedError(null)
    setDetailLoading(false)
    setCanonicalLoaded(loaded ? { approvalId: canonical.id, version: canonical.version, revision: revisionRef.current } : null)
  }

  const submitDecision = async (decision: ApprovalDecision) => {
    if (decisionPendingRef.current || reconcilingRef.current) return
    const canonical = selectedRef.current
    const currentlyLoaded = Boolean(canonical
      && canonicalLoaded?.approvalId === canonical.id
      && canonicalLoaded.version === canonical.version
      && canonicalLoaded.revision === revisionRef.current)
    const allowed = Boolean(canonical
      && canonical.state === "pending"
      && session.approvalState.canDecide
      && canonical.permissions.canDecide
      && session.approvalState.producing
      && connection === "live"
      && currentlyLoaded
      && !reconciliationFailed)
    if (!canonical || !allowed) return

    const previous = attemptRef.current
    const reusable = Boolean(previous?.ambiguous
      && previous.approvalId === canonical.id
      && previous.decision === decision
      && previous.expectedVersion === canonical.version)
    const currentAttempt: DecisionAttempt = reusable
      ? previous!
      : {
          approvalId: canonical.id,
          decision,
          expectedVersion: canonical.version,
          idempotencyKey: freshIdempotencyKey(),
          ambiguous: false,
        }
    attemptRef.current = currentAttempt
    setDecisionAttempt({ ...currentAttempt })
    decisionPendingRef.current = true
    setDecisionSubmitting(true)
    setDecisionError("")
    setDecisionStatus(`Decision in progress: ${decision === "grant" ? "granting" : "denying"} approval.`)

    try {
      const result = await api.decideApproval(
        currentAttempt.approvalId,
        currentAttempt.decision,
        currentAttempt.expectedVersion,
        currentAttempt.idempotencyKey,
      )
      if (attemptRef.current !== currentAttempt) return
      clearDecisionAttempt()
      setReconciliationFailed(false)
      acceptCanonicalApproval(result.approval, true)
      setDecisionStatus(approvalDecisionLiveStatus(result.approval) ?? "Canonical approval updated.")
      if (decisionDialog) closeDecisionDialog()
    } catch (cause) {
      if (attemptRef.current !== currentAttempt) return
      const conflict = cause instanceof ApiError && cause.status === 409
      const ambiguous = cause instanceof ApiError && cause.code === "request_failed"
      if (conflict) {
        clearDecisionAttempt()
        const hint = canonicalConflictHint(cause.payload, currentAttempt.approvalId)
        if (hint) acceptCanonicalApproval(hint, false)
      } else if (ambiguous) {
        currentAttempt.ambiguous = true
        attemptRef.current = currentAttempt
        setDecisionAttempt({ ...currentAttempt })
      } else {
        clearDecisionAttempt()
      }

      reconcilingRef.current = true
      setDecisionReconciling(true)
      setCanonicalLoaded(null)
      setDecisionStatus("Decision response was not canonical. Reloading approval.")
      const generation = ++detailGeneration.current
      try {
        const reloaded = await api.getApproval(currentAttempt.approvalId)
        if (generation !== detailGeneration.current) return
        acceptCanonicalApproval(reloaded, true)
        setReconciliationFailed(false)
        const samePendingAttempt = ambiguous
          && reloaded.id === currentAttempt.approvalId
          && reloaded.version === currentAttempt.expectedVersion
          && reloaded.state === "pending"
        if (samePendingAttempt) {
          currentAttempt.ambiguous = true
          attemptRef.current = currentAttempt
          setDecisionAttempt({ ...currentAttempt })
          setDecisionError("The request outcome was not confirmed. Canonical approval is still pending; retry will reuse this attempt.")
          setDecisionStatus("Canonical approval is still pending. Retry will reuse the same decision attempt.")
        } else {
          clearDecisionAttempt()
          setDecisionError("")
          setDecisionStatus(approvalDecisionLiveStatus(reloaded) ?? "Canonical approval changed. Review it before starting a new decision attempt.")
          if (decisionDialog) closeDecisionDialog()
        }
      } catch {
        if (generation !== detailGeneration.current) return
        clearDecisionAttempt()
        setCanonicalLoaded(null)
        setReconciliationFailed(true)
        setDecisionError("")
        setDecisionStatus("Canonical reconciliation failed. Reload approval before retrying.")
        if (decisionDialog) closeDecisionDialog()
      } finally {
        reconcilingRef.current = false
        setDecisionReconciling(false)
      }
    } finally {
      decisionPendingRef.current = false
      setDecisionSubmitting(false)
    }
  }

  const requestDecision = (decision: ApprovalDecision) => {
    const canonical = selectedRef.current
    if (!canonical || canonical.state !== "pending") return
    decisionInvokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (decision === "deny" && canonical.risk === "low") {
      void submitDecision(decision)
      return
    }
    setDecisionError("")
    setDecisionDialog({ approvalId: canonical.id, decision, expectedVersion: canonical.version })
  }

  const showDecisionControls = Boolean(selected
    && selected.state === "pending"
    && session.approvalState.canDecide
    && selected.permissions.canDecide)
  const decisionControlsDisabled = !session.approvalState.producing
    || connection !== "live"
    || !canonicalReady
    || decisionSubmitting
    || decisionReconciling
    || reconciliationFailed
  const decisionGuidance = reconciliationFailed
    ? "Reload approval before retrying."
    : !session.approvalState.producing
      ? "Core approval production is off; decisions are disabled."
      : connection !== "live"
        ? "Reconnect to decide this approval."
        : decisionSubmitting
          ? "Decision in progress. Approval controls are disabled."
          : decisionReconciling || !canonicalReady
            ? "Reloading canonical approval before decisions are enabled."
            : decisionAttempt?.ambiguous
              ? "Canonical approval is still pending. A matching retry will reuse the same attempt."
              : ""
  const dialogApproval = decisionDialog
    && selected
    && selected.id === decisionDialog.approvalId
    && selected.version === decisionDialog.expectedVersion
    && selected.state === "pending"
    && (canonicalReady || decisionSubmitting || decisionReconciling)
    ? selected
    : null
  const hiddenDetail = layout !== "desktop" && !activeApproval
  return <main className="approvals-shell" data-layout={layout} data-mobile-pane={activeApproval ? "detail" : "list"}>
    <span className="sr-only" aria-live="polite">{connection === "live" ? `${pendingCount} approvals pending.` : `Approval updates ${connection}.`}</span>
    <span className="sr-only" role={decisionStatus ? "status" : undefined} aria-live="polite" aria-label="Approval decision status">{decisionStatus}</span>
    <AppRail active="approvals" features={destinationFeatures} pendingApprovals={pendingCount} connection={connection} install={install} onNew={onNewConversation} onNavigate={destination => onNavigate(destination)} />
    <ApprovalList items={items} selectedId={activeApproval} filters={filters} now={now} pendingCount={pendingCount} loading={loading} error={loadError} connection={connection} nextCursor={nextCursor} loadingMore={loadingMore} onFiltersChange={changeFilters} onSelect={selectApproval} onLoadMore={() => { if (nextCursor) void loadList(true, nextCursor) }} rowRef={registerRow} />
    <ApprovalDetail approval={selected} loading={detailLoading} error={selectedError} hidden={hiddenDetail} producing={session.approvalState.producing} connection={connection} closeRef={detailCloseRef} focusRef={detailFocusRef} decisionControls={showDecisionControls ? { disabled: decisionControlsDisabled, guidance: decisionGuidance, onDecision: requestDecision } : undefined} onBack={showList} onConversation={conversationId => onNavigate("conversations", conversationId)} />
    <DestinationMobileNav active="approvals" features={destinationFeatures} pendingApprovals={pendingCount} onNavigate={destination => onNavigate(destination)} />
    {dialogApproval && decisionDialog ? <ApprovalDecisionDialog approval={dialogApproval} decision={decisionDialog.decision} submitting={decisionSubmitting || decisionReconciling} error={decisionError} onCancel={() => { setDecisionDialog(null); setDecisionError("") }} onConfirm={() => { void submitDecision(decisionDialog.decision) }} /> : null}
  </main>
}
