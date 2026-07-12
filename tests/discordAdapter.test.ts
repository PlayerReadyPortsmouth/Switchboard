import { describe, expect, test } from "bun:test"
import { DiscordAdapter, type DiscordGatewayPort } from "../hub/surfaces/discordAdapter"
import type { InboundMessage } from "../hub/types"
import type { SurfaceDelivery } from "../hub/surfaces"

function delivery(content = "hello", replyTo: string | null = null): SurfaceDelivery {
  return {
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    link: { id: "link-1", conversationId: "conversation-1", adapter: "discord", externalLocationId: "channel-1", label: null, syncMode: "two_way", enabled: true, createdAt: 1, updatedAt: 1 },
    message: { id: "message-1", conversationId: "conversation-1", sequence: 1, author: "alice", origin: "web", content, replyTo, state: "committed", clientKey: null, createdAt: 1 },
  }
}

function port(overrides: Partial<DiscordGatewayPort> = {}): DiscordGatewayPort {
  return { handleInbound() {}, async start() {}, async stop() {}, async sendText() { return "discord-1" }, ...overrides }
}

describe("DiscordAdapter", () => {
  test("normalizes gateway messages into surface events", async () => {
    let inbound!: (message: InboundMessage) => void
    let event: any
    const adapter = new DiscordAdapter(port({ handleInbound(cb) { inbound = cb } }), "token")
    await adapter.start(async value => { event = value })
    inbound({ chatId: "channel-1", messageId: "discord-1", userId: "user-1", user: "Alice", content: "hello", ts: "2026-07-12T12:00:00.000Z", isDM: false, quote: { user: "Bob", content: "earlier" }, replyToMessageId: "discord-parent" })
    await Promise.resolve()
    expect(event).toEqual({ adapter: "discord", eventId: "discord-1", externalLocationId: "channel-1", externalMessageId: "discord-1", authorId: "user-1", authorName: "Alice", content: "hello", createdAt: Date.parse("2026-07-12T12:00:00.000Z"), replyToExternalId: "discord-parent" })
  })

  test("declares Discord capabilities and delegates lifecycle", async () => {
    const calls: string[] = []
    const adapter = new DiscordAdapter(port({ async start(token) { calls.push(`start:${token}`) }, async stop() { calls.push("stop") } }), "secret")
    expect(adapter.name).toBe("discord")
    expect(adapter.capabilities).toEqual({ text: true, replies: true, cards: true, attachments: true, edits: true, deletes: false })
    await adapter.start(async () => {})
    await adapter.stop()
    expect(calls).toEqual(["start:secret", "stop"])
  })

  test("sends canonical author/content/reply metadata and returns Discord id", async () => {
    let args: unknown[] = []
    const adapter = new DiscordAdapter(port({ async sendText(...values) { args = values; return "discord-9" } }), "token")
    const result = await adapter.send(delivery("hello", "discord-parent"))
    expect(args).toEqual(["channel-1", "**alice** · hello", "discord-parent"])
    expect(result).toEqual({ deliveryId: "delivery-1", adapter: "discord", ok: true, externalMessageId: "discord-9" })
  })

  test("converts gateway send failures into delivery failures", async () => {
    const adapter = new DiscordAdapter(port({ async sendText() { throw new Error("Discord unavailable") } }), "token")
    expect(await adapter.send(delivery())).toEqual({ deliveryId: "delivery-1", adapter: "discord", ok: false, error: "Discord unavailable" })
  })
})
