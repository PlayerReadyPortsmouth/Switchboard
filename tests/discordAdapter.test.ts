import { describe, expect, test } from "bun:test"
import { DiscordAdapter, type DiscordGatewayPort } from "../hub/surfaces/discordAdapter"
import type { InboundMessage } from "../hub/types"
import type { SurfaceDelivery } from "../hub/surfaces"

function delivery(content = "hello", replyToExternalId?: string, message: Partial<SurfaceDelivery["message"]> = {}): SurfaceDelivery {
  return {
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    link: { id: "link-1", conversationId: "conversation-1", adapter: "discord", externalLocationId: "channel-1", label: null, syncMode: "two_way", enabled: true, createdAt: 1, updatedAt: 1 },
    message: { id: "message-1", conversationId: "conversation-1", sequence: 1, author: "alice", origin: "web", content, replyTo: "canonical-parent", state: "committed", clientKey: null, createdAt: 1, ...message },
    replyToExternalId,
  }
}

/** Capture the text the adapter hands the gateway for one delivery. */
async function sentText(d: SurfaceDelivery): Promise<string> {
  let text = ""
  const adapter = new DiscordAdapter(port({ async sendText(_chat, value) { text = value; return "discord-9" } }), "token")
  await adapter.send(d)
  return text
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
    expect(adapter.capabilities).toEqual({ text: true, replies: true, cards: false, attachments: false, edits: false, deletes: false })
    await adapter.start(async () => {})
    await adapter.stop()
    expect(calls).toEqual(["start:secret", "stop"])
  })

  test("sends canonical author/content/reply metadata and returns Discord id", async () => {
    let args: unknown[] = []
    const adapter = new DiscordAdapter(port({ async sendText(...values) { args = values; return "discord-9" } }), "token")
    const result = await adapter.send(delivery("hello", "discord-parent"))
    expect(args).toEqual(["channel-1", "🌐 **alice** · hello", "discord-parent", "delivery-1"])
    expect(result).toEqual({ deliveryId: "delivery-1", adapter: "discord", ok: true, externalMessageId: "discord-9" })
  })

  test("marks web-origin messages and humanizes the email author", async () => {
    expect(await sentText(delivery("Hey, quickly testing something", undefined, {
      author: "Aurora.Nicholas@player-ready.co.uk", origin: "web",
    }))).toBe("🌐 **Aurora N.** · Hey, quickly testing something")
  })

  test("agent replies keep the plain form — never decorated, never reformatted", async () => {
    expect(await sentText(delivery("Sure — go ahead, I'm here.", undefined, {
      author: "dev-agent", origin: "agent",
    }))).toBe("**dev-agent** · Sure — go ahead, I'm here.")
  })

  test("transport and system origins keep the plain form too", async () => {
    expect(await sentText(delivery("x", undefined, { author: "discord:186188409499418628", origin: "transport" })))
      .toBe("**discord:186188409499418628** · x")
    expect(await sentText(delivery("x", undefined, { author: "hub", origin: "system" })))
      .toBe("**hub** · x")
  })

  test("web-message content is passed through verbatim", async () => {
    const content = "look at **this** and `that`"
    expect(await sentText(delivery(content, undefined, { author: "a.b@x.co", origin: "web" })))
      .toBe(`🌐 **A B.** · ${content}`)
  })

  test("does not leak canonical reply ids when no external reply id was resolved", async () => {
    let args: unknown[] = []
    const adapter = new DiscordAdapter(port({ async sendText(...values) { args = values; return "discord-9" } }), "token")
    await adapter.send(delivery())
    expect(args[2]).toBeUndefined()
  })

  test("reports rejected inbound handlers without an unhandled rejection", async () => {
    let inbound!: (message: InboundMessage) => void
    const errors: unknown[] = []
    const adapter = new DiscordAdapter(port({ handleInbound(cb) { inbound = cb } }), "token", error => errors.push(error))
    await adapter.start(async () => { throw new Error("coordinator failed") })
    inbound({ chatId: "c", messageId: "m", userId: "u", user: "U", content: "x", ts: new Date(0).toISOString(), isDM: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((errors[0] as Error).message).toBe("coordinator failed")
  })

  test("converts gateway send failures into delivery failures", async () => {
    const adapter = new DiscordAdapter(port({ async sendText() { throw new Error("Discord unavailable") } }), "token")
    expect(await adapter.send(delivery())).toEqual({ deliveryId: "delivery-1", adapter: "discord", ok: false, error: "Discord unavailable" })
  })

  test("preserves an explicitly non-retryable compensated send failure", async () => {
    const failure = Object.assign(new Error("cleanup failed"), { retryable: false })
    const adapter = new DiscordAdapter(port({ async sendText() { throw failure } }), "token")
    expect(await adapter.send(delivery())).toEqual({ deliveryId: "delivery-1", adapter: "discord", ok: false, error: "cleanup failed", retryable: false })
  })
})
