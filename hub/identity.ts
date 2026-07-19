// hub/identity.ts
//
// Who counts as a HUMAN, for the purposes of stamping ownership on an artifact.
//
// Identities in this hub come in two shapes, and only one of them is a person who can ever
// authenticate:
//
//   human    `Aurora.Nicholas@player-ready.co.uk`  — an Entra email. The ONLY way one of these
//            reaches `Conversation.createdBy` is `ConversationService.create(identity, …)`,
//            whose `identity` is `deps.requireUser(req)` — the email header the ReadyApp proxy
//            sets on an authenticated web request (see hub/webServer.ts).
//
//   synthetic `system:discord-migration`  — the creator stamped on every canonically-migrated
//            Discord channel (hub/conversations/channelMigration.ts)
//            `discord:186188409499418628`  — a Discord participant
//            `agent:dev-agent`, `upload`, `discord`  — producers/owners used elsewhere
//            None of these is ever a value `requireUser` can return, so no request can ever
//            arrive claiming to be one.
//
// Why an email-shaped ALLOWLIST rather than a `system:` / `discord:` denylist:
//
// This predicate decides between two failure modes, and they are wildly asymmetric.
//   - Guess "human" when it isn't  ⇒ the document is stamped private to an identity nobody can
//     authenticate as, and `readDocumentContent` returns `forbidden` to EVERY caller, forever.
//     It is unrecoverable without a DB write. This is the bug that shipped.
//   - Guess "synthetic" when it isn't ⇒ the document lands org-visible instead of private:
//     visible to authenticated staff who could already see the conversation, and the owner can
//     still narrow it later. Recoverable, and bounded by the same auth wall.
//
// A denylist fails OPEN into the unrecoverable case: the next synthetic identity anyone
// introduces — `system:`-prefixed or not — is unknown to the list and silently treated as a
// person, reproducing this exact bug. An allowlist fails CLOSED into the recoverable one. That
// is also the house style: "fail closed, never throw on the hot path" (CLAUDE.md).
//
// The shape test is the same one `humanizeIdentity` (hub/displayName.ts) already applies when
// it decides whether an identity is a renderable person: exactly one "@", with a non-empty
// local part and domain. Kept deliberately loose — this is a human-vs-machine discriminator,
// not an RFC 5322 validator, and it is not a security boundary. Access control stays where it
// belongs, in `readDocumentContent`'s visibility check; this only decides how a NEW document
// is stamped.

/** Is this identity a real person who could authenticate and open a private document?
 *  Email-shaped ⇒ human. Everything else (`system:…`, `discord:…`, agent names, empty) ⇒ not. */
export function isHumanIdentity(identity: string | null | undefined): boolean {
  if (typeof identity !== "string") return false
  const at = identity.indexOf("@")
  return at > 0 && at === identity.lastIndexOf("@") && at !== identity.length - 1
}

/** The conversation slice ownership is derived from. */
export interface OwnableConversation { id: string; createdBy: string }

/** The ownership fields to stamp on a document published into `conversation`.
 *
 *  This is the single place that decision is made. Both publish paths — `mirrorAttachment`
 *  (hub/attachMirror.ts) and `socket.onPublish` (hub/index.ts) — call it rather than reading
 *  `createdBy` themselves, so they cannot drift apart again; they had the same bug precisely
 *  because each inlined its own version of this.
 *
 *  A human-created (web) conversation stamps its creator, which makes `publishDocument` default
 *  the document to "private" — it belongs in that person's library. A conversation with no human
 *  owner (a migrated Discord channel is a shared space, created by `system:discord-migration`)
 *  publishes OWNERLESS, which `publishDocument` leaves visibility-less and `rowFromSbmd`
 *  reconciles into the org-visible "discord" bucket. That is the correct semantic for a shared
 *  channel, not a workaround: there is no one person whose private library it belongs in.
 *
 *  `conversationId` is stamped either way — the document is part of that transcript regardless
 *  of who, or whether anyone, owns it. */
export function documentOwnership(
  conversation: OwnableConversation | null | undefined,
): { ownerId?: string; ownerName?: string; conversationId?: string } {
  if (!conversation) return {}
  if (!isHumanIdentity(conversation.createdBy)) return { conversationId: conversation.id }
  return {
    ownerId: conversation.createdBy,
    ownerName: conversation.createdBy,
    conversationId: conversation.id,
  }
}
