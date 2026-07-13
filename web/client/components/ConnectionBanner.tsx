import type { ConnectionState } from "../types"

const labels: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
}

export function ConnectionBanner({ state }: { state: ConnectionState }) {
  return (
    <div className="connection-banner" data-state={state}>
      <span className="connection-node" aria-hidden="true" />
      <span className="connection-label">{labels[state]}</span>
    </div>
  )
}
