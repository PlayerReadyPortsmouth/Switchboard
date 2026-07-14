import { expect, test } from "bun:test"
import type { OutboundRoute } from "./types"
import { ApprovalPolicyRegistry, createOutboundApprovalPolicy } from "./approvalPolicy"

const route: OutboundRoute = {
  id: "deploy",
  url: "https://user:pass@hooks.example.com/private?token=raw#fragment",
  method: "post",
  headers: { Authorization: "Bearer raw-secret" },
  secretEnv: "OUTBOUND_SECRET",
  template: "raw-template",
}

function outboundDescriptor(input: { route: OutboundRoute; body: string }) {
  return {
    kind: "outbound",
    target: "producer-target-must-not-pass-through",
    requestedBy: { surface: "test", id: "requester-1" },
    summary: "producer-summary-must-not-pass-through",
    detail: input,
  }
}

test("outbound policy emits only the approved elevated projection", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 7))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "tiny secret body" }))
  expect(prepared.risk).toBe("elevated")
  expect(prepared.detail).toEqual({
    routeId: "deploy",
    method: "POST",
    destinationHostname: "hooks.example.com",
    payloadBytes: 16,
    payloadFingerprint: expect.any(String),
    routeVersionFingerprint: expect.any(String),
  })
  expect(prepared.effectFingerprint).toEqual(expect.any(String))
  expect(JSON.stringify(prepared)).not.toContain("user:pass")
  expect(JSON.stringify(prepared)).not.toContain("raw-secret")
  expect(JSON.stringify(prepared)).not.toContain("tiny secret body")
})

test("outbound projection omits path, query, fragment, route secrets, and producer display text", () => {
  const prepared = createOutboundApprovalPolicy(Buffer.alloc(32, 8))
    .prepare(outboundDescriptor({ route, body: "body-secret" }))
  const serialized = JSON.stringify(prepared)
  for (const forbidden of [
    "/private",
    "token=raw",
    "fragment",
    "OUTBOUND_SECRET",
    "raw-template",
    "producer-target",
    "producer-summary",
  ]) expect(serialized).not.toContain(forbidden)
  expect(JSON.stringify(prepared.detail)).not.toContain(prepared.effectFingerprint)
})

test("payload size counts exact UTF-8 bytes", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 9))
  expect(policy.prepare(outboundDescriptor({ route, body: "£🙂" })).detail.payloadBytes).toBe(6)
})

test("payload, route, and combined fingerprints are keyed and effect-specific", () => {
  const first = createOutboundApprovalPolicy(Buffer.alloc(32, 1))
  const second = createOutboundApprovalPolicy(Buffer.alloc(32, 2))
  const a = first.prepare(outboundDescriptor({ route, body: "a" }))
  const b = first.prepare(outboundDescriptor({ route, body: "b" }))
  const otherProcess = second.prepare(outboundDescriptor({ route, body: "a" }))
  expect(a.detail.payloadFingerprint).not.toBe(b.detail.payloadFingerprint)
  expect(a.effectFingerprint).not.toBe(b.effectFingerprint)
  expect(a.effectFingerprint).not.toBe(otherProcess.effectFingerprint)
})

test("route fingerprints canonicalize header order and case", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 10))
  const first = policy.prepare(outboundDescriptor({
    route: { ...route, headers: { "X-Zed": "z", "x-alpha": "a" } },
    body: "same",
  }))
  const second = policy.prepare(outboundDescriptor({
    route: { ...route, headers: { "X-ALPHA": "a", "x-zED": "z" } },
    body: "same",
  }))
  expect(first.detail.routeVersionFingerprint).toBe(second.detail.routeVersionFingerprint)
  expect(first.effectFingerprint).toBe(second.effectFingerprint)
})

test("route changes alter the route and exact-effect fingerprints", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 11))
  const first = policy.prepare(outboundDescriptor({ route, body: "same" }))
  const changed = policy.prepare(outboundDescriptor({
    route: { ...route, consume: true },
    body: "same",
  }))
  expect(changed.detail.routeVersionFingerprint).not.toBe(first.detail.routeVersionFingerprint)
  expect(changed.effectFingerprint).not.toBe(first.effectFingerprint)
})

test("duplicate static header names after case folding are rejected", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 12))
  expect(() => policy.prepare(outboundDescriptor({
    route: { ...route, headers: { Authorization: "one", authorization: "two" } },
    body: "same",
  }))).toThrow("invalid_approval_request")
})

test("outbound descriptors reject unknown detail fields", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 13))
  expect(() => policy.prepare({
    ...outboundDescriptor({ route, body: "same" }),
    detail: { route, body: "same", injected: "drop-is-not-enough-at-request-boundary" },
  })).toThrow("invalid_approval_request")
})

test("outbound descriptors require route fields to be own data properties", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 17))
  const routeWithoutOwnId = new Proxy(
    { url: "https://hooks.example.com" } as OutboundRoute,
    { get: (target, property, receiver) => property === "id" ? "inherited-id" : Reflect.get(target, property, receiver) },
  )
  expect(() => policy.prepare(outboundDescriptor({ route: routeWithoutOwnId, body: "same" })))
    .toThrow("invalid_approval_request")
})

test("outbound descriptors reject non-token methods before they can enter public detail", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 18))
  expect(() => policy.prepare(outboundDescriptor({
    route: { ...route, method: "post secret" },
    body: "same",
  }))).toThrow("invalid_approval_request")
})

test("execution results are bounded and drop arbitrary producer data", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 3))
  expect(policy.sanitizeExecution({ outcome: "failed", detail: {
    status: 503, attempts: 999_999, failureCode: "http_error", body: "secret", headers: { x: "secret" }, error: "raw",
  } })).toEqual({ outcome: "failed", detail: { status: 503, attempts: 100, failureCode: "http_error" } })
})

test("execution sanitization drops invalid allowlisted values and raw failures", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 14))
  expect(policy.sanitizeExecution({ outcome: "failed", detail: {
    status: 99,
    attempts: 1.5,
    failureCode: "raw_exception",
    error: "socket contained a secret",
  } })).toEqual({ outcome: "failed", detail: null })
})

test("execution sanitization ignores values that are not own data properties", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 19))
  const inheritedDetail = new Proxy({}, {
    get: (_target, property) => property === "status" ? 503 : property === "attempts" ? 2 : undefined,
  })
  expect(policy.sanitizeExecution({ outcome: "failed", detail: inheritedDetail }))
    .toEqual({ outcome: "failed", detail: null })
})

test("the persisted-detail projector drops unknown keys and never exposes the combined fingerprint", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 4))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "exact" }))
  expect(policy.projectDetail({
    ...prepared.detail,
    effectFingerprint: prepared.effectFingerprint,
    injected: "drop-me",
  })).toEqual(prepared.detail)
})

test("the persisted-detail projector fails closed on invalid required fields", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 15))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "exact" }))
  expect(() => policy.projectDetail({ ...prepared.detail, payloadBytes: -1 })).toThrow("corrupt_record")
})

test("the persisted-detail projector requires own data properties", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 20))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "exact" }))
  const { routeId: _omitted, ...withoutRouteId } = prepared.detail
  const inheritedRouteId = new Proxy(withoutRouteId, {
    get: (target, property, receiver) => property === "routeId" ? "deploy" : Reflect.get(target, property, receiver),
  })
  expect(() => policy.projectDetail(inheritedRouteId)).toThrow("corrupt_record")
})

test("the persisted-detail projector rejects non-canonical methods and hostnames", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 21))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "exact" }))
  expect(() => policy.projectDetail({ ...prepared.detail, method: "post" })).toThrow("corrupt_record")
  expect(() => policy.projectDetail({
    ...prepared.detail,
    destinationHostname: "user:pass@hooks.example.com/private?token=raw#fragment",
  })).toThrow("corrupt_record")
})

test("approval policy registry rejects duplicates and unknown kinds", () => {
  const registry = new ApprovalPolicyRegistry()
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 16))
  registry.register(policy)
  expect(registry.require("outbound")).toBe(policy)
  expect(() => registry.register(policy)).toThrow("approval_policy_exists:outbound")
  expect(() => registry.require("unknown")).toThrow("approval_kind_unsupported")
})
