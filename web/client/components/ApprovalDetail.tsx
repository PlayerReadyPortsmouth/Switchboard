import type { KeyboardEvent, Ref } from "react"
import { pathForConversation } from "../routes"
import type { ApprovalDetail as ApprovalDetailValue, ConnectionState, SafeValue } from "../types"

export type ApprovalDetailError = "forbidden" | "not_found" | "unavailable" | null

const titleCase = (value: string): string => value.replaceAll("_", " ").replace(/^./, first => first.toUpperCase())
const absoluteTime = (timestamp: number): string => new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

function Timestamp({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{absoluteTime(value)}</time>
}

function SafeValueView({ value }: { value: SafeValue }) {
  if (value === null) return <span className="approval-safe-null">null</span>
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <span className="approval-safe-scalar">{String(value)}</span>
  if (Array.isArray(value)) return <ol className="approval-safe-list">{value.map((item, index) => <li key={index}><SafeValueView value={item} /></li>)}</ol>
  return <dl className="approval-safe-object">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><SafeValueView value={item} /></dd></div>)}</dl>
}

export function ApprovalDetail({ approval, loading, error, hidden, producing, connection, closeRef, onBack, onConversation }: {
  approval: ApprovalDetailValue | null
  loading: boolean
  error: ApprovalDetailError
  hidden: boolean
  producing: boolean
  connection: ConnectionState
  closeRef?: Ref<HTMLButtonElement>
  onBack(): void
  onConversation(conversationId: string): void
}) {
  const open = Boolean(approval) || loading || Boolean(error)
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return
    event.stopPropagation()
    onBack()
  }

  return <section className="approval-detail" aria-label="Approval detail" aria-hidden={hidden} inert={hidden ? true : undefined} data-open={open} onKeyDown={handleKeyDown}>
    {!producing ? <div className="approval-core-notice" role="status"><strong>Core approval production is off</strong><span>Existing approval history remains available, but new approval production and decisions are disabled.</span></div> : null}
    {loading ? <div className="approval-detail-state" role="status">Loading approval…</div> : error ? <div className="approval-detail-state" role="alert"><h2>{error === "forbidden" ? "Approval access denied" : error === "not_found" ? "Approval not found" : connection === "offline" ? "Approval unavailable offline" : "Approval unavailable"}</h2><p>{error === "forbidden" ? "Your identity cannot view this approval." : error === "not_found" ? "This approval no longer exists or is outside the visible history window." : "Reconnect to Switchboard, then try again."}</p><button type="button" onClick={onBack}>Back to approvals</button></div> : approval ? <>
      <header className="approval-detail-header">
        <button ref={closeRef} className="approval-back" type="button" onClick={onBack}>Back to approvals</button>
        <div><p className="eyebrow">Exact effect record</p><h2>{approval.summary}</h2><p className="approval-target">{approval.target}</p></div>
        <div className="approval-risk-mark" data-risk={approval.risk}><span className="approval-live-trace" aria-hidden="true"><i /></span><strong>{titleCase(approval.risk)} risk</strong><small>{titleCase(approval.state)}</small></div>
      </header>
      <div className="approval-detail-scroll">
        <section className="approval-detail-section" aria-labelledby="approval-request-heading"><header><p className="eyebrow">Request</p><h3 id="approval-request-heading">Requested operation</h3></header><dl className="approval-facts">
          <div><dt>Kind</dt><dd>{approval.kind}</dd></div>
          <div><dt>Requested by</dt><dd className="approval-principal">{approval.requestedBy.surface}:{approval.requestedBy.id}</dd></div>
          <div><dt>Created</dt><dd><Timestamp value={approval.createdAt} /></dd></div>
          <div><dt>Expires</dt><dd><Timestamp value={approval.expiresAt} /></dd></div>
          {approval.terminalAt !== null ? <div><dt>Terminal</dt><dd><Timestamp value={approval.terminalAt} /></dd></div> : null}
          {approval.conversationId ? <div><dt>Conversation</dt><dd><a href={pathForConversation(approval.conversationId)} onClick={event => { event.preventDefault(); onConversation(approval.conversationId!) }}>Open conversation</a></dd></div> : null}
        </dl></section>

        <section className="approval-detail-section approval-safe-value" aria-labelledby="approval-effect-heading"><header><p className="eyebrow">Sanitized evidence</p><h3 id="approval-effect-heading">Exact effect</h3></header><SafeValueView value={approval.detail} /></section>

        <section className="approval-detail-section" aria-labelledby="approval-lifecycle-heading"><header><p className="eyebrow">Lifecycle</p><h3 id="approval-lifecycle-heading">Decision and execution</h3></header><ol className="approval-lifecycle">
          <li data-stage="request"><span aria-hidden="true"><i /></span><div><strong>Requested</strong><small><Timestamp value={approval.createdAt} /> · {approval.requestedBy.surface}:{approval.requestedBy.id}</small></div></li>
          <li data-stage="decision"><span aria-hidden="true"><i /></span><div><strong>{approval.decisionBy ? titleCase(approval.state) : "Awaiting decision"}</strong><small>{approval.decisionBy ? <>{approval.decisionBy.surface}:{approval.decisionBy.id}{approval.decisionAt !== null ? <> · <Timestamp value={approval.decisionAt} /></> : null}</> : "No decision recorded"}</small>{approval.outcomeReason ? <p>{approval.outcomeReason}</p> : null}</div></li>
          <li data-stage="execution"><span aria-hidden="true"><i /></span><div><strong>Execution: {titleCase(approval.execution)}</strong>{approval.executionDetail !== null ? <SafeValueView value={approval.executionDetail} /> : <small>No execution detail recorded</small>}</div></li>
        </ol></section>

        {approval.audit.length ? <section className="approval-detail-section" aria-labelledby="approval-audit-heading"><header><p className="eyebrow">Audit</p><h3 id="approval-audit-heading">Related activity</h3></header><ol className="approval-audit">{approval.audit.map((item, index) => <li key={`${item.ts}-${index}`}><Timestamp value={item.ts} /><span>{item.actor}</span><strong>{item.action}</strong><span>{item.outcome}</span></li>)}</ol></section> : null}
      </div>
    </> : <div className="approval-detail-empty"><span className="signal-map" aria-hidden="true"><i /></span><h2>Select an approval</h2><p>Choose a request to inspect its exact effect, lifecycle, and sanitized audit record.</p></div>}
  </section>
}
