import type { Conversation, Session } from "../types"

export function Inspector({ conversation, session, open, onClose }: { conversation: Conversation | null; session: Session; open: boolean; onClose(): void }) {
  return (
    <aside className="inspector" role="region" data-open={open} aria-label="Conversation inspector" data-region="conversation-inspector">
      <header className="pane-header inspector-header">
        <div><p className="eyebrow">Context</p><h2>Conversation details</h2></div>
        <button className="drawer-close" type="button" onClick={onClose} aria-label="Close conversation details">×</button>
      </header>
      {conversation ? (
        <dl className="inspector-details">
          <div><dt>Primary agent</dt><dd>{conversation.primaryAgent}</dd></div>
          <div><dt>Owner</dt><dd>{conversation.createdBy}</dd></div>
          <div><dt>Workspace identity</dt><dd>{session.identity}</dd></div>
        </dl>
      ) : <p className="pane-guidance">Open a conversation to see its details.</p>}
    </aside>
  )
}
