// hub/attachMirror.ts
import type { AttachFrame } from "./attachHandler"
import type { PublishResult } from "./publishLink"
import type { AttachmentInfo } from "./conversations/events"

/** A conversation the mirror is allowed to publish into. */
export interface MirrorConversation { id: string; createdBy: string }

/** The slice of `ConversationRepository` the corroboration check needs. */
export interface MirrorConversationLookup {
  getConversation(id: string): { id: string } | null
  listTransportLinks(conversationId: string): { externalLocationId: string }[]
}

/** Does the frame's agent-supplied `chatId` denote the SAME canonical conversation as
 *  `conversationId` — the one the transport says this process is serving?
 *
 *  A conversation has more than one identifier. The web surface knows it by its UUID, but an
 *  agent serving a conversation that is also mirrored to Discord last saw the raw CHANNEL id,
 *  so that is what lands in the frame. Matching only on the UUID (or on `getConversation`,
 *  which is keyed by UUID) made every Discord-linked conversation fail as `chat_mismatch` and
 *  the mirror silently no-op'd in prod.
 *
 *  This is deliberately a CORROBORATION check, not a lookup: it starts from the conversation
 *  the caller already resolved from the transport and asks whether `chatId` is one of THAT
 *  conversation's own identifiers. It never maps a chat id to a conversation, so an agent
 *  still cannot name someone else's channel — an unrelated channel id resolves to an unrelated
 *  conversation, which is not in this conversation's link set, and is rejected exactly as
 *  before. Widening the identifiers accepted for one conversation is not the same as letting
 *  the frame choose the conversation, and only the former changes here. */
export function chatTargetsConversation(
  repo: MirrorConversationLookup, chatId: string, conversationId: string,
): boolean {
  if (!chatId) return false
  if (chatId === conversationId) return true
  if (repo.getConversation(chatId)?.id === conversationId) return true
  // Adapter-agnostic on purpose: any transport link of THIS conversation counts, so a Matrix
  // or Slack link works the same way without a second fix. Link sets are single digits.
  try {
    return repo.listTransportLinks(conversationId).some(l => l.externalLocationId === chatId)
  } catch { return false }  // observability path; never throw on the attach hot path
}

export interface AttachMirrorDeps {
  /** `shareLinks.mirrorAttachments` AND the documents pipeline being live. Off ⇒ inert. */
  enabled: boolean
  /** The conversation this agent process is currently serving, from the transport's
   *  `getLastChatId()` — never an agent-supplied id. Null for a Discord-only chat. */
  currentConversation: () => MirrorConversation | null
  /** Does the frame's (agent-supplied) `chatId` corroborate the same canonical conversation?
   *  See `chatTargetsConversation`, which is what the hub passes here. */
  targetsConversation: (chatId: string, conversationId: string) => boolean
  /** Route the attached bytes through the documents pipeline (publishDocument). */
  store: (args: { path: string; title?: string; ownerId: string; ownerName: string; conversationId: string })
    => Promise<PublishResult>
  /** Emit the inline transcript card. */
  emit: (conversationId: string, info: AttachmentInfo) => void
  /** Observability only — never affects the Discord outcome. */
  audit?: (ok: boolean, detail: Record<string, unknown>) => void
}

export type MirrorOutcome =
  | { mirrored: true; token: string }
  | { mirrored: false; reason: "disabled" | "not_conversation" | "chat_mismatch" | string }

/** Mirror an already-delivered Discord attachment into the web transcript.
 *
 *  Runs strictly AFTER the native Discord send has succeeded and its result is never
 *  allowed to change that outcome: every failure path here (flag off, Discord-only chat,
 *  oversize for `shareLinks.maxBytes`, a disk/DB write blowing up) returns a non-mirrored
 *  outcome and the caller still reports the attach as delivered. Degrade, don't fail.
 *
 *  Ownership follows `onPublish`: a web conversation stamps its creator's identity, which
 *  makes the document default to "private" in `publishDocument`. The conversation itself is
 *  resolved from the TRANSPORT's last chat id, not from the frame, so an agent cannot stamp a
 *  document onto a conversation it is not currently serving; the frame's chat id only has to
 *  agree with it. A chat that resolves to no conversation is never mirrored — there is no web
 *  surface to render into, and an ownerless mirror would only litter the org bucket. */
export async function mirrorAttachment(frame: AttachFrame, deps: AttachMirrorDeps): Promise<MirrorOutcome> {
  // `disabled` is deliberately NOT audited: with the flag off it is the outcome of every single
  // attach, so a record here would be pure noise in the audit log and would say nothing the flag
  // state doesn't already say. (At the hub call site the mirror isn't even composed when the flag
  // is off, so this branch is only reachable from tests.) The other two bail-outs are the
  // opposite: they mean the flag IS on and a mirror was expected but didn't happen, which is
  // exactly the signal that was missing when this failed invisibly in prod.
  if (!deps.enabled) return { mirrored: false, reason: "disabled" }
  const conversation = deps.currentConversation()
  if (!conversation) {
    deps.audit?.(false, { reason: "not_conversation", chat: frame.chatId })
    return { mirrored: false, reason: "not_conversation" }
  }
  if (!deps.targetsConversation(frame.chatId, conversation.id)) {
    deps.audit?.(false, { reason: "chat_mismatch", chat: frame.chatId, conversation: conversation.id })
    return { mirrored: false, reason: "chat_mismatch" }
  }

  let r: PublishResult
  try {
    r = await deps.store({
      path: frame.path,
      ...(frame.filename ? { title: frame.filename } : {}),
      ownerId: conversation.createdBy, ownerName: conversation.createdBy,
      conversationId: conversation.id,
    })
  } catch (error) {
    deps.audit?.(false, { reason: "store_threw", error: String(error) })
    return { mirrored: false, reason: "store_threw" }
  }
  if (!r.ok) {
    deps.audit?.(false, { reason: r.reason })
    return { mirrored: false, reason: r.reason }
  }

  try {
    deps.emit(conversation.id, {
      token: r.token, title: r.sbmd.title, contentType: r.sbmd.contentType,
      mode: r.sbmd.mode, visibility: r.sbmd.visibility ?? "org",
    })
  } catch (error) {
    deps.audit?.(false, { reason: "emit_threw", error: String(error), token: r.token })
    return { mirrored: false, reason: "emit_threw" }
  }
  deps.audit?.(true, { token: r.token, conversation: conversation.id })
  return { mirrored: true, token: r.token }
}
