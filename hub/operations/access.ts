import type { WorkspaceConfig } from "../types"

export type WorkspaceRole = "hidden" | "viewer" | "operator"

export const agentsFeatureEnabled = (config: WorkspaceConfig | undefined): boolean =>
  config?.features?.agents === true

const matches = (identity: string, entries: string[] | undefined): boolean =>
  entries?.some(entry => entry === "*" || entry === identity) === true

export function resolveWorkspaceRole(identity: string, config: WorkspaceConfig | undefined): WorkspaceRole {
  if (config?.viewers === undefined && config?.operators === undefined) return "operator"
  if (matches(identity, config.operators)) return "operator"
  if (matches(identity, config.viewers)) return "viewer"
  return "hidden"
}
