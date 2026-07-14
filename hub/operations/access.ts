import type { ApprovalConfig, WorkspaceConfig } from "../types"

export type WorkspaceRole = "hidden" | "viewer" | "operator"

export const agentsFeatureEnabled = (config: WorkspaceConfig | undefined): boolean =>
  config?.features?.agents === true

export interface ApprovalWebAccess {
  feature: boolean
  coreEnabled: boolean
  role: WorkspaceRole
  canDecide: boolean
}

export const approvalsFeatureEnabled = (config: WorkspaceConfig | undefined): boolean =>
  config?.features?.approvals === true

const matches = (identity: string, entries: string[] | undefined): boolean =>
  entries?.some(entry => entry === "*" || entry === identity) === true

export function resolveWorkspaceRole(identity: string, config: WorkspaceConfig | undefined): WorkspaceRole {
  if (config?.viewers === undefined && config?.operators === undefined) return "operator"
  if (matches(identity, config.operators)) return "operator"
  if (matches(identity, config.viewers)) return "viewer"
  return "hidden"
}

export function resolveApprovalWebAccess(
  identity: string,
  workspace: WorkspaceConfig | undefined,
  approvals: ApprovalConfig | undefined,
): ApprovalWebAccess {
  const role = resolveWorkspaceRole(identity, workspace)
  const restricted = (approvals?.webApprovers?.length ?? 0) > 0
  const listed = approvals?.webApprovers?.some(entry => entry === "*" || entry === identity) === true
  return {
    feature: approvalsFeatureEnabled(workspace),
    coreEnabled: approvals?.enabled === true,
    role,
    canDecide: approvals?.enabled === true && role === "operator" && (!restricted || listed),
  }
}
