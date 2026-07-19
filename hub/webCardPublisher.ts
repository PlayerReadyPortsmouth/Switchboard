// hub/webCardPublisher.ts
// The canonical card path: persist a card into `web_cards` and publish the live `card`
// event so the web transcript renders it and a reload can rehydrate it.
//
// Extracted from the inline closure in index.ts for the same reason cardGate.ts and
// attachMirror.ts were: index.ts cannot be imported by a test (it boots a hub), so the
// closure's guard was untestable — and the guard was wrong. It asked
// `conversationRepo.getConversation(reply.chatId)`, which is keyed by conversation UUID,
// while an agent posting into a Discord channel supplies the channel snowflake. The lookup
// returned null for every Discord-linked conversation, the guard returned early, and no
// card was ever recorded or published: `web_cards` held 0 rows in prod while the separate
// `cards.sqlite` store captured the very same cards correctly.
//
// The store is keyed by correlationId, so posts and edits both land here: `update_card`
// re-emits the same correlationId and the store turns that into revision N+1 of ONE card.
// That means the update path shares this resolution — and shared exactly the same bug.
import type { CardInfo } from "./conversations/events"
import type { CardSpec } from "./types"
import type { WebCardStore } from "./webCardStore"

/** The reply fields this path reads. Structural so both `card` and `update` replies fit. */
export interface WebCardReply {
  chatId: string
  agent: string
  correlationId?: string | undefined
}

export interface WebCardPublishDeps {
  /** Null when `hub.webCards.enabled` is off ⇒ inert. */
  store: WebCardStore | null
  /** Chat id → canonical conversation UUID. The hub passes `resolveConversationId`, which
   *  accepts a UUID or a linked external id; never the raw chat id. */
  resolveConversation: (chatId: string) => string | null
  /** Publish the live `card` event (the hub builds it from `CardInfo`). */
  publish: (info: CardInfo) => void
  /** Observability only; never allowed to fail the reply. */
  onError?: (error: unknown) => void
}

export type WebCardPublishOutcome =
  /** `hub.webCards` off. */
  | "disabled"
  /** No correlationId — the card could never be matched by a later edit, so it is not stored
   *  under a synthetic id that no update could ever find again. */
  | "no_correlation"
  /** The chat resolves to no canonical conversation (Discord-only channel, consult/mission
   *  virtual channel, unknown id). There is no web surface to render into. */
  | "no_conversation"
  /** The store swallowed a write error and returned null; nothing to publish. */
  | "not_stored"
  | "published"
  | "error"

/** Record the card against its canonical conversation and publish the live event.
 *
 *  Strictly additive: this runs alongside the legacy Discord card path and never touches
 *  it, so Discord delivery is byte-identical whether this succeeds, bails, or throws. */
export function publishCardToWeb(
  reply: WebCardReply, card: CardSpec, deps: WebCardPublishDeps,
): WebCardPublishOutcome {
  if (!deps.store) return "disabled"
  const correlationId = reply.correlationId
  if (!correlationId) return "no_correlation"
  // The conversation is derived from the hub's own conversation/transport-link state, not
  // taken from the frame: the frame only supplies the chat id it is already serving, and an
  // id that names nothing here resolves to null and stores nothing.
  const conversationId = deps.resolveConversation(reply.chatId)
  if (!conversationId) return "no_conversation"
  try {
    // conversationId, NOT reply.chatId — the old code stored the raw chat id in the
    // conversation_id column, so even a card that got past the guard was filed under an id
    // `listByConversation` would never look up.
    const info = deps.store.record({ correlationId, conversationId, agent: reply.agent, card })
    if (!info) return "not_stored"
    deps.publish(info)
    return "published"
  } catch (error) {
    deps.onError?.(error)
    return "error"
  }
}
