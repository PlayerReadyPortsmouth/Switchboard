import type { GateResult } from "../baseGate"
import type { NormalizedSurfaceEvent } from "./types"

export type SurfaceGate = (
  userId: string,
  chatId: string,
  isDM: boolean,
  threadParentId?: string,
) => GateResult

/** Layer 0 for the canonical conversation path.
 *
 *  The surface router is a SECOND, independent subscriber to the same inbound
 *  stream as the legacy orchestrator: it establishes the channel's canonical
 *  mapping and runs the turn itself. Until this existed it consulted no access
 *  control at all, so `groups[]` silently stopped applying to any channel the
 *  moment somebody spoke in it and it acquired a transport link — the gate
 *  guarded one door of two, and the config still read exactly as its author
 *  intended. A gate that guards one door is not a wall.
 *
 *  Only `deliver` admits. `pair` does NOT: a pairing code is an answer to an
 *  unpaired sender, not a permission, and it is the legacy path's job to send it
 *  (both subscribers see every message, so answering here would double it).
 *
 *  Fails closed by construction — anything that is not `deliver` is refused. */
export function admitsSurfaceEvent(event: NormalizedSurfaceEvent, gate: SurfaceGate): boolean {
  return gate(event.authorId, event.externalLocationId, event.isDM === true, event.threadParentId).action === "deliver"
}
