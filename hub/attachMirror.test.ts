import { test, expect } from "bun:test"
import {
  mirrorAttachment, chatTargetsConversation,
  type AttachMirrorDeps, type MirrorConversation, type MirrorConversationLookup,
} from "./attachMirror"
import { makeAttachHandler, type AttachDeps } from "./attachHandler"
import type { PublishResult } from "./publishLink"
import type { AttachmentInfo } from "./conversations/events"

const CONVERSATION: MirrorConversation = { id: "conv-1", createdBy: "aurora@player-ready.co.uk" }

const okResult = (token = "tok1"): PublishResult => ({
  ok: true, url: `https://ra/share/${token}`, token, sizeBytes: 196,
  sbmd: {
    v: 1, mode: "view", contentType: "text/markdown", filename: "test-file.md",
    title: "test-file.md", scope: "staff", createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "", producer: "agent:dev-agent",
    ownerId: CONVERSATION.createdBy, ownerName: CONVERSATION.createdBy, visibility: "private",
  },
})

function harness(over: Partial<AttachMirrorDeps> = {}) {
  const stored: Record<string, unknown>[] = []
  const emitted: { conversationId: string; info: AttachmentInfo }[] = []
  const audits: { ok: boolean; detail: Record<string, unknown> }[] = []
  const deps: AttachMirrorDeps = {
    enabled: true,
    currentConversation: () => CONVERSATION,
    targetsConversation: (chatId, conversationId) => chatId === conversationId,
    store: async (a) => { stored.push(a); return okResult() },
    emit: (conversationId, info) => { emitted.push({ conversationId, info }) },
    audit: (ok, detail) => { audits.push({ ok, detail }) },
    ...over,
  }
  return { deps, stored, emitted, audits }
}

const frame = { chatId: "conv-1", path: "test-file.md" }

test("a web conversation stores the document and emits the inline transcript card", async () => {
  const { deps, stored, emitted } = harness()
  expect(await mirrorAttachment(frame, deps)).toEqual({ mirrored: true, token: "tok1" })
  // Ownership follows onPublish: the conversation's creator, stamped onto the mirror row.
  expect(stored).toEqual([{
    path: "test-file.md",
    ownerId: CONVERSATION.createdBy, ownerName: CONVERSATION.createdBy, conversationId: "conv-1",
  }])
  expect(emitted).toEqual([{
    conversationId: "conv-1",
    info: { token: "tok1", title: "test-file.md", contentType: "text/markdown", mode: "view", visibility: "private" },
  }])
})

test("an explicit display filename becomes the document title", async () => {
  const { deps, stored } = harness()
  await mirrorAttachment({ ...frame, filename: "Weekly Report.md" }, deps)
  expect(stored[0]!.title).toBe("Weekly Report.md")
})

test("flag off ⇒ nothing is stored or emitted", async () => {
  const { deps, stored, emitted, audits } = harness({ enabled: false })
  expect(await mirrorAttachment(frame, deps)).toEqual({ mirrored: false, reason: "disabled" })
  expect(stored).toEqual([])
  expect(emitted).toEqual([])
  expect(audits).toEqual([])
})

test("a Discord-only chat (no canonical conversation) is not mirrored", async () => {
  const { deps, stored, emitted } = harness({ currentConversation: () => null })
  expect(await mirrorAttachment({ chatId: "123456789", path: "test-file.md" }, deps))
    .toEqual({ mirrored: false, reason: "not_conversation" })
  expect(stored).toEqual([])
  expect(emitted).toEqual([])
})

test("a frame aimed at a different chat than the turn being served is not mirrored", async () => {
  const { deps, stored, emitted } = harness()
  expect(await mirrorAttachment({ chatId: "some-other-chat", path: "test-file.md" }, deps))
    .toEqual({ mirrored: false, reason: "chat_mismatch" })
  expect(stored).toEqual([])
  expect(emitted).toEqual([])
})

test("oversize is rejected by the documents pipeline without emitting a card", async () => {
  const { deps, emitted, audits } = harness({ store: async () => ({ ok: false, reason: "oversize" }) })
  expect(await mirrorAttachment(frame, deps)).toEqual({ mirrored: false, reason: "oversize" })
  expect(emitted).toEqual([])
  expect(audits).toEqual([{ ok: false, detail: { reason: "oversize" } }])
})

test("a throwing document write is contained, not propagated", async () => {
  const { deps, emitted } = harness({ store: async () => { throw new Error("ENOSPC") } })
  const r = await mirrorAttachment(frame, deps)
  expect(r.mirrored).toBe(false)
  expect(emitted).toEqual([])
})

test("a throwing event publish is contained too", async () => {
  const { deps } = harness({ emit: () => { throw new Error("stream closed") } })
  expect(await mirrorAttachment(frame, deps)).toEqual({ mirrored: false, reason: "emit_threw" })
})

// ---- chat-id corroboration: the real-world Discord-channel-id case ----
//
// The frame's chatId is whatever the agent last saw, which for a conversation that also has a
// Discord transport link is the raw CHANNEL id — not the conversation UUID. Prod audit for the
// failing attach: {"action":"attach","chat":"1496399854593904690",...} while the transport's
// getLastChatId() resolved conversation 659bcc60-…. Same conversation, two identifiers.

const SERVED = "659bcc60-25d4-49b2-b969-540e5941b9e6"
const CHANNEL = "1496399854593904690"

/** A repo where SERVED is linked to Discord channel CHANNEL, and a second, unrelated
 *  conversation OTHER is linked to channel 999. */
const repo: MirrorConversationLookup = {
  getConversation: (id) => (id === SERVED || id === "other-conv" ? { id } : null),
  listTransportLinks: (conversationId) =>
    conversationId === SERVED ? [{ externalLocationId: CHANNEL }]
      : conversationId === "other-conv" ? [{ externalLocationId: "999" }]
        : [],
}

test("a chat id that is the conversation's own UUID still corroborates", () => {
  expect(chatTargetsConversation(repo, SERVED, SERVED)).toBe(true)
})

test("a Discord channel id linked to the served conversation corroborates it", () => {
  expect(chatTargetsConversation(repo, CHANNEL, SERVED)).toBe(true)
})

test("a Discord channel id linked to a DIFFERENT conversation does not corroborate", () => {
  // The security property: an agent cannot borrow another conversation's channel id.
  expect(chatTargetsConversation(repo, "999", SERVED)).toBe(false)
  expect(chatTargetsConversation(repo, CHANNEL, "other-conv")).toBe(false)
})

test("an unknown chat id corroborates nothing", () => {
  expect(chatTargetsConversation(repo, "1111111111", SERVED)).toBe(false)
  expect(chatTargetsConversation(repo, "", SERVED)).toBe(false)
})

test("a frame carrying the served conversation's Discord channel id DOES mirror", async () => {
  const conversation: MirrorConversation = { id: SERVED, createdBy: "aurora@player-ready.co.uk" }
  const { deps, stored, emitted } = harness({
    currentConversation: () => conversation,
    targetsConversation: (chatId, conversationId) => chatTargetsConversation(repo, chatId, conversationId),
  })
  expect(await mirrorAttachment({ chatId: CHANNEL, path: "test-file.md" }, deps))
    .toEqual({ mirrored: true, token: "tok1" })
  // Still stamped with the TRANSPORT-resolved conversation, never the frame's id.
  expect(stored[0]!.conversationId).toBe(SERVED)
  expect(emitted[0]!.conversationId).toBe(SERVED)
})

test("a channel id belonging to another conversation is still rejected end to end", async () => {
  const conversation: MirrorConversation = { id: SERVED, createdBy: "aurora@player-ready.co.uk" }
  const { deps, stored, emitted, audits } = harness({
    currentConversation: () => conversation,
    targetsConversation: (chatId, conversationId) => chatTargetsConversation(repo, chatId, conversationId),
  })
  expect(await mirrorAttachment({ chatId: "999", path: "test-file.md" }, deps))
    .toEqual({ mirrored: false, reason: "chat_mismatch" })
  expect(stored).toEqual([])
  expect(emitted).toEqual([])
  // and the bail-out is auditable, not silent
  expect(audits).toEqual([{ ok: false, detail: { reason: "chat_mismatch", chat: "999", conversation: SERVED } }])
})

// ---- bail-outs must be greppable ----

test("a Discord-only chat records why it was skipped", async () => {
  const { deps, audits } = harness({ currentConversation: () => null })
  await mirrorAttachment({ chatId: "1496399854593904690", path: "test-file.md" }, deps)
  expect(audits).toEqual([{ ok: false, detail: { reason: "not_conversation", chat: "1496399854593904690" } }])
})

// ---- composition with the Discord send: the mirror must never change the attach outcome ----

function attachHarness(deliver = true) {
  const sent: { chatId: string; names: string[] }[] = []
  const notes: string[] = []
  const deps: AttachDeps = {
    enabled: true,
    resolve: () => ({ ok: true, absPath: "/outbox/dev-agent/test-file.md", filename: "test-file.md", size: 196, bytes: Buffer.from("x") }),
    sendFiles: async (chatId, attachments) => { sent.push({ chatId, names: attachments.map(a => a.name) }); return deliver },
    note: (_c, t) => { notes.push(t) },
    audit: () => {},
  }
  return { handler: makeAttachHandler(deps), sent, notes }
}

test("the Discord attachment still posts exactly once when the document write fails", async () => {
  const { handler, sent, notes } = attachHarness()
  const outcome = await handler(frame)
  const { deps } = harness({ store: async () => { throw new Error("disk full") } })
  const mirror = await mirrorAttachment(frame, deps)

  expect(outcome).toEqual({ ok: true })          // the agent still sees a delivered attach
  expect(sent).toEqual([{ chatId: "conv-1", names: ["test-file.md"] }])  // no double-post
  expect(notes).toEqual([])
  expect(mirror.mirrored).toBe(false)
})

test("a failed Discord delivery is reported as before and the mirror is never reached", async () => {
  const { handler, notes } = attachHarness(false)
  const outcome = await handler(frame)
  expect(outcome).toEqual({ ok: false, error: "could not deliver to Discord" })
  expect(notes).toEqual(["⚠️ attach failed: could not deliver to Discord"])
})
