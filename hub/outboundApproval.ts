import type { ApprovalExecutionResult } from "./approvalTypes"
import type { DeliveryResult } from "./outboundDelivery"
import type { AuditInput, OutboundRoute } from "./types"

export interface OutboundEffectSnapshot {
  readonly route: OutboundRoute
  readonly body: string
}

export interface ExecuteOutboundApprovalInput {
  route: OutboundRoute
  body: string
  actor: string
  correlationId?: string
  deliver(route: OutboundRoute, body: string): Promise<DeliveryResult>
  audit(input: AuditInput): void
}

function cloneRoute(route: OutboundRoute): OutboundRoute {
  const copy: OutboundRoute = { id: route.id, url: route.url }
  if (route.pattern !== undefined) copy.pattern = route.pattern
  if (route.secretEnv !== undefined) copy.secretEnv = route.secretEnv
  if (route.method !== undefined) copy.method = route.method
  if (route.headers !== undefined) copy.headers = Object.freeze({ ...route.headers })
  if (route.template !== undefined) copy.template = route.template
  if (route.consume !== undefined) copy.consume = route.consume
  if (route.requireApproval !== undefined) copy.requireApproval = route.requireApproval
  return Object.freeze(copy)
}

/** Capture the exact executable effect before mutable config can change. */
export function captureOutboundEffect(route: OutboundRoute, body: string): OutboundEffectSnapshot {
  return Object.freeze({ route: cloneRoute(route), body })
}

function boundedAttempts(value: unknown): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(100, value as number)) : 0
}

function boundedStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? value as number
    : undefined
}

function safeAudit(audit: (input: AuditInput) => void, input: AuditInput): void {
  try { audit(input) } catch {}
}

/** Await delivery and convert its final truth into the approval policy's safe shape. */
export async function executeOutboundApproval(
  input: ExecuteOutboundApprovalInput,
): Promise<ApprovalExecutionResult> {
  let result: ApprovalExecutionResult & { detail: Record<string, unknown> }
  try {
    const delivered = await input.deliver(input.route, input.body)
    const attempts = boundedAttempts(delivered?.attempts)
    const status = boundedStatus(delivered?.status)
    if (delivered?.ok === true && status !== undefined && status >= 200 && status < 300) {
      result = { outcome: "succeeded", detail: { status, attempts } }
    } else if (delivered?.status === "blocked") {
      result = { outcome: "failed", detail: { attempts, failureCode: "blocked" } }
    } else if (delivered?.status === "error") {
      result = { outcome: "failed", detail: { attempts, failureCode: "network_error" } }
    } else if (status !== undefined) {
      result = { outcome: "failed", detail: { status, attempts, failureCode: "http_error" } }
    } else {
      result = { outcome: "failed", detail: { attempts: 0, failureCode: "effect_rejected" } }
    }
  } catch {
    result = { outcome: "failed", detail: { attempts: 0, failureCode: "effect_rejected" } }
  }

  safeAudit(input.audit, {
    kind: "outbound",
    actor: input.actor,
    action: "deliver",
    target: input.route.id,
    ...(input.correlationId === undefined ? {} : { corr: input.correlationId }),
    outcome: result.outcome === "succeeded" ? "ok" : "error",
    detail: result.detail,
  })
  return result
}
