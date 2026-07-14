import type { Ref } from "react"
import type { AgentDetail as AgentDetailValue, ConnectionState, Session } from "../types"

const statusLabel = (status: AgentDetailValue["status"]) => status === "busy" ? "Busy" : status === "idle" ? "Idle" : "Offline"

export function AgentDetail({ agent, connection, sessionPermission, loading = false, error, hidden = false, closeRef, onBack }: {
  agent: AgentDetailValue | null
  connection: ConnectionState
  sessionPermission: Session["permissions"]["agents"]
  loading?: boolean
  error?: "forbidden" | "not_found" | "unavailable" | null
  hidden?: boolean
  closeRef?: Ref<HTMLButtonElement>
  onBack(): void
}) {
  const open = Boolean(agent) || loading || Boolean(error)
  const previewPermissions = sessionPermission === "operator" ? agent?.permissions : null
  return <section className="agent-detail" aria-label="Agent detail" aria-hidden={hidden} data-open={open} onKeyDown={event => { if (event.key === "Escape" && open) { event.stopPropagation(); onBack() } }}>
    {loading ? <div className="agent-detail-state" role="status">Loading agent…</div> : error ? <div className="agent-detail-state" role="alert"><h2>{error === "forbidden" ? "Agent access denied" : error === "not_found" ? "Agent not found" : "Agent unavailable"}</h2><p>{error === "forbidden" ? "Your identity cannot view this agent." : error === "not_found" ? "This agent no longer exists or its name changed." : "Check the service connection, then try again."}</p><button type="button" onClick={onBack}>Back to agents</button></div> : agent ? <>
      <header className="agent-detail-header">
        <button ref={closeRef} className="agent-back" type="button" onClick={onBack}>Back to agents</button>
        <div><p className="eyebrow">{agent.mode} agent</p><h2>{agent.name}</h2><p>{agent.description}</p></div>
        <div className="agent-live-state" data-status={agent.status}><span className="agent-live-trace" aria-hidden="true"><i /></span><strong>{statusLabel(agent.status)}</strong><small>{connection === "live" ? "Live telemetry" : connection}</small></div>
      </header>
      <div className="agent-detail-scroll">
        {agent.currentWork ? <section className="current-work" aria-labelledby="current-work-heading"><div><p className="eyebrow">Current work</p><h3 id="current-work-heading">{agent.currentWork.goal}</h3></div><span>{agent.currentWork.state} · round {agent.currentWork.round}/{agent.currentWork.max}</span></section> : null}
        <section className="agent-section" aria-labelledby="agent-overview"><header><p className="eyebrow">Overview</p><h3 id="agent-overview">Runtime signal</h3></header><dl className="agent-facts">
          <div><dt>Status</dt><dd>{statusLabel(agent.status)}</dd></div><div><dt>Model</dt><dd>{agent.model ?? "Default"}</dd></div><div><dt>Version</dt><dd>{agent.version}</dd></div><div><dt>Context</dt><dd>{agent.contextFill}%</dd></div><div><dt>Queue</dt><dd>{agent.queueDepth}</dd></div><div><dt>Cost</dt><dd>${agent.costUsd.toFixed(2)}</dd></div>
        </dl></section>
        <section className="agent-section" aria-labelledby="agent-sessions"><header><p className="eyebrow">Sessions</p><h3 id="agent-sessions">Execution</h3></header><dl className="agent-facts">
          <div><dt>Replicas</dt><dd>{agent.replicas}</dd></div><div><dt>Working directory</dt><dd>{agent.config.runtime.cwd}</dd></div><div><dt>Current tool</dt><dd>{agent.currentTool ?? "None"}</dd></div><div><dt>Last tool</dt><dd>{agent.lastTool?.name ?? "None"}</dd></div>
        </dl></section>
        {previewPermissions && (previewPermissions.configure || previewPermissions.reset || previewPermissions.restart) ? <section className="agent-section agent-action-preview" aria-labelledby="agent-controls"><header><p className="eyebrow">Controls</p><h3 id="agent-controls">Available after preview</h3></header><div>
          {previewPermissions.configure ? <button type="button" disabled aria-label="Configure agent">Configure</button> : null}
          {previewPermissions.reset ? <button type="button" disabled aria-label="Reset agent">Reset</button> : null}
          {previewPermissions.restart ? <button type="button" disabled aria-label="Restart agent">Restart</button> : null}
        </div></section> : null}
      </div>
    </> : <div className="agent-detail-empty"><span className="signal-map" aria-hidden="true"><i /></span><h2>Select an agent</h2><p>Choose an agent to inspect its health, work, and sessions.</p></div>}
  </section>
}
