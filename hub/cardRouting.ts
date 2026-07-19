// hub/cardRouting.ts
// The decision a card-button / modal-submit click makes: which agent owns this button,
// is that agent still there, and if not — what do we tell the person who clicked?
//
// Extracted from index.ts so the failure modes are unit-testable without Discord or a
// live transport. index.ts supplies the real lookups.

/** The subset of a transport this path needs. */
export interface InteractionTarget {
  sendInteraction(customId: string, userId: string, fields?: Record<string, string>): void
}

export interface CardRouteDeps {
  /** NotifyRouter.agentFor */
  agentFor(customId: string): string | undefined
  /** transports.get */
  transportFor(key: string): InteractionTarget | undefined
  /** hub.cardPersistence.enabled — gates the legible-failure reporting. */
  persistenceOn: boolean
}

export const UNKNOWN_BUTTON_MESSAGE =
  "⚠️ This button is no longer active — it's older than the hub's card retention window, so its routing was not restored. Ask the agent to repost the card."

export function orphanedAgentMessage(key: string): string {
  return `⚠️ Nothing ran — the agent that owns this button (\`${key}\`) is no longer running. It may have been renamed, removed, or was a one-off worker that ended.`
}

/** Route a click to its owning agent. Returns undefined when delivered; a
 *  human-readable reason when it could not be.
 *
 *  With `persistenceOn` false this returns undefined in EVERY branch — i.e. the
 *  historic silent no-op, byte-identical to the pre-fix `if (key) transports.get(key)
 *  ?.sendInteraction(...)`. The legible failures are part of the flagged change,
 *  because pre-fix every post-restart click hit them and reporting them all
 *  unconditionally would be a user-visible behaviour change outside the flag. */
export function routeCardInteraction(
  customId: string,
  userId: string,
  fields: Record<string, string> | undefined,
  deps: CardRouteDeps,
): string | void {
  const key = deps.agentFor(customId)
  if (!key) return deps.persistenceOn ? UNKNOWN_BUTTON_MESSAGE : undefined
  const target = deps.transportFor(key)
  // The card outlived its agent: renamed/removed from the registry, or an ephemeral
  // worker (jobId / clone / thread key) that died with the last restart. Persisting
  // the routing table makes this reachable, so it must fail loudly, not freeze.
  if (!target) return deps.persistenceOn ? orphanedAgentMessage(key) : undefined
  target.sendInteraction(customId, userId, fields)
}
