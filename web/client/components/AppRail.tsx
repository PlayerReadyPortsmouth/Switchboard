import type { ConnectionState } from "../types"
import { ConnectionBanner } from "./ConnectionBanner"
import { InstallButton } from "./InstallButton"
import { webBase } from "../base"
import { pathForAgent, pathForConversation } from "../routes"

interface AppRailProps {
  active: "conversations" | "agents"
  features: { agents: boolean }
  connection: ConnectionState
  install?: { available: boolean; run(): Promise<void> }
  onNew(): void
  onNavigate(destination: "conversations" | "agents"): void
}

export function AppRail({ active, features, connection, install, onNew, onNavigate }: AppRailProps) {
  const destinations = [
    { id: "conversations" as const, label: "Conversations", glyph: "≡", href: pathForConversation(null, webBase), available: true },
    { id: "agents" as const, label: "Agents", glyph: "⌁", href: pathForAgent(null, webBase), available: features.agents },
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
            onClick={event => { event.preventDefault(); onNavigate(destination.id) }}
            aria-current={destination.id === active ? "page" : undefined}
          >
            <span className="rail-glyph" aria-hidden="true">{destination.glyph}</span>
            <span className="rail-label">{destination.label}</span>
          </a>
        ))}
        <a className="rail-link" href={`${webBase}legacy`}><span className="rail-glyph" aria-hidden="true">↗</span><span className="rail-label">Legacy console</span></a>
      </div>
      <div className="rail-footer">
        {install ? <InstallButton available={install.available} onInstall={install.run} /> : null}
        <ConnectionBanner state={connection} />
      </div>
    </nav>
  )
}
