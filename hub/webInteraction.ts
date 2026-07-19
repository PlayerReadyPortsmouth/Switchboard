// hub/webInteraction.ts
// A card click that arrived from the web instead of from Discord.
//
// The whole point of this module is that it makes NO authorisation decisions of its own. It
// resolves the caller's web identity to a Discord snowflake (hub/webIdentity.ts) and then runs
// the SAME gates the Discord path runs, in the SAME order, and classifies the click with the
// SAME rules as `gateway.onNotifyButton`'s handler. Anything it decided independently would be
// a second rule set to drift out of step with the first.
//
// The agent cannot tell the difference: a click that reaches an agent goes through
// `sendInteraction`, which writes the identical `[interaction] custom_id=… user_id=… fields=…`
// frame. Note the frame carries the resolved SNOWFLAKE, not the email — an agent that
// pattern-matches on user_id must see the same value from either surface.
import { cardGateDenial, type CardGatePolicy } from "./cardGate"
import { matchGatedAction } from "./gatedActions"
import { resolveDiscordId } from "./webIdentity"
import type { CardModal, GatedAction } from "./types"

export type WebInteractionResult =
  /** Frame delivered to the owning agent. */
  | { status: "ok" }
  /** The button opens a form. Nothing has fired; the client collects `fields` and re-POSTs. */
  | { status: "modal"; modal: CardModal }
  /** Ran hub-side and never touched an agent — same as the Discord interception. */
  | { status: "handled"; action: "approval" | "gated" }
  /** Rejected. `reason` is legible and safe to show the clicker. */
  | { status: "denied"; error: WebInteractionDenial; reason: string }
  /** Accepted but undeliverable — no owning agent, or the agent is gone. */
  | { status: "unroutable"; reason: string }

export type WebInteractionDenial =
  | "web_cards_disabled"
  | "unmapped_identity"
  | "not_allowlisted"
  | "forbidden_action"

export interface WebInteractionDeps {
  /** hub.webCards.enabled. False ⇒ every call is refused and nothing is touched. */
  enabled: boolean
  /** Normalised email → Discord snowflake, from buildIdentityMap(). */
  identityMap: Map<string, string>
  /** baseGate.listAllowed() — the universal allowlist, read fresh per click so a
   *  revoked pairing takes effect immediately (the Discord path reads it per click too). */
  listAllowed: () => string[]
  /** The shared per-namespace ladder's config. */
  policy: CardGatePolicy
  /** hub.gatedActions — for hub-side interception, matching the Discord classification. */
  gatedActions: GatedAction[]
  /** Modal spec for a button, if it opens one. The gateway's `modalByCustomId` lookup. */
  modalFor: (customId: string) => CardModal | undefined
  /** Resolve an approval click hub-side. Mirrors `resolveApproval` on the Discord path. */
  resolveApproval: (id: string, decision: "grant" | "deny", userId: string) => void
  /** Parse `approval:<decision>:<id>`. The gateway's `parseApprovalCustomId`. */
  parseApproval: (customId: string) => { id: string; decision: "grant" | "deny" } | null
  /** Run a hub-side gated action. Mirrors `cardLifecycle.runGated`. */
  runGated: (action: GatedAction, customId: string) => void
  /** Deliver to the owning agent. Returns a reason when it could not be routed. This is
   *  the SAME `routeCardInteraction`-backed function the Discord path calls. */
  route: (customId: string, userId: string, fields?: Record<string, string>) => string | void
}

const DENIAL_REASONS: Record<WebInteractionDenial, string> = {
  web_cards_disabled: "Interactive cards are not enabled on this hub.",
  unmapped_identity: "Your web account is not linked to a Discord identity, so this action cannot be authorised.",
  not_allowlisted: "You are not on this hub's access list.",
  forbidden_action: "You are not authorised for this action.",
}

const deny = (error: WebInteractionDenial): WebInteractionResult =>
  ({ status: "denied", error, reason: DENIAL_REASONS[error] })

/** Handle a web card click.
 *
 *  `fields` present ⇒ this is a modal SUBMISSION, so the modal is not re-offered. Both the
 *  open and the submit run the full gate ladder: the Discord path gates `showModal` and then
 *  gates the submit's route independently, and a client that POSTed straight to the submit
 *  must not thereby skip a check. */
export function handleWebInteraction(
  identity: string,
  customId: string,
  fields: Record<string, string> | undefined,
  deps: WebInteractionDeps,
): WebInteractionResult {
  if (!deps.enabled) return deny("web_cards_disabled")

  // 1. Identity. Fail closed — an unmapped email gets no rights at all.
  const userId = resolveDiscordId(identity, deps.identityMap)
  if (!userId) return deny("unmapped_identity")

  // 2. Base gate — universal, exactly as `setPermissionAuthorizer` applies it to every
  //    Discord button before any namespace check runs.
  if (!deps.listAllowed().includes(userId)) return deny("not_allowlisted")

  // 3. The shared per-namespace ladder (approval / deploy / approverOnly).
  if (cardGateDenial(customId, userId, deps.policy) !== null) return deny("forbidden_action")

  // 4. A button that opens a modal must show the form rather than fire — the Discord path
  //    calls showModal and returns. Only on submission (fields present) does it route.
  if (!fields) {
    const modal = deps.modalFor(customId)
    if (modal) return { status: "modal", modal }
  }

  // 5. Hub-side interception, in the Discord order: approvals, then gated actions. These
  //    never reach an agent on either surface.
  const approval = deps.parseApproval(customId)
  if (approval) {
    deps.resolveApproval(approval.id, approval.decision, userId)
    return { status: "handled", action: "approval" }
  }
  const action = matchGatedAction(customId, deps.gatedActions)
  if (action) {
    deps.runGated(action, customId)
    return { status: "handled", action: "gated" }
  }

  // 6. Everything else is a card button owned by an agent. Same call, same frame.
  const reason = deps.route(customId, userId, fields)
  if (reason) return { status: "unroutable", reason }
  return { status: "ok" }
}
