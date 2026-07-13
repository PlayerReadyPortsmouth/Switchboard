import type { KeyboardEvent, Ref } from "react"
import type { Conversation, Session, TransportLink } from "../types"

const syncLabels = { two_way: "Two-way sync", inbound_only: "Inbound only", outbound_only: "Outbound only", notifications_only: "Notifications only" } as const
const formatted = (value: number) => new Date(value).toLocaleString()

export function Inspector({ conversation, session, links = [], open, closeRef, onClose, onEscape, onPrimaryAgentChange }: { conversation: Conversation | null; session: Session; links?: TransportLink[]; open: boolean; closeRef?: Ref<HTMLButtonElement>; onClose(): void; onEscape?(): void; onPrimaryAgentChange?(agent: string): void }) {
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && onEscape) { event.preventDefault(); onEscape(); return }
    if (event.key !== "Tab" || !onEscape) return
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    if (!focusable.length) return
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return (
    <aside className="inspector" role="region" data-open={open} aria-label="Conversation inspector" data-region="conversation-inspector" onKeyDown={keyDown}>
      <header className="pane-header inspector-header">
        <div><p className="eyebrow">Context</p><h2>Conversation details</h2></div>
        <button ref={closeRef} className="drawer-close" type="button" onClick={onClose} aria-label="Close conversation details">×</button>
      </header>
      {conversation ? (
        <div className="inspector-content">
        <label className="inspector-agent">Primary agent<select aria-label="Primary agent" value={conversation.primaryAgent} disabled={!onPrimaryAgentChange} onChange={event => onPrimaryAgentChange?.(event.currentTarget.value)}>{session.agents.map(agent => <option key={agent.name} value={agent.name}>{agent.name}{!agent.alive ? " — unavailable" : agent.busy ? " — busy" : ""}</option>)}</select></label>
        <dl className="inspector-details">
          <div><dt>Owner</dt><dd>{conversation.createdBy}</dd></div>
          <div><dt>Workspace identity</dt><dd>{session.identity}</dd></div>
          <div><dt>Created</dt><dd><time dateTime={new Date(conversation.createdAt).toISOString()}>{formatted(conversation.createdAt)}</time></dd></div>
          <div><dt>Updated</dt><dd><time dateTime={new Date(conversation.updatedAt).toISOString()}>{formatted(conversation.updatedAt)}</time></dd></div>
        </dl>
        <section className="linked-surfaces" aria-labelledby="linked-surfaces-title"><h3 id="linked-surfaces-title">Linked surfaces</h3>{links.length ? <ul>{links.map(link => <li key={link.id}><strong>{link.label?.trim() || link.adapter}</strong><span>{link.adapter}</span><span>{syncLabels[link.syncMode]}</span><span>{link.enabled ? "Enabled" : "Disabled"}</span><small>Created {formatted(link.createdAt)} · Updated {formatted(link.updatedAt)}</small></li>)}</ul> : <p>No linked surfaces.</p>}</section>
        </div>
      ) : <p className="pane-guidance">Open a conversation to see its details.</p>}
    </aside>
  )
}
