export type ApprovalDecision = "grant" | "deny"
export type ApprovalRisk = "low" | "elevated" | "destructive"
export type ApprovalLifecycleState = "pending" | "granted" | "denied" | "expired" | "interrupted"
export type ApprovalStorageState = "registering" | ApprovalLifecycleState
export type ApprovalExecutionOutcome = "not_applicable" | "pending" | "succeeded" | "failed" | "interrupted"
export type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue }

export interface ApprovalPrincipal { surface: string; id: string }
export interface ApprovalOrigin { conversationId?: string; surface?: string; externalLocation?: string }

export interface ApprovalRequestDescriptor {
  kind: string
  target: string
  requestedBy: ApprovalPrincipal
  origin?: ApprovalOrigin
  summary: string
  detail: unknown
}

export interface ApprovalExecutionResult {
  outcome: "succeeded" | "failed"
  detail?: unknown
}

export type ApprovalFire = (correlationId: string) => Promise<ApprovalExecutionResult>

export interface ApprovalRecord {
  id: string
  version: number
  kind: string
  target: string
  summary: string
  detail: SafeValue
  requestedBy: ApprovalPrincipal
  originConversationId: string | null
  risk: ApprovalRisk
  effectFingerprint: string
  createdAt: number
  expiresAt: number
  terminalAt: number | null
  state: ApprovalStorageState
  decisionBy: ApprovalPrincipal | null
  decisionAt: number | null
  decisionKey: string | null
  outcomeReason: string | null
  execution: ApprovalExecutionOutcome
  executionDetail: SafeValue | null
  executionStartedAt: number | null
  executionFinishedAt: number | null
  correlationId: string
}

export interface SafeApprovalAuditView {
  ts: number
  actor: string
  action: string
  outcome: string
}

export interface ApprovalSummaryView {
  id: string
  version: string
  kind: string
  target: string
  summary: string
  risk: ApprovalRisk
  requestedBy: ApprovalPrincipal
  createdAt: number
  expiresAt: number
  terminalAt: number | null
  state: ApprovalLifecycleState
  execution: ApprovalExecutionOutcome
  conversationId?: string
}

export interface ApprovalDetailView extends ApprovalSummaryView {
  detail: SafeValue
  executionDetail: SafeValue | null
  decisionBy: ApprovalPrincipal | null
  decisionAt: number | null
  outcomeReason: string | null
  executionStartedAt: number | null
  executionFinishedAt: number | null
  audit: SafeApprovalAuditView[]
  permissions: { canDecide: boolean }
}

export interface ApprovalNotificationView {
  id: string
  version: string
  kind: string
  target: string
  summary: string
  risk: ApprovalRisk
  requestedBy: ApprovalPrincipal
  createdAt: number
  expiresAt: number
  terminalAt: number | null
  state: ApprovalLifecycleState
  decisionBy: ApprovalPrincipal | null
  decisionAt: number | null
  outcomeReason: string | null
  execution: ApprovalExecutionOutcome
  executionStartedAt: number | null
  executionFinishedAt: number | null
}

export interface ApprovalPendingAggregate {
  count: number
  highestRisk: ApprovalRisk | null
  nearestExpiry: number | null
  firstId: string | null
}

export interface ApprovalListQuery {
  group: "pending" | "history"
  search?: string
  risk?: ApprovalRisk
  kind?: string
  requester?: string
  state?: ApprovalLifecycleState
  conversationId?: string
  createdFrom?: number
  createdTo?: number
  decisionFrom?: number
  decisionTo?: number
  cursor?: string
  limit?: number
}

export interface ApprovalListPage {
  items: ApprovalSummaryView[]
  nextCursor: string | null
  pendingCount: number
  querySummary: ApprovalPendingAggregate | null
}

export interface ApprovalDecisionInput {
  approvalId: string
  decision: ApprovalDecision
  expectedVersion: string
  idempotencyKey: string
}

export interface ApprovalDecisionResult {
  approval: ApprovalDetailView
}
