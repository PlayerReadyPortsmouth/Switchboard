export function DestinationMobileNav({ active, features, onNavigate }: {
  active: "conversations" | "agents" | "documents"
  features: { agents: boolean; documents: boolean }
  onNavigate(destination: "conversations" | "agents" | "documents"): void
}) {
  return <nav className="destination-mobile-nav" aria-label="Destinations">
    <button type="button" aria-current={active === "conversations" ? "page" : undefined} onClick={() => onNavigate("conversations")}>Conversations</button>
    {features.agents ? <button type="button" aria-current={active === "agents" ? "page" : undefined} onClick={() => onNavigate("agents")}>Agents</button> : null}
    {features.documents ? <button type="button" aria-current={active === "documents" ? "page" : undefined} onClick={() => onNavigate("documents")}>Documents</button> : null}
  </nav>
}
