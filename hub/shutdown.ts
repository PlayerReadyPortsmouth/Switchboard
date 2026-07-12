export interface ShutdownSteps {
  stopAcceptingWeb: () => void | Promise<void>
  stopRetryWorker: () => Promise<void>
  stopAdapters: () => Promise<void>
  stopWeb: () => Promise<void>
  closeDatabase: () => void
}

export function createAsyncShutdown(steps: ShutdownSteps): () => Promise<void>
export function createAsyncShutdown(stopServer: () => Promise<void>, closeDatabase: () => void): () => Promise<void>
export function createAsyncShutdown(stepsOrStop: ShutdownSteps | (() => Promise<void>), legacyClose?: () => void): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => pending ??= (async () => {
    if (typeof stepsOrStop === "function") {
      try { await stepsOrStop() } finally { legacyClose!() }
      return
    }
    try {
      await stepsOrStop.stopAcceptingWeb()
      await stepsOrStop.stopRetryWorker()
      await stepsOrStop.stopAdapters()
      await stepsOrStop.stopWeb()
    } finally {
      stepsOrStop.closeDatabase()
    }
  })()
}
