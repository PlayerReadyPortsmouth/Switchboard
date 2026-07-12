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
