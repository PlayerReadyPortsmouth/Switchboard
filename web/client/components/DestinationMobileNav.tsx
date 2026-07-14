export function DestinationMobileNav({ active, features, onNavigate }: {
  active: "conversations" | "agents"
  features: { agents: boolean }
  onNavigate(destination: "conversations" | "agents"): void
}) {
  return <nav className="destination-mobile-nav" aria-label="Destinations">
    <button type="button" aria-current={active === "conversations" ? "page" : undefined} onClick={() => onNavigate("conversations")}>Conversations</button>
    {features.agents ? <button type="button" aria-current={active === "agents" ? "page" : undefined} onClick={() => onNavigate("agents")}>Agents</button> : null}
  </nav>
}
