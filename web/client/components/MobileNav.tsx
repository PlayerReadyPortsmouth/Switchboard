export type MobilePane = "conversations" | "transcript" | "inspector"

export function MobileNav({ pane, hasConversation, onChange }: { pane: MobilePane; hasConversation: boolean; onChange(pane: MobilePane, trigger: HTMLButtonElement): void }) {
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      <button type="button" aria-current={pane === "conversations" ? "page" : undefined} onClick={event => onChange("conversations", event.currentTarget)}>Conversations</button>
      <button type="button" aria-current={pane === "transcript" ? "page" : undefined} disabled={!hasConversation} onClick={event => onChange("transcript", event.currentTarget)}>Workspace</button>
      <button type="button" aria-current={pane === "inspector" ? "page" : undefined} disabled={!hasConversation} onClick={event => onChange("inspector", event.currentTarget)}>Details</button>
    </nav>
  )
}
