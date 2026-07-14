import { expect, test } from "bun:test"
import {
  agentsFeatureEnabled,
  approvalsFeatureEnabled,
  resolveApprovalWebAccess,
  resolveWorkspaceRole,
} from "./access"

test("agents stays hidden until explicitly enabled", () => {
  expect(agentsFeatureEnabled(undefined)).toBe(false)
  expect(agentsFeatureEnabled({ features: { agents: true } })).toBe(true)
})

test("an unconfigured policy preserves trusted-header operator compatibility", () => {
  expect(resolveWorkspaceRole("ada@example.com", undefined)).toBe("operator")
})

test("configured lists distinguish viewer, operator, wildcard, and hidden", () => {
  const config = { viewers: ["viewer@example.com"], operators: ["ops@example.com"] }
  expect(resolveWorkspaceRole("viewer@example.com", config)).toBe("viewer")
  expect(resolveWorkspaceRole("ops@example.com", config)).toBe("operator")
  expect(resolveWorkspaceRole("other@example.com", config)).toBe("hidden")
  expect(resolveWorkspaceRole("anyone@example.com", { viewers: ["*"] })).toBe("viewer")
})

test("workspace visibility and core production are independent", () => {
  expect(approvalsFeatureEnabled(undefined)).toBe(false)
  expect(approvalsFeatureEnabled({ features: { approvals: true } })).toBe(true)
  expect(resolveApprovalWebAccess("ops@example.com", { operators: ["ops@example.com"] }, { enabled: false }))
    .toEqual({ feature: false, coreEnabled: false, role: "operator", canDecide: false })
  expect(resolveApprovalWebAccess("ops@example.com", { features: { approvals: true }, operators: ["ops@example.com"] }, { enabled: false }))
    .toEqual({ feature: true, coreEnabled: false, role: "operator", canDecide: false })
})

test("a configured web approver list further restricts operators", () => {
  const workspace = { features: { approvals: true }, operators: ["ops@example.com", "approver@example.com"] }
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true, webApprovers: ["approver@example.com"] }).canDecide).toBe(false)
  expect(resolveApprovalWebAccess("approver@example.com", workspace, { enabled: true, webApprovers: ["approver@example.com"] }).canDecide).toBe(true)
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true, webApprovers: ["*"] }).canDecide).toBe(true)
})

test("an absent or empty web approver list preserves operator compatibility", () => {
  const workspace = { operators: ["ops@example.com"], viewers: ["viewer@example.com"] }
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true }).canDecide).toBe(true)
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true, webApprovers: [] }).canDecide).toBe(true)
  expect(resolveApprovalWebAccess("viewer@example.com", workspace, { enabled: true }).canDecide).toBe(false)
})

test("trusted identities are compared exactly", () => {
  expect(resolveWorkspaceRole(" Ops@example.com ", { operators: ["ops@example.com"] })).toBe("hidden")
  expect(resolveApprovalWebAccess(
    "OPS@example.com",
    { operators: ["OPS@example.com"] },
    { enabled: true, webApprovers: ["ops@example.com"] },
  ).canDecide).toBe(false)
})
