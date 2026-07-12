import { test, expect } from "bun:test"
import { Gateway, buildCardComponents, parseNotifyCustomId, extractForwards } from "./gateway"
import { isDeployAuthorized } from "./deployGate"
import { ChannelType, MessageReferenceType } from "discord.js"

test("extractForwards reads forwarded snapshots (content + attachments), no author", () => {
  const att = new Map([["a1", { id: "a1", name: "shot.png", contentType: "image/png", size: 2048, url: "http://x/shot.png" }]])
  const msg = {
    messageSnapshots: new Map([["m1", { content: "forwarded body", attachments: att }]]),
  }
  expect(extractForwards(msg)).toEqual([
    { content: "forwarded body", attachments: [{ name: "shot.png", type: "image/png", size: 2048, url: "http://x/shot.png" }] },
  ])
})

test("extractForwards is empty when there are no snapshots", () => {
  expect(extractForwards({})).toEqual([])
  expect(extractForwards({ messageSnapshots: new Map() })).toEqual([])
})

test("extractForwards tolerates a snapshot with no content and no attachments", () => {
  const msg = { messageSnapshots: new Map([["m1", {}]]) }
  expect(extractForwards(msg)).toEqual([{ content: "", attachments: [] }])
})

test("extractForwards falls back to id/unknown for nameless attachments", () => {
  const att = new Map([["a1", { id: "a1", size: 10 }]])
  const msg = { messageSnapshots: new Map([["m1", { content: "x", attachments: att }]]) }
  expect(extractForwards(msg)).toEqual([
    { content: "x", attachments: [{ name: "a1", type: "unknown", size: 10, url: undefined }] },
  ])
})

test("extractForwards renders a rich embed into the snapshot content (no typed text)", () => {
  const msg = {
    messageSnapshots: new Map([["m1", {
      content: "",
      embeds: [{
        title: "Deploy #40 — Complete",
        fields: [{ name: "Branch", value: "live" }, { name: "Step", value: "done" }],
        url: "http://x/deploy/40",
      }],
    }]]),
  }
  expect(extractForwards(msg)).toEqual([{
    content: "Deploy #40 — Complete\nBranch: live\nStep: done\nhttp://x/deploy/40",
    attachments: [],
  }])
})

test("extractForwards appends embed text after typed content", () => {
  const msg = {
    messageSnapshots: new Map([["m1", {
      content: "see this card",
      embeds: [{ description: "the body" }],
    }]]),
  }
  expect(extractForwards(msg)).toEqual([{ content: "see this card\n\nthe body", attachments: [] }])
})

test("buildCardComponents maps CardSpec buttons to an embed + action row", () => {
  const { embed, row } = buildCardComponents({
    title: "Build failed", body: "logs…",
    fields: [{ name: "Branch", value: "main" }],
    buttons: [
      { customId: "action:retry:B-1", label: "Retry", style: "success", emoji: "🔧" },
      { customId: "action:dismiss:B-1", label: "Dismiss", style: "danger" },
    ],
  })
  expect(embed.data.title).toBe("Build failed")
  expect(row!.components.length).toBe(2)
  expect((row!.components[0].data as any).custom_id).toBe("action:retry:B-1")
})

test("buildCardComponents survives a malformed card (empty body, no buttons, oversized)", () => {
  // empty body must not throw (Discord rejects an empty description)
  const a = buildCardComponents({ title: "T", body: "", buttons: [] })
  expect(a.embed.data.description).toBeUndefined()
  expect(a.row).toBeUndefined()
  // title + body both empty → a placeholder description, still no row
  const b = buildCardComponents({ title: "", body: "", buttons: [] })
  expect(b.embed.data.description).toBe("(no details)")
  // oversized body is clamped to Discord's 4096 limit
  const c = buildCardComponents({ title: "T", body: "x".repeat(5000), buttons: [] })
  expect(c.embed.data.description!.length).toBe(4096)
})

test("parseNotifyCustomId recognises ns:action:arg ids and ignores perm:", () => {
  expect(parseNotifyCustomId("action:retry:B-1")).toEqual({ ns: "action", action: "retry", arg: "B-1" })
  expect(parseNotifyCustomId("deploy:go:J1")).toEqual({ ns: "deploy", action: "go", arg: "J1" })
  expect(parseNotifyCustomId("perm:allow:abc")).toBeNull()
})

test("gateway deploy gate: isDeployAuthorized unit check", () => {
  // Direct unit test of the isDeployAuthorized function; verifies the
  // authorisation contract consulted by the interactionCreate handler.
  // Note: enforcement that a non-approver deploy:* click does NOT invoke
  // notifyButtonCb is covered by manual integration testing, not this test.
  const approver = "APPROVER_ID"
  const nonApprover = "SOMEONE_ELSE"
  // deploy:go blocked for non-approver
  expect(isDeployAuthorized("deploy:go:J1", nonApprover, approver)).toBe(false)
  // deploy:go passes for approver
  expect(isDeployAuthorized("deploy:go:J1", approver, approver)).toBe(true)
  // non-deploy buttons always pass (not governed by deploy gate)
  expect(isDeployAuthorized("action:resolve:T1", nonApprover, approver)).toBe(true)
  // empty approver = deny all deploy
  expect(isDeployAuthorized("deploy:go:J1", approver, "")).toBe(false)
})

import { test as gt, expect as ge } from "bun:test"
import { buildModal as bm } from "./modal"

gt("buildModal integrates for a feedback button (smoke)", () => {
  const m = bm("fix:feedback:T1", { title: "Feedback", inputs: [{ id: "feedback", label: "Note", style: "paragraph" }] })
  ge(m.data.custom_id).toBe("fix:feedback:T1")
})

import { buildWorkingRow } from "./gateway"

test("buildWorkingRow is a single disabled Working button", () => {
  const row = buildWorkingRow()
  expect(row.components.length).toBe(1)
  const b = row.components[0].data as any
  expect(b.label).toBe("Working")
  expect(b.disabled).toBe(true)
  expect(b.custom_id).toBe("working:noop")
})

import { buildAttachmentFiles } from "./gateway"
import { AttachmentBuilder } from "discord.js"

test("buildAttachmentFiles wraps buffers in named AttachmentBuilders and clamps to 10", () => {
  const one = buildAttachmentFiles([{ data: Buffer.from("hi"), name: "report.pdf" }])
  expect(one.length).toBe(1)
  expect(one[0]).toBeInstanceOf(AttachmentBuilder)
  expect(one[0].name).toBe("report.pdf")
  const many = buildAttachmentFiles(Array.from({ length: 15 }, (_, i) => ({ data: Buffer.from(String(i)), name: `${i}.txt` })))
  expect(many.length).toBe(10)
})

import { buildInboundFromMessage } from "./gateway"
import { InboundMultiplexer } from "./gateway"

test("InboundMultiplexer notifies legacy and canonical listeners in registration order", () => {
  const calls: string[] = []
  const mux = new InboundMultiplexer<any>()
  mux.add(() => calls.push("legacy"))
  mux.add(() => calls.push("canonical"))
  mux.emit({})
  expect(calls).toEqual(["legacy", "canonical"])
})

test("buildInboundFromMessage sets threadParentId for a thread message", () => {
  const msg = {
    channelId: "thread123", id: "m1",
    author: { id: "u1", username: "alice", bot: false },
    content: "hi", createdAt: new Date("2026-07-02T00:00:00Z"),
    channel: { type: ChannelType.PublicThread, isThread: () => true, parentId: "chan456" },
    attachments: new Map(), reference: null,
  } as any
  const inbound = buildInboundFromMessage(msg, [])
  expect(inbound.chatId).toBe("thread123")
  expect(inbound.threadParentId).toBe("chan456")
})

test("buildInboundFromMessage omits threadParentId for a non-thread message", () => {
  const msg = {
    channelId: "chan456", id: "m2",
    author: { id: "u1", username: "alice", bot: false },
    content: "hi", createdAt: new Date("2026-07-02T00:00:00Z"),
    channel: { type: ChannelType.GuildText, isThread: () => false },
    attachments: new Map(), reference: null,
  } as any
  const inbound = buildInboundFromMessage(msg, [])
  expect(inbound.threadParentId).toBeUndefined()
})

test("Gateway exposes lifecycle and adapter send methods", () => {
  expect(typeof Gateway.prototype.stop).toBe("function")
  expect(typeof Gateway.prototype.sendText).toBe("function")
})

test("Gateway sendText chunks text and returns the first Discord message id", async () => {
  const gateway = Object.create(Gateway.prototype) as Gateway
  const payloads: any[] = []
  ;(gateway as any).client = { channels: { fetch: async () => ({ send: async (payload: any) => { payloads.push(payload); return { id: `posted-${payloads.length}` } } }) } }
  expect(await gateway.sendText("channel", "x".repeat(2500), "parent", "delivery-1")).toBe("posted-1")
  expect(payloads.map(payload => payload.content.length)).toEqual([2000, 500])
  expect(payloads[0].reply.messageReference).toBe("parent")
  expect(payloads[1].reply).toBeUndefined()
  expect(payloads.every(payload => payload.enforceNonce === true)).toBe(true)
  expect(payloads.every(payload => JSON.stringify(payload.allowedMentions) === JSON.stringify({ parse: [] }))).toBe(true)
  expect(payloads.every(payload => payload.nonce.length <= 25)).toBe(true)
  expect(payloads[0].nonce).not.toBe(payloads[1].nonce)
})

test("Gateway sendText compensates a partial multi-chunk failure and permits retry", async () => {
  const gateway = Object.create(Gateway.prototype) as Gateway
  const posted = new Map<string, { id: string }>()
  let failSecond = true
  const deleted: string[] = []
  ;(gateway as any).client = { channels: { fetch: async () => ({ messages: { delete: async (id: string) => { deleted.push(id); for (const [nonce, message] of posted) if (message.id === id) posted.delete(nonce) } }, send: async (payload: any) => {
    if (payload.content.length === 500 && failSecond) { failSecond = false; throw new Error("second chunk failed") }
    const prior = posted.get(payload.nonce)
    if (prior) return prior
    const message = { id: `posted-${posted.size + 1}` }
    posted.set(payload.nonce, message)
    return message
  } }) } }
  await expect(gateway.sendText("channel", "x".repeat(2500), undefined, "delivery-1")).rejects.toThrow("second chunk failed")
  expect(deleted).toEqual(["posted-1"])
  expect(await gateway.sendText("channel", "x".repeat(2500), undefined, "delivery-1")).toBe("posted-1")
  expect(posted.size).toBe(2)
})

test("Gateway sendText marks a partial failure non-retryable when compensation fails", async () => {
  const gateway = Object.create(Gateway.prototype) as Gateway
  let sends = 0
  ;(gateway as any).client = { channels: { fetch: async () => ({
    messages: { delete: async () => { throw new Error("delete denied") } },
    send: async () => { sends++; if (sends === 2) throw new Error("second chunk failed"); return { id: "posted-1" } },
  }) } }
  try { await gateway.sendText("channel", "x".repeat(2500), undefined, "delivery-1"); throw new Error("expected failure") }
  catch (error) { expect((error as any).retryable).toBe(false) }
})

test("buildInboundFromMessage excludes forwards from reply normalization", () => {
  const msg = {
    channelId: "chan", id: "forward", author: { id: "u", username: "alice" }, content: "",
    createdAt: new Date(0), channel: { type: ChannelType.GuildText, isThread: () => false }, attachments: new Map(),
    reference: { messageId: "source", type: MessageReferenceType.Forward },
  } as any
  expect(buildInboundFromMessage(msg, []).replyToMessageId).toBeUndefined()
})
