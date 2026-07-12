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
    const errors: unknown[] = []
    const attempt = async (step: () => void | Promise<void>) => {
      try { await step() } catch (error) { errors.push(error) }
    }
    await attempt(stepsOrStop.stopAcceptingWeb)
    await attempt(stepsOrStop.stopRetryWorker)
    await attempt(stepsOrStop.stopAdapters)
    await attempt(stepsOrStop.stopWeb)
    await attempt(stepsOrStop.closeDatabase)
    if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "))
  })()
}
