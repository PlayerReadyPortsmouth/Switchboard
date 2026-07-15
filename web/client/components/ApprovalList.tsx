import type { Ref } from "react"
import type { ApprovalRisk, ApprovalState, ApprovalSummary, ConnectionState } from "../types"

export interface ApprovalFilterState {
  group: "pending" | "history"
  search: string
  risk: ApprovalRisk | ""
  kind: string
  requester: string
  state: ApprovalState | ""
  conversationId: string
  createdFrom: string
  createdTo: string
  decisionFrom: string
  decisionTo: string
}

export type ApprovalListError = "forbidden" | "unavailable" | null

const titleCase = (value: string): string => value.replaceAll("_", " ").replace(/^./, first => first.toUpperCase())

const absoluteTime = (timestamp: number): string => new Date(timestamp).toLocaleString([], {
  dateStyle: "medium",
  timeStyle: "short",
})

function expiryCopy(expiresAt: number, now: number): string {
  const remaining = expiresAt - now
  if (remaining <= 0) return "Expired"
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  if (minutes < 60) return `Expires in ${minutes} min`
  const hours = Math.ceil(minutes / 60)
  return `Expires in ${hours} hr`
}

export function ApprovalList({
  items,
  selectedId,
  filters,
  now,
  pendingCount,
  loading,
  error,
  connection,
  nextCursor,
  loadingMore,
  onFiltersChange,
  onSelect,
  onLoadMore,
  rowRef,
}: {
  items: ApprovalSummary[]
  selectedId: string | null
  filters: ApprovalFilterState
  now: number
  pendingCount: number
  loading: boolean
  error: ApprovalListError
  connection: ConnectionState
  nextCursor: string | null
  loadingMore: boolean
  onFiltersChange(next: ApprovalFilterState): void
  onSelect(approval: ApprovalSummary): void
  onLoadMore(): void
  rowRef?(id: string, element: HTMLButtonElement | null): void
}) {
  const patch = (next: Partial<ApprovalFilterState>) => onFiltersChange({ ...filters, ...next })
  const emptyHeading = filters.group === "pending" ? "No pending approvals" : "No approval history"
  const emptyCopy = filters.search || filters.risk || filters.kind || filters.requester || filters.state
    ? "No approvals match the active queue filters."
    : filters.group === "pending"
      ? "Requests that need review will appear here."
      : "Completed and expired requests will appear here."

  return <section className="approval-list" aria-label="Approval queue">
    <header className="approval-list-header">
      <div><p className="eyebrow">Operations</p><h1>Approvals</h1></div>
      <span className="approval-count">{pendingCount} pending</span>
    </header>

    <div className="approval-group-tabs" role="tablist" aria-label="Approval groups">
      <button type="button" role="tab" aria-selected={filters.group === "pending"} aria-controls="approval-results" onClick={() => patch({ group: "pending" })}>Pending</button>
      <button type="button" role="tab" aria-selected={filters.group === "history"} aria-controls="approval-results" onClick={() => patch({ group: "history" })}>History</button>
    </div>

    <form className="approval-search" role="search" aria-label="Approval search" onSubmit={event => event.preventDefault()}>
      <label><span className="sr-only">Search approvals</span><span aria-hidden="true">⌕</span><input type="search" aria-label="Search approvals" placeholder="Search approvals" value={filters.search} onChange={event => patch({ search: event.currentTarget.value })} /></label>
    </form>

    {filters.conversationId ? <div className="approval-conversation-filter"><span>Conversation</span><code>{filters.conversationId}</code><button type="button" aria-label={`Clear conversation filter ${filters.conversationId}`} onClick={() => patch({ conversationId: "" })}>×</button></div> : null}

    <details className="approval-filters">
      <summary>Filters</summary>
      <div className="approval-filter-grid">
        <label>Risk<select aria-label="Risk" value={filters.risk} onChange={event => patch({ risk: event.currentTarget.value as ApprovalRisk | "" })}><option value="">All risks</option><option value="low">Low</option><option value="elevated">Elevated</option><option value="destructive">Destructive</option></select></label>
        <label>Kind<input aria-label="Kind" value={filters.kind} onChange={event => patch({ kind: event.currentTarget.value })} /></label>
        <label>Requester<input aria-label="Requester" value={filters.requester} onChange={event => patch({ requester: event.currentTarget.value })} /></label>
        <label>State<select aria-label="State" value={filters.state} onChange={event => patch({ state: event.currentTarget.value as ApprovalState | "" })}><option value="">All states</option><option value="pending">Pending</option><option value="granted">Granted</option><option value="denied">Denied</option><option value="expired">Expired</option><option value="interrupted">Interrupted</option></select></label>
        <label>Created from<input type="datetime-local" aria-label="Created from" value={filters.createdFrom} onChange={event => patch({ createdFrom: event.currentTarget.value })} /></label>
        <label>Created to<input type="datetime-local" aria-label="Created to" value={filters.createdTo} onChange={event => patch({ createdTo: event.currentTarget.value })} /></label>
        <label>Decision from<input type="datetime-local" aria-label="Decision from" value={filters.decisionFrom} onChange={event => patch({ decisionFrom: event.currentTarget.value })} /></label>
        <label>Decision to<input type="datetime-local" aria-label="Decision to" value={filters.decisionTo} onChange={event => patch({ decisionTo: event.currentTarget.value })} /></label>
      </div>
    </details>

    <div id="approval-results" className="approval-results">
      {loading ? <div className="approval-list-state" role="status">Loading approvals…</div> : error ? <div className="approval-list-state" role="alert"><h2>{error === "forbidden" ? "Approval access denied" : connection === "offline" ? "Approvals are unavailable offline" : "Approvals are unavailable"}</h2><p>{error === "forbidden" ? "Ask a Switchboard administrator to grant approval access." : "Reconnect to Switchboard, then try again."}</p></div> : items.length ? <ul className="approval-items" aria-label="Approvals">
        {items.map(item => <li key={item.id}>
          <button
            ref={element => rowRef?.(item.id, element)}
            type="button"
            className="approval-item"
            data-active={selectedId === item.id}
            data-risk={item.risk}
            aria-pressed={selectedId === item.id}
            aria-label={`Open approval ${item.summary}`}
            onClick={() => onSelect(item)}
          >
            <span className="approval-trace" aria-hidden="true"><i /></span>
            <span className="approval-copy"><strong>{item.summary}</strong><small>{item.target}</small><span><b>{titleCase(item.risk)} risk</b><span>{item.kind}</span></span></span>
            <span className="approval-row-state">
              {filters.group === "pending" ? <><strong>{titleCase(item.state)}</strong><time dateTime={new Date(item.expiresAt).toISOString()} title={absoluteTime(item.expiresAt)}>{expiryCopy(item.expiresAt, now)}</time></> : <><strong>{titleCase(item.state)}</strong><span>Execution: {titleCase(item.execution)}</span><time dateTime={new Date(item.terminalAt ?? item.createdAt).toISOString()}>{absoluteTime(item.terminalAt ?? item.createdAt)}</time></>}
            </span>
          </button>
        </li>)}
      </ul> : <div className="approval-list-state approval-empty"><h2>{emptyHeading}</h2><p>{emptyCopy}</p></div>}
      {!loading && !error && nextCursor ? <button className="approval-load-more" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading…" : "Load more"}</button> : null}
    </div>
  </section>
}
