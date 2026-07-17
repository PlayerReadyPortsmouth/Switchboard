export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

export interface PwaState {
  installAvailable: boolean
  online: boolean
  issue: PwaIssue | null
}

export interface PwaIssue {
  source: "service-worker" | "install"
  message: string
}

export interface PwaController {
  state(): PwaState
  subscribe(listener: (state: PwaState) => void): () => void
  install(): Promise<void>
  dispose(): void
}

export function isPwaRegistrationAllowed(url: URL, secure: boolean) {
  return secure || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
}

export function registerPwa(base = "/"): PwaController {
  let promptEvent: BeforeInstallPromptEvent | null = null
  let current: PwaState = { installAvailable: false, online: navigator.onLine, issue: null }
  let disposed = false
  const listeners = new Set<(state: PwaState) => void>()
  const publish = (next: Partial<PwaState>) => {
    if (disposed) return
    current = { ...current, ...next }
    for (const listener of listeners) listener({ ...current })
  }
  const beforeInstall = (event: Event) => {
    event.preventDefault()
    promptEvent = event as BeforeInstallPromptEvent
    publish({ installAvailable: true, ...(current.issue?.source === "install" ? { issue: null } : {}) })
  }
  const appInstalled = () => {
    promptEvent = null
    publish({ installAvailable: false, ...(current.issue?.source === "install" ? { issue: null } : {}) })
  }
  const online = () => publish({ online: true })
  const offline = () => publish({ online: false })

  window.addEventListener("beforeinstallprompt", beforeInstall)
  window.addEventListener("appinstalled", appInstalled)
  window.addEventListener("online", online)
  window.addEventListener("offline", offline)

  if ("serviceWorker" in navigator && isPwaRegistrationAllowed(new URL(location.href), globalThis.isSecureContext === true)) {
    void navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => publish({
      issue: { source: "service-worker", message: "Switchboard could not enable offline support. Reload the page to try again." },
    }))
  }

  return {
    state: () => ({ ...current }),
    subscribe(listener) {
      listeners.add(listener)
      listener({ ...current })
      return () => listeners.delete(listener)
    },
    async install() {
      const event = promptEvent
      if (!event) return
      promptEvent = null
      publish({ installAvailable: false, ...(current.issue?.source === "install" ? { issue: null } : {}) })
      try {
        await event.prompt()
        await event.userChoice
      } catch {
        publish({ issue: { source: "install", message: "The install prompt could not open. Reload the page, then try Install Switchboard again." } })
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      promptEvent = null
      current = { ...current, installAvailable: false, issue: null }
      listeners.clear()
      window.removeEventListener("beforeinstallprompt", beforeInstall)
      window.removeEventListener("appinstalled", appInstalled)
      window.removeEventListener("online", online)
      window.removeEventListener("offline", offline)
    },
  }
}
