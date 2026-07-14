import { useEffect, useState, type KeyboardEvent, type Ref } from "react"
import type { AgentDetail as AgentDetailValue, ConnectionState, Session } from "../types"
import { AgentActionDialog, type AgentActionApi, type AgentProtectedAction } from "./AgentActionDialog"
import { AgentConfigEditor, type AgentConfigApi } from "./AgentConfigEditor"

const statusLabel = (status: AgentDetailValue["status"]) => status === "busy" ? "Busy" : status === "idle" ? "Idle" : "Offline"
type AgentTab = "overview" | "sessions" | "configuration" | "activity"
const tabs: Array<{ id: AgentTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "sessions", label: "Sessions" },
  { id: "configuration", label: "Configuration" },
  { id: "activity", label: "Activity" },
]

export function AgentDetail({ agent, connection, sessionPermission, api, loading = false, error, hidden = false, closeRef, onBack, onReload, onAnnounce }: {
  agent: AgentDetailValue | null
  connection: ConnectionState
  sessionPermission: Session["permissions"]["agents"]
  api: AgentConfigApi & AgentActionApi
  loading?: boolean
  error?: "forbidden" | "not_found" | "unavailable" | null
  hidden?: boolean
  closeRef?: Ref<HTMLButtonElement>
  onBack(): void
  onReload(): void
  onAnnounce(message: string): void
}) {
  const [tab, setTab] = useState<AgentTab>("overview")
  const [action, setAction] = useState<AgentProtectedAction | null>(null)
  const open = Boolean(agent) || loading || Boolean(error)
  const operator = sessionPermission === "operator"
  const online = connection === "live"
  useEffect(() => { setTab("overview"); setAction(null) }, [agent?.name])

  const success = (message: string) => { setAction(null); onAnnounce(message); onReload() }
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = tabs.length - 1
    else return
    event.preventDefault()
    const nextTab = tabs[next]!
    setTab(nextTab.id)
    document.getElementById(`agent-tab-${nextTab.id}`)?.focus()
  }
  return <section className="agent-detail" aria-label="Agent detail" aria-hidden={hidden} data-open={open} onKeyDown={event => { if (event.key === "Escape" && open && !action) { event.stopPropagation(); onBack() } }}>
    {loading ? <div className="agent-detail-state" role="status">Loading agent…</div> : error ? <div className="agent-detail-state" role="alert"><h2>{error === "forbidden" ? "Agent access denied" : error === "not_found" ? "Agent not found" : "Agent unavailable"}</h2><p>{error === "forbidden" ? "Your identity cannot view this agent." : error === "not_found" ? "This agent no longer exists or its name changed." : "Check the service connection, then try again."}</p><button type="button" onClick={onBack}>Back to agents</button></div> : agent ? <>
      <header className="agent-detail-header">
        <button ref={closeRef} className="agent-back" type="button" onClick={onBack}>Back to agents</button>
        <div><p className="eyebrow">{agent.mode} agent</p><h2>{agent.name}</h2><p>{agent.description}</p></div>
        <div className="agent-live-state" data-status={agent.status}><span className="agent-live-trace" aria-hidden="true"><i /></span><strong>{statusLabel(agent.status)}</strong><small>{connection === "live" ? "Live telemetry" : connection}</small></div>
      </header>
      <div className="agent-detail-scroll">
        <nav className="agent-tabs" role="tablist" aria-label="Agent detail sections">{tabs.map((item, index) => <button key={item.id} id={`agent-tab-${item.id}`} type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls={`agent-panel-${item.id}`} onClick={() => setTab(item.id)} onKeyDown={event => tabKeyDown(event, index)}>{item.label}</button>)}</nav>
        <div id="agent-panel-overview" role="tabpanel" aria-labelledby="agent-tab-overview" hidden={tab !== "overview"}>
            {agent.currentWork ? <section className="current-work" aria-labelledby="current-work-heading"><div><p className="eyebrow">Current work</p><h3 id="current-work-heading">{agent.currentWork.goal}</h3></div><span>{agent.currentWork.state} · round {agent.currentWork.round}/{agent.currentWork.max}</span></section> : null}
            <section className="agent-section" aria-labelledby="agent-overview"><header><p className="eyebrow">Overview</p><h3 id="agent-overview">Runtime signal</h3></header><dl className="agent-facts">
              <div><dt>Status</dt><dd>{statusLabel(agent.status)}</dd></div><div><dt>Model</dt><dd>{agent.model ?? "Default"}</dd></div><div><dt>Version</dt><dd>{agent.version}</dd></div><div><dt>Context</dt><dd>{`${Number((agent.contextFill * 100).toFixed(1))}%`}</dd></div><div><dt>Queue</dt><dd>{agent.queueDepth}</dd></div><div><dt>Cost</dt><dd>${agent.costUsd.toFixed(2)}</dd></div>
            </dl></section>
            {operator && (agent.permissions.reset || agent.permissions.restart || agent.permissions.remove) ? <section className="agent-section agent-runtime-controls" aria-labelledby="agent-controls"><header><p className="eyebrow">Protected actions</p><h3 id="agent-controls">Runtime controls</h3></header><div>
              {agent.permissions.reset ? <button type="button" disabled={!online} onClick={() => setAction("reset")}>Reset agent</button> : null}
              {agent.permissions.restart ? <button type="button" disabled={!online} onClick={() => setAction("restart")}>Restart agent</button> : null}
              {agent.permissions.remove ? <button type="button" className="danger-text" disabled={!online} onClick={() => setAction("remove")}>Remove agent</button> : null}
            </div>{!online ? <p>Reconnect to preview runtime impact.</p> : null}</section> : null}
        </div>
        <div id="agent-panel-sessions" role="tabpanel" aria-labelledby="agent-tab-sessions" hidden={tab !== "sessions"}><section className="agent-section" aria-labelledby="agent-sessions"><header><p className="eyebrow">Sessions</p><h3 id="agent-sessions">Execution</h3></header><dl className="agent-facts">
            <div><dt>Replicas</dt><dd>{agent.replicas}</dd></div><div><dt>Working directory</dt><dd>{agent.config.runtime.cwd}</dd></div><div><dt>Current tool</dt><dd>{agent.currentTool ?? "None"}</dd></div><div><dt>Last tool</dt><dd>{agent.lastTool?.name ?? "None"}</dd></div>
          </dl></section></div>
        <div id="agent-panel-configuration" role="tabpanel" aria-labelledby="agent-tab-configuration" hidden={tab !== "configuration"}>{operator && agent.permissions.configure ? <AgentConfigEditor agent={agent.name} config={agent.config} baseVersion={agent.version} api={api} online={online} onApplied={result => { onAnnounce(result.fullRestart.length ? `${agent.name} configuration saved pending hub restart.` : `${agent.name} configuration applied.`); onReload() }} onReload={onReload} /> : <section className="agent-section"><header><p className="eyebrow">Configuration</p><h3>Current sanitized configuration</h3></header><pre className="readonly-config">{JSON.stringify(agent.config, null, 2)}</pre></section>}</div>
        <div id="agent-panel-activity" role="tabpanel" aria-labelledby="agent-tab-activity" hidden={tab !== "activity"}><section className="agent-section agent-activity" aria-labelledby="agent-activity"><header><p className="eyebrow">Activity</p><h3 id="agent-activity">Available events</h3></header><ol><li><span>Runtime status</span><strong>{statusLabel(agent.status)}</strong></li><li><span>Configuration snapshot</span><strong>{agent.version}</strong></li>{agent.lastTool ? <li><span>Last tool invocation</span><strong>{agent.lastTool.name}</strong></li> : null}</ol><p className="operations-notice">Tool and audit history is coming in the Operations vertical.</p></section></div>
      </div>
      {action ? <AgentActionDialog agent={agent.name} action={action} api={api} online={online} onCancel={() => setAction(null)} onSuccess={success} /> : null}
    </> : <div className="agent-detail-empty"><span className="signal-map" aria-hidden="true"><i /></span><h2>Select an agent</h2><p>Choose an agent to inspect its health, work, and sessions.</p></div>}
  </section>
}
