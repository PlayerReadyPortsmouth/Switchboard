import { expect, test } from "bun:test"
import {
  approvalCustomId,
  approvalDecisionKey,
  parseApprovalCustomId,
  renderApprovalCard,
} from "../hub/approval"
import type { ApprovalNotificationView } from "../hub/approvalTypes"

function approvalView(overrides: Partial<ApprovalNotificationView> = {}): ApprovalNotificationView {
  return {
    id: "approval-1",
    version: "1",
    kind: "outbound",
    target: "deploy-done",
    summary: "POST to deploy-done",
    risk: "elevated",
    requestedBy: { surface: "agent", id: "assistant" },
    createdAt: 100,
    expiresAt: 1_000,
    terminalAt: null,
    state: "pending",
    decisionBy: null,
    decisionAt: null,
    outcomeReason: null,
    execution: "not_applicable",
    executionStartedAt: null,
    executionFinishedAt: null,
    ...overrides,
  }
}

test("versioned approval custom IDs round-trip and reject old or malformed IDs", () => {
  const id = approvalCustomId("approval-7", "grant", "12")
  expect(id).toBe("approval:grant:12:approval-7")
  expect(parseApprovalCustomId(id)).toEqual({ id: "approval-7", decision: "grant", version: "12" })
  expect(parseApprovalCustomId("approval:deny:12:approval-7")).toEqual({
    id: "approval-7",
    decision: "deny",
    version: "12",
  })
  expect(parseApprovalCustomId("approval:grant:approval-7")).toBeNull()
  expect(parseApprovalCustomId("approval:grant::approval-7")).toBeNull()
  expect(parseApprovalCustomId("approval:grant:12:")).toBeNull()
  expect(parseApprovalCustomId("approval:other:12:approval-7")).toBeNull()
  expect(() => approvalCustomId("", "grant", "12")).toThrow("invalid_approval_custom_id")
  expect(() => approvalCustomId("approval:7", "grant", "12")).toThrow("invalid_approval_custom_id")
  expect(() => approvalCustomId("approval-7", "grant", "")).toThrow("invalid_approval_custom_id")
  expect(() => approvalCustomId("approval-7", "grant", "1:2")).toThrow("invalid_approval_custom_id")
})

test("pending cards contain version-bound controls and terminal cards remove them", () => {
  const pending = approvalView({ id: "approval-7", version: "12", state: "pending" })
  expect(renderApprovalCard(pending).buttons.map(button => button.customId)).toEqual([
    "approval:grant:12:approval-7",
    "approval:deny:12:approval-7",
  ])

  const terminal: Array<Partial<ApprovalNotificationView>> = [
    { state: "denied", execution: "not_applicable" },
    { state: "expired", execution: "not_applicable" },
    { state: "interrupted", execution: "not_applicable" },
    { state: "granted", execution: "pending" },
    { state: "granted", execution: "succeeded" },
    { state: "granted", execution: "failed" },
    { state: "granted", execution: "interrupted" },
  ]
  for (const state of terminal) expect(renderApprovalCard(approvalView(state)).buttons).toEqual([])
})

test("terminal cards distinguish denied, expired, interrupted, running, succeeded, and failed outcomes", () => {
  const cases: Array<[Partial<ApprovalNotificationView>, string]> = [
    [{ state: "denied" }, "Denied"],
    [{ state: "expired" }, "Expired"],
    [{ state: "interrupted" }, "Interrupted"],
    [{ state: "granted", execution: "pending" }, "in progress"],
    [{ state: "granted", execution: "succeeded" }, "succeeded"],
    [{ state: "granted", execution: "failed" }, "failed"],
  ]
  for (const [state, expected] of cases) {
    const card = renderApprovalCard(approvalView(state))
    expect(`${card.title} ${card.body}`).toContain(expected)
  }
})

test("interrupted granted execution is described as unknown, not discarded", () => {
  const card = renderApprovalCard(approvalView({ state: "granted", execution: "interrupted" }))
  expect(`${card.title} ${card.body}`).toContain("outcome unknown")
  expect(`${card.title} ${card.body}`).not.toContain("did not run")
})

test("Discord decision keys prefer a platform interaction ID", () => {
  const principal = { surface: "discord", id: "user-1" }
  const preferred = approvalDecisionKey("interaction-9", "approval-1", "12", "grant", principal)
  expect(preferred).toBe("discord:interaction-9")
  expect(approvalDecisionKey("interaction-9", "other", "99", "deny", { surface: "discord", id: "user-2" }))
    .toBe(preferred)
})

test("Discord decision fallback keys bind approval, version, decision, and principal", () => {
  const principal = { surface: "discord", id: "user-1" }
  const base = approvalDecisionKey(undefined, "approval-1", "12", "grant", principal)
  expect(base).toMatch(/^discord:fallback:[a-f0-9]{64}$/)
  expect(approvalDecisionKey("", "approval-1", "12", "grant", principal)).toBe(base)
  expect(approvalDecisionKey(undefined, "approval-2", "12", "grant", principal)).not.toBe(base)
  expect(approvalDecisionKey(undefined, "approval-1", "13", "grant", principal)).not.toBe(base)
  expect(approvalDecisionKey(undefined, "approval-1", "12", "deny", principal)).not.toBe(base)
  expect(approvalDecisionKey(undefined, "approval-1", "12", "grant", { ...principal, id: "user-2" })).not.toBe(base)
  expect(approvalDecisionKey(undefined, "approval-1", "12", "grant", { surface: "slack", id: "user-1" })).not.toBe(base)
})
