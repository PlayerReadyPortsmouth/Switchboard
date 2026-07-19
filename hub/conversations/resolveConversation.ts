// hub/conversations/resolveConversation.ts
// Chat id → canonical conversation id, in ONE place.
//
// A conversation has more than one identifier. The web surface knows it by its UUID; an
// agent serving the same conversation through its Discord mirror only ever saw the raw
// CHANNEL snowflake, and that is what lands in its reply/attach/tool frames. Every hub
// path that wants "which conversation is this?" therefore has to accept both.
//
// Three call sites hand-rolled that lookup independently and two of them got it wrong the
// same way — they asked `getConversation(chatId)`, which is keyed by UUID only, so every
// Discord-linked conversation resolved to null and the feature silently no-op'd in prod:
//
//   * the attach mirror         → `chat_mismatch` on every mirrored attachment  (fixed, PR #48)
//   * the canonical card path   → `web_cards` stayed empty; no card ever reached the web
//                                 transcript, and no `card` event was ever published
//
// `chatTargetsConversation` (hub/attachMirror.ts) solved the CORROBORATION direction —
// "is this chat id one of THIS already-resolved conversation's identifiers?" — which is
// all the attach mirror needs and which, by construction, cannot map a chat id onto a
// conversation. This is the other direction, for callers that have only a chat id.
//
// SECURITY — this deliberately does not widen what an agent can address. Callers already
// accepted any conversation UUID the agent named (`getConversation(chatId)` is unscoped);
// resolving a linked external id reaches the *same* set of conversations by a second name,
// never a conversation that was previously unreachable. It reads only the hub's own
// `conversations` / `transport_links` tables — nothing agent-supplied beyond the chat id
// itself decides the answer. Membership/authorisation is still the caller's business.
//
// NOT for ownership decisions. `onPublish` and `mirrorAttachment.currentConversation` look
// the same but feed `documentOwnership`, where resolving a Discord channel to a
// human-created conversation would flip an org-visible document to private and break the
// share link for everyone else in that channel. Those stay as they are on purpose.

/** The slice of `ConversationRepository` this needs. Structural so tests can pass a stub. */
export interface ConversationIdLookup {
  getConversation(id: string): { id: string } | null
  resolveTransportLink(adapter: string, externalLocationId: string): { conversationId: string } | null
}

/** Adapters whose external location ids may name a conversation. Only Discord links exist
 *  today; a future adapter joins the list here rather than at four call sites. */
export const LINKED_ADAPTERS = ["discord"] as const

/** The canonical conversation id for `chatId`, whether that is already a conversation UUID
 *  or the external location id of one of its transport links. `null` when the chat has no
 *  canonical conversation at all (a Discord-only channel, a consult/mission virtual
 *  channel, an unknown id) — callers treat that as "there is no web surface here" and do
 *  nothing, exactly as before. */
export function resolveConversationId(
  repo: ConversationIdLookup,
  chatId: string,
  adapters: readonly string[] = LINKED_ADAPTERS,
): string | null {
  if (!chatId) return null
  try {
    const direct = repo.getConversation(chatId)
    if (direct) return direct.id
    for (const adapter of adapters) {
      const link = repo.resolveTransportLink(adapter, chatId)
      if (!link) continue
      // A link whose conversation has since been deleted is not a resolution: returning the
      // dangling id would write rows against a conversation no surface can render.
      const linked = repo.getConversation(link.conversationId)
      if (linked) return linked.id
    }
    return null
  } catch {
    // House style: observability/mirror paths never throw on the agent hot path. A broken
    // conversation DB degrades to "the web shows nothing", it does not fail the reply.
    return null
  }
}
