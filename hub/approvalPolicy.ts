import { createHmac } from "node:crypto"
import type { OutboundRoute } from "./types"
import type {
  ApprovalExecutionResult,
  ApprovalRequestDescriptor,
  ApprovalRisk,
  SafeValue,
} from "./approvalTypes"

export interface PreparedApproval<TDetail extends SafeValue = SafeValue> {
  target: string
  summary: string
  detail: TDetail
  risk: ApprovalRisk
  effectFingerprint: string
}

export interface ApprovalKindPolicy<TDetail extends SafeValue = SafeValue> {
  readonly kind: string
  prepare(descriptor: ApprovalRequestDescriptor): PreparedApproval<TDetail>
  projectDetail(storedDetail: SafeValue): TDetail
  sanitizeExecution(result: ApprovalExecutionResult): {
    outcome: "succeeded" | "failed"
    detail: SafeValue | null
  }
}

export class ApprovalPolicyRegistry {
  private readonly policies = new Map<string, ApprovalKindPolicy>()

  register(policy: ApprovalKindPolicy): void {
    if (this.policies.has(policy.kind)) throw new Error(`approval_policy_exists:${policy.kind}`)
    this.policies.set(policy.kind, policy)
  }

  require(kind: string): ApprovalKindPolicy {
    const policy = this.policies.get(kind)
    if (!policy) throw new Error("approval_kind_unsupported")
    return policy
  }
}

export type OutboundApprovalDetail = {
  routeId: string
  method: string
  destinationHostname: string
  payloadBytes: number
  payloadFingerprint: string
  routeVersionFingerprint: string
}

type CanonicalOutboundRoute = {
  id: string
  url: string
  pattern: string | null
  method: string
  secretEnv: string | null
  template: string | null
  consume: boolean
  requireApproval: boolean
  headers: Array<[string, string]>
}

const ROUTE_KEYS = new Set<keyof OutboundRoute>([
  "id",
  "url",
  "pattern",
  "secretEnv",
  "method",
  "headers",
  "template",
  "consume",
  "requireApproval",
])

const EXECUTION_FAILURE_CODES = new Set([
  "http_error",
  "network_error",
  "blocked",
  "effect_rejected",
])

const encoder = new TextEncoder()
const ABSENT = Symbol("absent")
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FINGERPRINT_DOMAIN = {
  payload: "switchboard:approval:outbound:payload:v1",
  routeVersion: "switchboard:approval:outbound:route-version:v1",
  exactEffect: "switchboard:approval:outbound:exact-effect:v1",
} as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownKeys(value: Record<string, unknown>, error: string): Array<string | symbol> {
  try {
    return Reflect.ownKeys(value)
  } catch {
    throw new Error(error)
  }
}

function ownDataValue(
  value: Record<string, unknown>,
  key: string,
  error: string,
): unknown | typeof ABSENT {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    throw new Error(error)
  }
  if (descriptor === undefined) return ABSENT
  if (!("value" in descriptor)) throw new Error(error)
  return descriptor.value
}

function safeOwnDataValue(value: Record<string, unknown>, key: string): unknown | typeof ABSENT {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : ABSENT
  } catch {
    return ABSENT
  }
}

function hasExactStringKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  error: string,
): boolean {
  const keys = ownKeys(value, error)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

function requireBoundedString(value: unknown, maxBytes: number, error: string): string {
  if (typeof value !== "string" || utf8Bytes(value) === 0 || utf8Bytes(value) > maxBytes) {
    throw new Error(error)
  }
  return value
}

function optionalOwnString(value: Record<string, unknown>, key: string): string | null {
  const candidate = ownDataValue(value, key, "invalid_approval_request")
  if (candidate === ABSENT || candidate === undefined) return null
  if (typeof candidate !== "string") throw new Error("invalid_approval_request")
  return candidate
}

function optionalOwnBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = ownDataValue(value, key, "invalid_approval_request")
  if (candidate === ABSENT || candidate === undefined) return false
  if (typeof candidate !== "boolean") throw new Error("invalid_approval_request")
  return candidate
}

function canonicalHeaders(value: unknown): Array<[string, string]> {
  if (value === undefined) return []
  if (!isPlainRecord(value)) throw new Error("invalid_approval_request")

  const folded = new Set<string>()
  const headers: Array<[string, string]> = []
  for (const key of ownKeys(value, "invalid_approval_request")) {
    if (typeof key !== "string" || !HTTP_TOKEN.test(key)) {
      throw new Error("invalid_approval_request")
    }
    const headerValue = ownDataValue(value, key, "invalid_approval_request")
    if (typeof headerValue !== "string") throw new Error("invalid_approval_request")
    const name = key.toLowerCase()
    if (folded.has(name)) throw new Error("invalid_approval_request")
    folded.add(name)
    headers.push([name, headerValue])
  }
  headers.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return headers
}

function canonicalRoute(value: unknown): { route: CanonicalOutboundRoute; hostname: string } {
  if (!isPlainRecord(value)) throw new Error("invalid_approval_request")
  if (ownKeys(value, "invalid_approval_request")
    .some(key => typeof key !== "string" || !ROUTE_KEYS.has(key as keyof OutboundRoute))) {
    throw new Error("invalid_approval_request")
  }

  const id = requireBoundedString(ownDataValue(value, "id", "invalid_approval_request"), 256, "invalid_approval_request")
  const url = ownDataValue(value, "url", "invalid_approval_request")
  if (typeof url !== "string") throw new Error("invalid_approval_request")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("invalid_approval_request")
  }
  const hostname = requireCanonicalHostname(parsed.hostname, "invalid_approval_request")

  const methodValue = ownDataValue(value, "method", "invalid_approval_request")
  if (methodValue !== ABSENT && methodValue !== undefined && typeof methodValue !== "string") {
    throw new Error("invalid_approval_request")
  }
  const rawMethod = typeof methodValue === "string" ? methodValue : "POST"
  if (!HTTP_TOKEN.test(rawMethod)) throw new Error("invalid_approval_request")
  const method = rawMethod.toUpperCase()

  const headersValue = ownDataValue(value, "headers", "invalid_approval_request")

  return {
    route: {
      id,
      url,
      pattern: optionalOwnString(value, "pattern"),
      method,
      secretEnv: optionalOwnString(value, "secretEnv"),
      template: optionalOwnString(value, "template"),
      consume: optionalOwnBoolean(value, "consume"),
      requireApproval: optionalOwnBoolean(value, "requireApproval"),
      headers: canonicalHeaders(headersValue === ABSENT ? undefined : headersValue),
    },
    hostname,
  }
}

function fingerprint(key: Uint8Array, domain: string, value: string | Uint8Array): string {
  return createHmac("sha256", key)
    .update(domain)
    .update(Uint8Array.of(0))
    .update(value)
    .digest("hex")
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

function isCanonicalHostname(value: string): boolean {
  if (value.includes("/") || value.includes("@") || value.includes("?") || value.includes("#")) return false
  try {
    const parsed = new URL(`https://${value}/`)
    return parsed.hostname === value
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.port.length === 0
      && parsed.pathname === "/"
      && parsed.search.length === 0
      && parsed.hash.length === 0
  } catch {
    return false
  }
}

function requireCanonicalHostname(value: unknown, error: string): string {
  const hostname = requireBoundedString(value, 512, error)
  if (!isCanonicalHostname(hostname)) throw new Error(error)
  return hostname
}

function projectOutboundDetail(value: SafeValue): OutboundApprovalDetail {
  if (!isPlainRecord(value)) throw new Error("corrupt_record")
  const routeId = requireBoundedString(ownDataValue(value, "routeId", "corrupt_record"), 256, "corrupt_record")
  const method = requireBoundedString(ownDataValue(value, "method", "corrupt_record"), 512, "corrupt_record")
  const destinationHostname = requireCanonicalHostname(
    ownDataValue(value, "destinationHostname", "corrupt_record"),
    "corrupt_record",
  )
  const payloadBytes = ownDataValue(value, "payloadBytes", "corrupt_record")
  const payloadFingerprint = ownDataValue(value, "payloadFingerprint", "corrupt_record")
  const routeVersionFingerprint = ownDataValue(value, "routeVersionFingerprint", "corrupt_record")
  if (!HTTP_TOKEN.test(method) || method !== method.toUpperCase()) {
    throw new Error("corrupt_record")
  }
  if (!Number.isSafeInteger(payloadBytes) || (payloadBytes as number) < 0) {
    throw new Error("corrupt_record")
  }
  if (!isFingerprint(payloadFingerprint) || !isFingerprint(routeVersionFingerprint)) {
    throw new Error("corrupt_record")
  }
  return {
    routeId,
    method,
    destinationHostname,
    payloadBytes: payloadBytes as number,
    payloadFingerprint,
    routeVersionFingerprint,
  }
}

function sanitizeExecution(result: ApprovalExecutionResult): {
  outcome: "succeeded" | "failed"
  detail: SafeValue | null
} {
  if (!isPlainRecord(result)) return { outcome: "failed", detail: null }
  const outcome = safeOwnDataValue(result, "outcome") === "succeeded" ? "succeeded" : "failed"
  const resultDetail = safeOwnDataValue(result, "detail")
  if (resultDetail === ABSENT || !isPlainRecord(resultDetail)) return { outcome, detail: null }

  const detail: { [key: string]: SafeValue } = {}
  const status = safeOwnDataValue(resultDetail, "status")
  const attempts = safeOwnDataValue(resultDetail, "attempts")
  const failureCode = safeOwnDataValue(resultDetail, "failureCode")
  if (Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599) {
    detail.status = status as number
  }
  if (Number.isInteger(attempts)) {
    detail.attempts = Math.max(0, Math.min(100, attempts as number))
  }
  if (typeof failureCode === "string" && EXECUTION_FAILURE_CODES.has(failureCode)) {
    detail.failureCode = failureCode
  }
  return { outcome, detail: Object.keys(detail).length === 0 ? null : detail }
}

export function createOutboundApprovalPolicy(processKey: Uint8Array): ApprovalKindPolicy<OutboundApprovalDetail> {
  const key = Buffer.from(processKey)
  if (key.byteLength === 0) throw new Error("invalid_approval_process_key")

  return {
    kind: "outbound",

    prepare(descriptor): PreparedApproval<OutboundApprovalDetail> {
      if (!isPlainRecord(descriptor)) throw new Error("invalid_approval_request")
      const kind = ownDataValue(descriptor, "kind", "invalid_approval_request")
      const requestDetail = ownDataValue(descriptor, "detail", "invalid_approval_request")
      if (kind !== "outbound" || !isPlainRecord(requestDetail)
        || !hasExactStringKeys(requestDetail, ["route", "body"], "invalid_approval_request")) {
        throw new Error("invalid_approval_request")
      }
      const routeValue = ownDataValue(requestDetail, "route", "invalid_approval_request")
      const bodyValue = ownDataValue(requestDetail, "body", "invalid_approval_request")
      if (typeof bodyValue !== "string") throw new Error("invalid_approval_request")

      const { route, hostname } = canonicalRoute(routeValue)
      const target = requireBoundedString(route.id, 256, "invalid_approval_request")
      const summary = requireBoundedString(`${route.method} → ${route.id}`, 512, "invalid_approval_request")
      const body = bodyValue
      const routeInput = JSON.stringify(route)
      const effectInput = JSON.stringify({ ...route, body })
      const detail: OutboundApprovalDetail = {
        routeId: route.id,
        method: route.method,
        destinationHostname: hostname,
        payloadBytes: encoder.encode(body).byteLength,
        payloadFingerprint: fingerprint(key, FINGERPRINT_DOMAIN.payload, encoder.encode(body)),
        routeVersionFingerprint: fingerprint(key, FINGERPRINT_DOMAIN.routeVersion, routeInput),
      }
      return {
        target,
        summary,
        detail,
        risk: "elevated",
        effectFingerprint: fingerprint(key, FINGERPRINT_DOMAIN.exactEffect, effectInput),
      }
    },

    projectDetail: projectOutboundDetail,
    sanitizeExecution,
  }
}
