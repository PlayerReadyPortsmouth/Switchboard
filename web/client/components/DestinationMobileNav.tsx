import type { WorkspaceDestination } from "../routes"

export function DestinationMobileNav({ active, features, pendingApprovals, onNavigate }: {
  active: WorkspaceDestination
  features: { agents: boolean; approvals: boolean }
  pendingApprovals: number
  onNavigate(destination: WorkspaceDestination): void
}) {
  return <nav className="destination-mobile-nav" aria-label="Destinations">
    <button type="button" aria-current={active === "conversations" ? "page" : undefined} onClick={() => onNavigate("conversations")}>Conversations</button>
    {features.agents ? <button type="button" aria-current={active === "agents" ? "page" : undefined} onClick={() => onNavigate("agents")}>Agents</button> : null}
    {features.approvals ? <button type="button" aria-label={pendingApprovals > 0 ? `Approvals, ${pendingApprovals} pending` : "Approvals"} aria-current={active === "approvals" ? "page" : undefined} onClick={() => onNavigate("approvals")}>Approvals{pendingApprovals > 0 ? <span aria-hidden="true"> · {pendingApprovals}</span> : null}</button> : null}
  </nav>
}
