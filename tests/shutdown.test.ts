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

for (const failing of ["accepting", "retry", "adapters", "web", "database"] as const) test(`shutdown attempts every step in order when ${failing} fails`, async () => {
  const calls: string[] = []
  const step = async (name: typeof failing) => { calls.push(name); if (name === failing) throw new Error(name) }
  const shutdown = createAsyncShutdown({
    stopAcceptingWeb: () => step("accepting"), stopRetryWorker: () => step("retry"),
    stopAdapters: () => step("adapters"), stopWeb: () => step("web"),
    closeDatabase: () => { calls.push("database"); if (failing === "database") throw new Error("database") },
  })
  const first = shutdown(); expect(shutdown()).toBe(first)
  await expect(first).rejects.toThrow(failing)
  expect(calls).toEqual(["accepting", "retry", "adapters", "web", "database"])
})

test("shutdown aggregates multiple lifecycle failures after all cleanup", async () => {
  const shutdown = createAsyncShutdown({
    stopAcceptingWeb: () => { throw new Error("accepting") },
    stopRetryWorker: async () => { throw new Error("retry") },
    stopAdapters: async () => {}, stopWeb: async () => { throw new Error("web") },
    closeDatabase: () => { throw new Error("database") },
  })
  try { await shutdown(); throw new Error("expected rejection") }
  catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map(item => (item as Error).message)).toEqual(["accepting", "retry", "web", "database"])
  }
})
