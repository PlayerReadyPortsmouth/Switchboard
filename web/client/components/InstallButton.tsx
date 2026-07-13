import { useState } from "react"

export function InstallButton({ available, onInstall }: { available: boolean; onInstall(): Promise<void> }) {
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState("")
  if (!available && !error) return null

  const install = async () => {
    setInstalling(true)
    setError("")
    try {
      await onInstall()
    } catch {
      setError("Switchboard could not be installed. Use your browser menu to try again.")
    } finally {
      setInstalling(false)
    }
  }

  return <>
    {available ? <button className="install-action" type="button" disabled={installing} onClick={() => { void install() }} aria-label="Install Switchboard">
      <span aria-hidden="true">↓</span><span className="rail-label">{installing ? "Installing…" : "Install Switchboard"}</span>
    </button> : null}
    {error ? <span className="sr-only" role="status">{error}</span> : null}
  </>
}
