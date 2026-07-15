import { expect, test } from "bun:test"
import {
  captureOutboundEffect,
  executeOutboundApproval,
} from "./outboundApproval"
import type { DeliveryResult } from "./outboundDelivery"
import type { AuditInput, OutboundRoute } from "./types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function promiseState(promise: Promise<unknown>): Promise<"pending" | "fulfilled" | "rejected"> {
  return await Promise.race([
    promise.then(() => "fulfilled" as const, () => "rejected" as const),
    Promise.resolve("pending" as const),
  ])
}

const route = (overrides: Partial<OutboundRoute> = {}): OutboundRoute => ({
  id: "deploy-hook",
  url: "https://hooks.example.test/deploy",
  method: "POST",
  headers: { authorization: "Bearer secret", "x-mode": "before" },
  requireApproval: true,
  ...overrides,
})

function run(result: DeliveryResult) {
  return executeOutboundApproval({
    route: route(),
    body: "exact",
    actor: "agent:qa",
    correlationId: "approval-1",
    deliver: async () => result,
    audit: () => {},
  })
}

test("the approval execution promise remains pending until delivery finishes", async () => {
  const delivery = deferred<DeliveryResult>()
  const auditRows: AuditInput[] = []
  const execution = executeOutboundApproval({
    route: route(),
    body: "exact",
    actor: "agent:qa",
    correlationId: "approval-1",
    deliver: async () => delivery.promise,
    audit: row => auditRows.push(row),
  })

  expect(await promiseState(execution)).toBe("pending")
  delivery.resolve({ ok: true, attempts: 2, status: 204 })

  await expect(execution).resolves.toEqual({
    outcome: "succeeded",
    detail: { status: 204, attempts: 2 },
  })
  expect(auditRows[0]).toMatchObject({
    kind: "outbound",
    actor: "agent:qa",
    action: "deliver",
    corr: "approval-1",
    outcome: "ok",
  })
})

test("definitive delivery failures map to bounded safe codes", async () => {
  await expect(run({ ok: false, attempts: 3, status: 503 })).resolves.toEqual({
    outcome: "failed",
    detail: { status: 503, attempts: 3, failureCode: "http_error" },
  })
  await expect(run({ ok: false, attempts: 3, status: "error" })).resolves.toEqual({
    outcome: "failed",
    detail: { attempts: 3, failureCode: "network_error" },
  })
  await expect(run({ ok: false, attempts: 0, status: "blocked" })).resolves.toEqual({
    outcome: "failed",
    detail: { attempts: 0, failureCode: "blocked" },
  })
})

test("a rejected delivery is safely audited without exposing the exception", async () => {
  const auditRows: AuditInput[] = []
  const raw = "https://user:password@example.test/private"

  await expect(executeOutboundApproval({
    route: route(),
    body: "exact",
    actor: "agent:qa",
    correlationId: "approval-rejected",
    deliver: async () => { throw new Error(raw) },
    audit: row => auditRows.push(row),
  })).resolves.toEqual({
    outcome: "failed",
    detail: { attempts: 0, failureCode: "effect_rejected" },
  })
  expect(JSON.stringify(auditRows)).not.toContain(raw)
  expect(auditRows[0]).toMatchObject({
    kind: "outbound",
    corr: "approval-rejected",
    outcome: "error",
  })
})

test("snapshot captures and freezes known route fields before later config mutation", () => {
  const source = route()
  const held = captureOutboundEffect(source, "before-body")

  source.url = "https://changed.example"
  source.headers!["x-mode"] = "after"

  expect(held.route.url).not.toContain("changed")
  expect(held.route.headers).toEqual({ authorization: "Bearer secret", "x-mode": "before" })
  expect(held.body).toBe("before-body")
  expect(Object.isFrozen(held)).toBe(true)
  expect(Object.isFrozen(held.route)).toBe(true)
  expect(Object.isFrozen(held.route.headers)).toBe(true)
  expect(Object.keys(held.route).sort()).toEqual([
    "headers", "id", "method", "requireApproval", "url",
  ])
})
