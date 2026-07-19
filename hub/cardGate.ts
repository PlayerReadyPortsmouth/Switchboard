// hub/cardGate.ts
// Who may press a card button.
//
// This logic used to live inline in the `gateway.setNotifyButtonGate(...)` call in
// index.ts. It is extracted here because there is now a SECOND caller — the web
// interaction endpoint — and duplicated authorisation logic drifts. (That is exactly how
// `onPublish` and `attachMirror` ended up with the same ownership bug independently.)
// Both callers must resolve to a Discord snowflake first and then call THIS function;
// neither may re-implement any part of the ladder.
//
// Every check below is keyed on a Discord user id. The web path bridges its email
// identity to a snowflake in hub/webIdentity.ts BEFORE reaching here, and fails closed
// when it cannot — so this module never sees a web identity and needs no notion of one.
import { isDeployAuthorized } from "./deployGate"
import { requiresApprover } from "./gatedActions"
import type { GatedAction } from "./types"

/** The config this ladder reads. Supplied by index.ts from HubConfig. */
export interface CardGatePolicy {
  /** hub.deployApproverUserId — "" when unset, which denies every deploy:* click. */
  deployApproverUserId: string
  /** hub.approvals.approvers, already defaulted to [deployApproverUserId] by the caller. */
  approvalApprovers: string[]
  /** hub.gatedActions — consulted for `approverOnly`. */
  gatedActions: GatedAction[]
}

/** Why a click was refused. `null` means allowed. Callers map these to their own
 *  surface's rejection (an ephemeral Discord reply, or a 403 body). */
export type CardGateDenial = "not_approver" | "not_deploy_approver"

/** The per-namespace authorisation ladder, in the Discord order:
 *    `approval:*`  → must be a configured approver
 *    `deploy:*`    → must be the deploy approver exactly
 *    approverOnly GatedAction → must be the deploy approver
 *    anything else → allowed (it routes to an agent)
 *
 *  This does NOT check the base allowlist. The base gate is universal and applies to
 *  every surface interaction, not just card buttons, so it stays where it already is:
 *  `setPermissionAuthorizer` on the Discord side, and an explicit check on the web side.
 *  Keeping it out of here means neither caller can accidentally treat "passed the
 *  namespace ladder" as "is allowlisted". */
export function cardGateDenial(customId: string, userId: string, policy: CardGatePolicy): CardGateDenial | null {
  if (customId.startsWith("approval:")) {
    return policy.approvalApprovers.includes(userId) ? null : "not_approver"
  }
  if (!isDeployAuthorized(customId, userId, policy.deployApproverUserId)) return "not_deploy_approver"
  if (requiresApprover(customId, policy.gatedActions)) {
    const ok = !!policy.deployApproverUserId && userId === policy.deployApproverUserId
    if (!ok) return "not_deploy_approver"
  }
  return null
}

/** Boolean form, for `gateway.setNotifyButtonGate`. Byte-identical in behaviour to the
 *  expression this replaced. */
export function cardGateAllows(customId: string, userId: string, policy: CardGatePolicy): boolean {
  return cardGateDenial(customId, userId, policy) === null
}
