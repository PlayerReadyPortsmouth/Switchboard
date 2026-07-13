import { useState } from "react"

export function InstallButton({ available, onInstall }: { available: boolean; onInstall(): Promise<void> }) {
  const [installing, setInstalling] = useState(false)
  if (!available) return null

  const install = async () => {
    setInstalling(true)
    try {
      await onInstall()
    } finally {
      setInstalling(false)
    }
  }

  return <button className="install-action" type="button" disabled={installing} onClick={() => { void install() }} aria-label="Install Switchboard">
      <span aria-hidden="true">↓</span><span className="rail-label">{installing ? "Installing…" : "Install Switchboard"}</span>
    </button>
}
