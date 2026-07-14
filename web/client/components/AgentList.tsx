import { useMemo, type Ref } from "react"
import type { AgentSummary } from "../types"

const statusLabel = (status: AgentSummary["status"]) => status === "busy" ? "Busy" : status === "idle" ? "Idle" : "Offline"

export function AgentList({ agents, selected, query, onQueryChange, onSelect, rowRef }: {
  agents: AgentSummary[]
  selected: string | null
  query: string
  onQueryChange(value: string): void
  onSelect(agent: AgentSummary): void
  rowRef?(name: string, element: HTMLButtonElement | null): void
}) {
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle ? agents.filter(agent => `${agent.name} ${agent.description} ${statusLabel(agent.status)}`.toLocaleLowerCase().includes(needle)) : agents
  }, [agents, query])

  return <nav className="agent-list" aria-label="Agent navigation">
    <header className="list-header"><div><p className="eyebrow">Operations</p><h1>Agents</h1></div><span className="agent-count">{agents.length} known</span></header>
    <label className="search-field"><span className="sr-only">Search agents</span><span aria-hidden="true">⌕</span><input type="search" aria-label="Search agents" placeholder="Search agents" value={query} onChange={event => onQueryChange(event.currentTarget.value)} /></label>
    {filtered.length ? <ul className="agent-items" aria-label="Agents">
      {filtered.map(agent => <li key={agent.name}>
        <button ref={element => rowRef?.(agent.name, element)} type="button" className="agent-item" data-active={selected === agent.name} data-status={agent.status} aria-pressed={selected === agent.name} aria-label={`Open ${agent.name}`} onClick={() => onSelect(agent)}>
          <span className="agent-telemetry" aria-hidden="true"><i /></span>
          <span className="agent-copy"><span className="agent-name"><b aria-hidden="true">{agent.emoji}</b><strong>{agent.name}</strong></span><small>{agent.description}</small></span>
          <span className="agent-state"><span>{statusLabel(agent.status)}</span><small>{agent.queueDepth ? `${agent.queueDepth} queued` : "Queue clear"}</small></span>
        </button>
      </li>)}
    </ul> : <div className="empty-state compact"><h2>{agents.length ? "No matching agents" : "No agents available"}</h2><p>{agents.length ? "Try a different name, description, or status." : "No agents are registered with this Switchboard."}</p></div>}
  </nav>
}
