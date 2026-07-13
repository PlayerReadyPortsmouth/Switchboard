export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

export interface PwaState {
  installAvailable: boolean
  online: boolean
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

export function registerPwa(): PwaController {
  let promptEvent: BeforeInstallPromptEvent | null = null
  let current: PwaState = { installAvailable: false, online: navigator.onLine }
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
    publish({ installAvailable: true })
  }
  const appInstalled = () => {
    promptEvent = null
    publish({ installAvailable: false })
  }
  const online = () => publish({ online: true })
  const offline = () => publish({ online: false })

  window.addEventListener("beforeinstallprompt", beforeInstall)
  window.addEventListener("appinstalled", appInstalled)
  window.addEventListener("online", online)
  window.addEventListener("offline", offline)

  if ("serviceWorker" in navigator && isPwaRegistrationAllowed(new URL(location.href), globalThis.isSecureContext === true)) {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined)
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
      publish({ installAvailable: false })
      await event.prompt()
      await event.userChoice
    },
    dispose() {
      if (disposed) return
      disposed = true
      promptEvent = null
      current = { ...current, installAvailable: false }
      listeners.clear()
      window.removeEventListener("beforeinstallprompt", beforeInstall)
      window.removeEventListener("appinstalled", appInstalled)
      window.removeEventListener("online", online)
      window.removeEventListener("offline", offline)
    },
  }
}
