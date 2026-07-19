// hub/attachMirror.ts
import type { AttachFrame } from "./attachHandler"
import type { PublishResult } from "./publishLink"
import type { AttachmentInfo } from "./conversations/events"

/** A conversation the mirror is allowed to publish into. */
export interface MirrorConversation { id: string; createdBy: string }

export interface AttachMirrorDeps {
  /** `shareLinks.mirrorAttachments` AND the documents pipeline being live. Off ⇒ inert. */
  enabled: boolean
  /** The conversation this agent process is currently serving, from the transport's
   *  `getLastChatId()` — never an agent-supplied id. Null for a Discord-only chat. */
  currentConversation: () => MirrorConversation | null
  /** Does the frame's (agent-supplied) `chatId` denote the same canonical conversation? */
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
  if (!deps.enabled) return { mirrored: false, reason: "disabled" }
  const conversation = deps.currentConversation()
  if (!conversation) return { mirrored: false, reason: "not_conversation" }
  if (!deps.targetsConversation(frame.chatId, conversation.id)) return { mirrored: false, reason: "chat_mismatch" }

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
