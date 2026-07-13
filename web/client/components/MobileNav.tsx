export type MobilePane = "conversations" | "transcript" | "inspector"

export function MobileNav({ pane, hasConversation, onChange }: { pane: MobilePane; hasConversation: boolean; onChange(pane: MobilePane): void }) {
  return (
    <nav className="mobile-nav" aria-label="Mobile workspace navigation">
      <button type="button" aria-current={pane === "conversations" ? "page" : undefined} onClick={() => onChange("conversations")}>Conversations</button>
      <button type="button" aria-current={pane === "transcript" ? "page" : undefined} disabled={!hasConversation} onClick={() => onChange("transcript")}>Workspace</button>
      <button type="button" aria-current={pane === "inspector" ? "page" : undefined} disabled={!hasConversation} onClick={() => onChange("inspector")}>Details</button>
    </nav>
  )
}
