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

class SyntheticDiscordClient {
  private readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>()

  on(event: string, handler: (...args: any[]) => unknown): this {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  async login(_token: string): Promise<string> { return "logged-in" }
  destroy(): void {}

  async dispatch(event: string, ...args: any[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(...args)
  }
}

function gatewayHarness() {
  const gateway = Object.create(Gateway.prototype) as Gateway
  const client = new SyntheticDiscordClient()
  Object.assign(gateway as any, {
    client,
    onMessages: new InboundMultiplexer(),
    permButtonCb: () => {},
    notifyButtonCb: () => {},
    approvalButtonCb: null,
    isAuthorized: () => false,
    modalByCustomId: new Map(),
    notifyGate: () => true,
    modalSubmitCb: () => {},
    reactionCb: () => {},
    threadArchivedCb: () => {},
    connectionStateCb: () => {},
    lastConnectionState: undefined,
  })
  return { gateway, client, start: () => gateway.start("token") }
}

function syntheticButton(customId: string, options: { id?: string; userId?: string } = {}) {
  const replies: any[] = []
  const updates: any[] = []
  let deferred = 0
  const interaction = {
    id: options.id ?? "interaction-1",
    customId,
    user: { id: options.userId ?? "user-1" },
    message: { content: "original card" },
    isModalSubmit: () => false,
    isButton: () => true,
    reply: async (payload: any) => { replies.push(payload) },
    update: async (payload: any) => { updates.push(payload) },
    deferUpdate: async () => { deferred++ },
  }
  return { interaction, replies, updates, deferred: () => deferred }
}

test("registered approval-service buttons bypass generic gates, preserve the card, and are awaited", async () => {
  const h = gatewayHarness()
  let notifyCalls = 0
  h.gateway.setPermissionAuthorizer(() => false)
  h.gateway.setNotifyButtonGate(() => false)
  h.gateway.onNotifyButton(() => { notifyCalls++ })

  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const calls: string[][] = []
  h.gateway.onApprovalButton(async (customId, userId, interactionId) => {
    calls.push([customId, userId, interactionId])
    await wait
  })
  await h.start()

  const button = syntheticButton("approval:grant:12:approval-7", { id: "interaction-9" })
  let settled = false
  const dispatch = h.client.dispatch("interactionCreate", button.interaction).finally(() => { settled = true })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(calls).toEqual([["approval:grant:12:approval-7", "user-1", "interaction-9"]])
  expect(button.deferred()).toBe(1)
  expect(button.updates).toEqual([])
  expect(button.replies).toEqual([])
  expect(notifyCalls).toBe(0)

  release()
  await dispatch
  expect(settled).toBe(true)
})

test("a canonical approval ID without service opt-in never reaches the legacy resolver", async () => {
  const h = gatewayHarness()
  h.gateway.setPermissionAuthorizer(() => true)
  h.gateway.setNotifyButtonGate(() => true)
  const calls: string[][] = []
  h.gateway.onNotifyButton((...args) => { calls.push(args) })
  await h.start()

  const button = syntheticButton("approval:deny:3:approval-1")
  await h.client.dispatch("interactionCreate", button.interaction)
  expect(calls).toEqual([])
  expect(button.deferred()).toBe(0)
  expect(button.updates).toEqual([])
  expect(button.replies).toEqual([expect.objectContaining({ ephemeral: true })])
})

test("reserved legacy approval IDs preserve base gate, notify gate, Working row, and interaction ID", async () => {
  const h = gatewayHarness()
  let baseAllowed = false
  let notifyAllowed = false
  h.gateway.setPermissionAuthorizer(() => baseAllowed)
  h.gateway.setNotifyButtonGate(() => notifyAllowed)
  const calls: string[][] = []
  h.gateway.onNotifyButton((...args) => { calls.push(args) })
  await h.start()

  const deniedByBase = syntheticButton("approval:grant:legacy:appr-1", { id: "legacy-1" })
  await h.client.dispatch("interactionCreate", deniedByBase.interaction)
  expect(deniedByBase.replies[0]?.content).toBe("Not authorized.")

  baseAllowed = true
  const deniedByNotify = syntheticButton("approval:grant:legacy:appr-1", { id: "legacy-2" })
  await h.client.dispatch("interactionCreate", deniedByNotify.interaction)
  expect(deniedByNotify.replies[0]?.content).toContain("Not authorized for this action")

  notifyAllowed = true
  const allowed = syntheticButton("approval:grant:legacy:appr-1", { id: "legacy-3" })
  await h.client.dispatch("interactionCreate", allowed.interaction)
  expect(calls).toEqual([["approval:grant:legacy:appr-1", "user-1", "legacy-3"]])
  expect(allowed.updates).toHaveLength(1)
  const row = allowed.updates[0]!.components[0]
  expect((row.components[0].data as any).custom_id).toBe("working:noop")
  expect((row.components[0].data as any).disabled).toBe(true)
})

test("non-approval controls preserve existing gates and await the three-argument callback", async () => {
  const h = gatewayHarness()
  let baseAllowed = false
  let notifyAllowed = false
  h.gateway.setPermissionAuthorizer(() => baseAllowed)
  h.gateway.setNotifyButtonGate(() => notifyAllowed)
  const calls: string[][] = []
  h.gateway.onNotifyButton(async (...args) => { calls.push(args) })
  await h.start()

  const deniedByBase = syntheticButton("action:run:job-1")
  await h.client.dispatch("interactionCreate", deniedByBase.interaction)
  expect(deniedByBase.replies[0]?.content).toBe("Not authorized.")

  baseAllowed = true
  const deniedByNotify = syntheticButton("action:run:job-1")
  await h.client.dispatch("interactionCreate", deniedByNotify.interaction)
  expect(deniedByNotify.replies[0]?.content).toContain("Not authorized for this action")

  notifyAllowed = true
  const allowed = syntheticButton("action:run:job-1", { id: "generic-3" })
  await h.client.dispatch("interactionCreate", allowed.interaction)
  expect(calls).toEqual([["action:run:job-1", "user-1", "generic-3"]])
  const row = allowed.updates[0]!.components[0]
  expect((row.components[0].data as any).label).toBe("Working")
  expect((row.components[0].data as any).disabled).toBe(true)
})

test("rejected async approval callbacks are caught at the gateway boundary", async () => {
  const h = gatewayHarness()
  h.gateway.onApprovalButton(async () => { throw new Error("callback rejected") })
  await h.start()
  const button = syntheticButton("approval:grant:2:approval-1")
  const originalWrite = process.stderr.write
  let logged = ""
  process.stderr.write = ((chunk: any) => { logged += String(chunk); return true }) as typeof process.stderr.write
  try {
    await expect(h.client.dispatch("interactionCreate", button.interaction)).resolves.toBeUndefined()
  } finally {
    process.stderr.write = originalWrite
  }
  expect(logged).toContain("approval button callback failed")
})

test("connection state deduplicates ready and disconnect events without changing inbound or button behavior", async () => {
  const h = gatewayHarness()
  const states: string[] = []
  const inbound: string[] = []
  const buttons: string[][] = []
  h.gateway.onConnectionState(state => { states.push(state) })
  h.gateway.handleInbound(message => { inbound.push(message.messageId) })
  h.gateway.setPermissionAuthorizer(() => true)
  h.gateway.setNotifyButtonGate(() => true)
  h.gateway.onNotifyButton((...args) => { buttons.push(args) })
  await h.start()

  await h.client.dispatch("clientReady")
  await h.client.dispatch("shardReady", 0)
  await h.client.dispatch("shardResume", 0, 1)
  await h.client.dispatch("shardDisconnect", {}, 0)
  await h.client.dispatch("shardDisconnect", {}, 0)
  await h.client.dispatch("shardResume", 0, 2)
  await h.client.dispatch("clientReady")

  await h.client.dispatch("messageCreate", {
    id: "message-1",
    channelId: "channel-1",
    author: { id: "user-1", username: "Alice", bot: false },
    content: "hello",
    createdAt: new Date(0),
    channel: { type: ChannelType.GuildText, isThread: () => false },
    attachments: new Map(),
    messageSnapshots: new Map(),
    reference: null,
  })
  const button = syntheticButton("action:run:job-1", { id: "interaction-after-resume" })
  await h.client.dispatch("interactionCreate", button.interaction)

  expect(states).toEqual(["ready", "disconnected", "ready"])
  expect(inbound).toEqual(["message-1"])
  expect(buttons).toEqual([["action:run:job-1", "user-1", "interaction-after-resume"]])
})

test("connection state callbacks are synchronous, deduplicated, and exception-isolated", async () => {
  const h = gatewayHarness()
  const states: string[] = []
  h.gateway.onConnectionState(state => { states.push(state); throw new Error("observer failed") })
  await h.start()
  const originalWrite = process.stderr.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    await expect(h.client.dispatch("clientReady")).resolves.toBeUndefined()
    await expect(h.client.dispatch("shardReady", 0)).resolves.toBeUndefined()
    await expect(h.client.dispatch("shardDisconnect", {}, 0)).resolves.toBeUndefined()
  } finally {
    process.stderr.write = originalWrite
  }
  expect(states).toEqual(["ready", "disconnected"])
})

test("editCardOrThrow propagates Discord failures while editCard remains compatible", async () => {
  const gateway = Object.create(Gateway.prototype) as Gateway
  ;(gateway as any).client = {
    channels: {
      fetch: async () => ({ messages: { edit: async () => { throw new Error("edit rejected") } } }),
    },
  }
  const card = { title: "T", body: "B", buttons: [] }
  await expect(gateway.editCardOrThrow("channel", "message", card)).rejects.toThrow("edit rejected")

  const originalWrite = process.stderr.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    await expect(gateway.editCard("channel", "message", card)).resolves.toBeUndefined()
  } finally {
    process.stderr.write = originalWrite
  }

  ;(gateway as any).client = { channels: { fetch: async () => ({ send: async () => {} }) } }
  await expect(gateway.editCardOrThrow("channel", "message", card)).rejects.toThrow("discord_channel_not_editable")
})
