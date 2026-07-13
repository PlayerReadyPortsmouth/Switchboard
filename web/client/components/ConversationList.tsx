import { useMemo, useState, type Ref } from "react"
import type { Conversation } from "../types"

interface ConversationListProps {
  conversations: Conversation[]
  selectedId: string | null
  open: boolean
  closeDisabled: boolean
  searchRef?: Ref<HTMLInputElement>
  closeRef?: Ref<HTMLButtonElement>
  onEscape?(): void
  onNew(): void
  onSelect(conversation: Conversation, trigger: HTMLButtonElement): void
  onClose(): void
}

const relativeTime = (timestamp: number) => {
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return "just now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)
}

export function ConversationList({ conversations, selectedId, open, closeDisabled, searchRef, closeRef, onEscape, onNew, onSelect, onClose }: ConversationListProps) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle ? conversations.filter(item => item.title.toLocaleLowerCase().includes(needle)) : conversations
  }, [conversations, query])

  return (
    <nav className="conversation-list" data-open={open} aria-label="Conversation navigation" data-region="conversation-navigation" onKeyDown={event => {
      if (event.key === "Escape" && onEscape) { event.preventDefault(); onEscape() }
    }}>
      <header className="list-header">
        <div><p className="eyebrow">Workspace</p><h1>Switchboard</h1></div>
        <button ref={closeRef} className="drawer-close" type="button" disabled={closeDisabled} onClick={onClose} aria-label="Close conversations">×</button>
      </header>
      <label className="search-field">
        <span className="sr-only">Search conversations</span>
        <span aria-hidden="true">⌕</span>
        <input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="Search conversations" aria-label="Search conversations" />
      </label>
      <div className="conversation-items">
        {filtered.map(item => (
          <button
            key={item.id}
            type="button"
            className="conversation-item"
            data-active={item.id === selectedId}
            aria-pressed={item.id === selectedId}
            onClick={event => onSelect(item, event.currentTarget)}
          >
            <span className="signal-trace" aria-hidden="true"><i /></span>
            <span className="conversation-copy"><strong>{item.title}</strong><small>{item.primaryAgent} · {relativeTime(item.updatedAt)}</small></span>
          </button>
        ))}
        {conversations.length === 0 ? (
          <div className="empty-state">
            <h2>No conversations yet</h2>
            <p>Create a conversation to start working with an agent.</p>
            <button type="button" onClick={onNew}>New conversation</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state compact"><h2>No matches</h2><p>Try a different conversation title.</p></div>
        ) : null}
      </div>
    </nav>
  )
}
