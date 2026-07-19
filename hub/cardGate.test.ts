// The per-namespace card-button gate, extracted from the inline `setNotifyButtonGate` wiring
// in index.ts so the Discord path and the web path share one implementation.
//
// The first block is a PARITY test: it re-states the exact expression that used to live inline
// and asserts the extracted function agrees with it on every combination. If a future edit
// changes the ladder's meaning, this fails — which is the point, because the Discord path's
// behaviour must not drift while the web path is being built on top of it.
import { describe, expect, test } from "bun:test"
import { cardGateAllows, cardGateDenial, type CardGatePolicy } from "./cardGate"
import { isDeployAuthorized } from "./deployGate"
import { requiresApprover } from "./gatedActions"
import type { GatedAction } from "./types"

const APPROVER = "111111111111111111"
const OTHER = "222222222222222222"

const GATED: GatedAction[] = [
  { namespace: "ops", action: "restart", approverOnly: true, command: "echo restart" } as GatedAction,
  { namespace: "ops", action: "ping", command: "echo ping" } as GatedAction,
]

/** Verbatim copy of the expression that was inline in hub/index.ts before extraction. */
function legacyGate(customId: string, userId: string, deployApprover: string, approvalApprovers: string[], gatedActions: GatedAction[]): boolean {
  if (customId.startsWith("approval:")) return approvalApprovers.includes(userId)
  return isDeployAuthorized(customId, userId, deployApprover) &&
    (requiresApprover(customId, gatedActions) ? !!deployApprover && userId === deployApprover : true)
}

describe("parity with the pre-extraction inline gate", () => {
  const CUSTOM_IDS = [
    "approval:grant:abc", "approval:deny:abc",
    "deploy:go:481", "deploy:rollback:481",
    "ops:restart:api", "ops:ping:api",
    "ticket:ack:7", "mem:next:corr", "no_colons_at_all", "",
  ]
  const APPROVERS = [[APPROVER], [], [APPROVER, OTHER]]
  const DEPLOYERS = [APPROVER, ""]

  test("agrees on every combination of customId, user, and config", () => {
    let checked = 0
    for (const customId of CUSTOM_IDS) {
      for (const userId of [APPROVER, OTHER]) {
        for (const approvalApprovers of APPROVERS) {
          for (const deployApproverUserId of DEPLOYERS) {
            const policy: CardGatePolicy = { deployApproverUserId, approvalApprovers, gatedActions: GATED }
            expect(cardGateAllows(customId, userId, policy))
              .toBe(legacyGate(customId, userId, deployApproverUserId, approvalApprovers, GATED))
            checked++
          }
        }
      }
    }
    expect(checked).toBe(CUSTOM_IDS.length * 2 * APPROVERS.length * DEPLOYERS.length)
  })
})

describe("the ladder", () => {
  const policy: CardGatePolicy = {
    deployApproverUserId: APPROVER, approvalApprovers: [APPROVER], gatedActions: GATED,
  }

  test("approval:* requires a configured approver", () => {
    expect(cardGateDenial("approval:grant:x", APPROVER, policy)).toBeNull()
    expect(cardGateDenial("approval:grant:x", OTHER, policy)).toBe("not_approver")
  })

  test("deploy:* requires the deploy approver exactly", () => {
    expect(cardGateDenial("deploy:go:1", APPROVER, policy)).toBeNull()
    expect(cardGateDenial("deploy:go:1", OTHER, policy)).toBe("not_deploy_approver")
  })

  test("an approverOnly gated action requires the deploy approver", () => {
    expect(cardGateDenial("ops:restart:api", APPROVER, policy)).toBeNull()
    expect(cardGateDenial("ops:restart:api", OTHER, policy)).toBe("not_deploy_approver")
  })

  test("an ordinary gated action and a plain card button pass for anyone", () => {
    expect(cardGateDenial("ops:ping:api", OTHER, policy)).toBeNull()
    expect(cardGateDenial("ticket:ack:7", OTHER, policy)).toBeNull()
  })

  test("with no deploy approver configured, deploy:* denies everyone", () => {
    const none: CardGatePolicy = { deployApproverUserId: "", approvalApprovers: [], gatedActions: GATED }
    expect(cardGateDenial("deploy:go:1", APPROVER, none)).toBe("not_deploy_approver")
    expect(cardGateDenial("ops:restart:api", APPROVER, none)).toBe("not_deploy_approver")
  })

  test("the ladder does NOT imply the base allowlist — that gate is separate and universal", () => {
    // A plain button passes the ladder for a user who may not be paired at all. Callers must
    // run the base gate themselves; this asserts the boundary is where the doc comment says.
    expect(cardGateAllows("ticket:ack:7", "999999999999999999", policy)).toBe(true)
  })
})
