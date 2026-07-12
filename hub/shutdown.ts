export function createAsyncShutdown(stopServer: () => Promise<void>, closeDatabase: () => void): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => pending ??= (async () => {
    try {
      await stopServer()
    } finally {
      closeDatabase()
    }
  })()
}
