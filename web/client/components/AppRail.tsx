import type { ConnectionState, Session } from "../types"
import type { WorkspaceDestination } from "../routes"
import { ConnectionBanner } from "./ConnectionBanner"
import { InstallButton } from "./InstallButton"

interface AppRailProps {
  active: WorkspaceDestination
  features: { agents: boolean; approvals: boolean }
  pendingApprovals: number
  connection: ConnectionState
  install?: { available: boolean; run(): Promise<void> }
  onNew(): void
  onNavigate(destination: WorkspaceDestination): void
}

export function workspaceDestinationFeatures(session: Pick<Session, "features" | "permissions">): { agents: boolean; approvals: boolean } {
  return {
    agents: session.features.agents && session.permissions.agents !== "hidden",
    approvals: session.features.approvals && session.permissions.approvals !== "hidden",
  }
}

export function AppRail({ active, features, pendingApprovals, connection, install, onNew, onNavigate }: AppRailProps) {
  const destinations = [
    { id: "conversations" as const, label: "Conversations", glyph: "≡", href: "/", available: true },
    { id: "agents" as const, label: "Agents", glyph: "⌁", href: "/agents", available: features.agents },
    { id: "approvals" as const, label: "Approvals", glyph: "◇", href: "/approvals", available: features.approvals },
  ]
  return (
    <nav className="app-rail" aria-label="Application navigation" data-region="application-navigation">
      <div className="switchboard-mark" aria-hidden="true"><span>S</span></div>
      <button className="rail-action" type="button" onClick={onNew} aria-label="New conversation">
        <span aria-hidden="true">+</span><span className="rail-label">New conversation</span>
      </button>
      <div className="rail-destinations">
        {destinations.map(destination => destination.available && (
          <a
            key={destination.id}
            className={destination.id === active ? "rail-link active" : "rail-link"}
            href={destination.href}
            aria-label={destination.id === "approvals" && pendingApprovals > 0 ? `Approvals, ${pendingApprovals} pending` : destination.label}
            onClick={event => { event.preventDefault(); onNavigate(destination.id) }}
            aria-current={destination.id === active ? "page" : undefined}
          >
            <span className="rail-glyph" aria-hidden="true">{destination.glyph}</span>
            <span className="rail-label">{destination.label}</span>
            {destination.id === "approvals" && pendingApprovals > 0 ? <span className="rail-count" aria-hidden="true">{pendingApprovals}</span> : null}
          </a>
        ))}
        <a className="rail-link" href="/legacy"><span className="rail-glyph" aria-hidden="true">↗</span><span className="rail-label">Legacy console</span></a>
      </div>
      <div className="rail-footer">
        {install ? <InstallButton available={install.available} onInstall={install.run} /> : null}
        <ConnectionBanner state={connection} />
      </div>
    </nav>
  )
}
