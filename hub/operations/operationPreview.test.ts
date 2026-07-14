import { expect, test } from "bun:test"
import { AgentActionPreviewRegistry, IdempotencyRegistry } from "./operationPreview"

test("action previews bind the confirmed runtime snapshot", () => {
  const registry = new AgentActionPreviewRegistry(() => 10, () => "p1", 1000)
  const preview = registry.create("ada", "qa", "reset", "status-v1", { busy: true, queueDepth: 2 })
  expect(preview).toEqual({
    id: "p1",
    actor: "ada",
    agent: "qa",
    action: "reset",
    statusVersion: "status-v1",
    impact: { busy: true, queueDepth: 2 },
    expiresAt: 1010,
  })
  expect(registry.consume("p1", "ada", "qa", "status-v1")?.action).toBe("reset")
  expect(registry.consume("p1", "ada", "qa", "status-v1")).toBeNull()
})

test("action preview mismatches consume the token", () => {
  const attempts: Array<[string, string, string]> = [
    ["mallory", "qa", "status-v1"],
    ["ada", "ops", "status-v1"],
    ["ada", "qa", "status-v2"],
  ]

  for (const [actor, agent, statusVersion] of attempts) {
    const registry = new AgentActionPreviewRegistry(() => 10, () => "p1", 1000)
    registry.create("ada", "qa", "restart", "status-v1", { busy: false, queueDepth: 0 })
    expect(registry.consume("p1", actor, agent, statusVersion)).toBeNull()
    expect(registry.consume("p1", "ada", "qa", "status-v1")).toBeNull()
  }
})

test("expired action previews cannot be consumed", () => {
  let now = 0
  const registry = new AgentActionPreviewRegistry(() => now, () => "p1", 1000)
  registry.create("ada", "qa", "reset", "status-v1", { busy: false, queueDepth: 0 })
  now = 1000
  expect(registry.consume("p1", "ada", "qa", "status-v1")).toBeNull()
})

test("idempotency returns the original completed result", async () => {
  const registry = new IdempotencyRegistry<{ state: string }>(() => 0, 1000)
  let calls = 0
  const first = await registry.run("ada", "reset-1", async () => { calls++; return { state: "applied" } })
  const second = await registry.run("ada", "reset-1", async () => { calls++; return { state: "different" } })
  expect(second).toEqual(first)
  expect(calls).toBe(1)
})

test("idempotency shares an in-flight operation", async () => {
  const registry = new IdempotencyRegistry<string>(() => 0, 1000)
  let calls = 0
  let complete!: (result: string) => void
  const operation = () => {
    calls++
    return new Promise<string>(resolve => { complete = resolve })
  }

  const first = registry.run("ada", "reset-1", operation)
  const second = registry.run("ada", "reset-1", operation)
  expect(calls).toBe(1)
  complete("applied")
  expect(await first).toBe("applied")
  expect(await second).toBe("applied")
})

test("idempotency does not expire in-flight operations", async () => {
  let now = 0
  const registry = new IdempotencyRegistry<string>(() => now, 1000)
  let calls = 0
  let complete!: (result: string) => void
  const operation = () => {
    calls++
    return new Promise<string>(resolve => { complete = resolve })
  }

  const first = registry.run("ada", "reset-1", operation)
  now = 1000
  const second = registry.run("ada", "reset-1", operation)
  expect(calls).toBe(1)
  complete("applied")
  expect(await first).toBe("applied")
  expect(await second).toBe("applied")
})

test("idempotency starts the success TTL when the operation completes", async () => {
  let now = 0
  const registry = new IdempotencyRegistry<string>(() => now, 1000)
  let calls = 0
  let complete!: (result: string) => void

  const first = registry.run("ada", "reset-1", () => {
    calls++
    return new Promise<string>(resolve => { complete = resolve })
  })
  now = 900
  complete("applied")
  await first
  now = 1899
  expect(await registry.run("ada", "reset-1", async () => `result-${++calls}`)).toBe("applied")
  now = 1900
  expect(await registry.run("ada", "reset-1", async () => `result-${++calls}`)).toBe("result-2")
})

test("idempotency scopes keys by actor", async () => {
  const registry = new IdempotencyRegistry<string>(() => 0, 1000)
  let calls = 0
  expect(await registry.run("ada", "reset-1", async () => `result-${++calls}`)).toBe("result-1")
  expect(await registry.run("mallory", "reset-1", async () => `result-${++calls}`)).toBe("result-2")
})

test("idempotency retries failures and expired successes", async () => {
  let now = 0
  const registry = new IdempotencyRegistry<string>(() => now, 1000)
  let calls = 0
  const failure = new Error("failed")

  await expect(registry.run("ada", "reset-1", async () => { calls++; throw failure })).rejects.toBe(failure)
  expect(await registry.run("ada", "reset-1", async () => { calls++; return "retried" })).toBe("retried")
  now = 1000
  expect(await registry.run("ada", "reset-1", async () => { calls++; return "expired" })).toBe("expired")
  expect(calls).toBe(3)
})
