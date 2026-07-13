import type { ConnectionState } from "../types"
import { ConnectionBanner } from "./ConnectionBanner"
import { InstallButton } from "./InstallButton"

const destinations = [
  { id: "conversations", label: "Conversations", available: true },
  { id: "legacy", label: "Legacy console", available: true, href: "/legacy" },
] as const

interface AppRailProps {
  connection: ConnectionState
  install?: { available: boolean; run(): Promise<void> }
  onNew(): void
  onConversations(): void
}

export function AppRail({ connection, install, onNew, onConversations }: AppRailProps) {
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
            className={destination.id === "conversations" ? "rail-link active" : "rail-link"}
            href={"href" in destination ? destination.href : "/"}
            onClick={destination.id === "conversations" ? event => { event.preventDefault(); onConversations() } : undefined}
            aria-current={destination.id === "conversations" ? "page" : undefined}
          >
            <span className="rail-glyph" aria-hidden="true">{destination.id === "conversations" ? "≡" : "↗"}</span>
            <span className="rail-label">{destination.label}</span>
          </a>
        ))}
      </div>
      <div className="rail-footer">
        {install ? <InstallButton available={install.available} onInstall={install.run} /> : null}
        <ConnectionBanner state={connection} />
      </div>
    </nav>
  )
}
