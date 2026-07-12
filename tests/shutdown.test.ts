import { expect, test } from "bun:test"
import { createAsyncShutdown } from "../hub/shutdown"

test("shutdown waits for server cancellation before closing once", async () => {
  const calls: string[] = []
  let releaseStop!: () => void
  const stopFinished = new Promise<void>(resolve => { releaseStop = resolve })
  const shutdown = createAsyncShutdown(
    async () => { calls.push("stop:start"); await stopFinished; calls.push("stop:end") },
    () => { calls.push("close") },
  )

  const first = shutdown()
  const second = shutdown()
  expect(second).toBe(first)
  expect(calls).toEqual(["stop:start"])
  releaseStop()
  await first
  expect(calls).toEqual(["stop:start", "stop:end", "close"])
})

test("shutdown stops ingress, retries, adapters, web, then database and remains idempotent", async () => {
  const calls: string[] = []
  const shutdown = createAsyncShutdown({
    stopAcceptingWeb: () => { calls.push("accepting") },
    stopRetryWorker: async () => { calls.push("retry") },
    stopAdapters: async () => { calls.push("adapters") },
    stopWeb: async () => { calls.push("web") },
    closeDatabase: () => { calls.push("database") },
  })
  const first = shutdown()
  expect(shutdown()).toBe(first)
  await first
  await shutdown()
  expect(calls).toEqual(["accepting", "retry", "adapters", "web", "database"])
})
