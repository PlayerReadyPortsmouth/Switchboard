import { describe, expect, test } from "bun:test"
import type { Message, SyncMode, TransportLink } from "../hub/conversations/types"
import { SurfaceRouter, type NormalizedSurfaceEvent, type SurfaceAdapter, type SurfaceDelivery } from "../hub/surfaces"

const capabilities = { text: true, replies: true, cards: false, attachments: false, edits: false, deletes: false }

function message(): Message {
  return { id: "m1", conversationId: "c1", sequence: 1, author: "user", origin: "web", content: "hello", replyTo: null, state: "committed", clientKey: null, createdAt: 1 }
}

function link(adapter: string, syncMode: SyncMode, enabled = true): TransportLink {
  return { id: `link-${adapter}`, conversationId: "c1", adapter, externalLocationId: `channel-${adapter}`, label: null, syncMode, enabled, createdAt: 1, updatedAt: 1 }
}

function recordingAdapter(name: string, deliveries: SurfaceDelivery[] = []): SurfaceAdapter {
  return {
    name,
    capabilities,
    async start() {},
    async stop() {},
    async send(delivery) {
      deliveries.push(delivery)
      return { deliveryId: delivery.deliveryId, adapter: name, ok: true, externalMessageId: `${name}-message` }
    },
  }
}

function throwingAdapter(name: string): SurfaceAdapter {
  return { ...recordingAdapter(name), async send() { throw new Error("secret adapter details") } }
}

describe("SurfaceRouter", () => {
  test("delivers transcript messages only to enabled outbound-capable links", async () => {
    const deliveries: SurfaceDelivery[] = []
    const router = new SurfaceRouter([recordingAdapter("discord", deliveries)])

    const results = await router.deliver(message(), [
      link("discord", "two_way"),
      { ...link("discord", "outbound_only"), id: "disabled", enabled: false },
      { ...link("discord", "inbound_only"), id: "inbound" },
    ])

    expect(results).toHaveLength(1)
    expect(deliveries.map((delivery) => delivery.link.id)).toEqual(["link-discord"])
  })

  test("allows notification-only links only for notification deliveries", async () => {
    const deliveries: SurfaceDelivery[] = []
    const router = new SurfaceRouter([recordingAdapter("discord", deliveries)])
    const notificationLink = link("discord", "notifications_only")

    expect(await router.deliver(message(), [notificationLink])).toEqual([])
    expect(await router.deliver(message(), [notificationLink], "notification")).toHaveLength(1)
  })

  test("isolates adapter failures while delivering to other eligible links", async () => {
    const router = new SurfaceRouter([throwingAdapter("discord"), recordingAdapter("slack")])
    const results = await router.deliver(message(), [link("discord", "two_way"), link("slack", "outbound_only")])
    expect(results.map((result) => [result.adapter, result.ok])).toEqual([["discord", false], ["slack", true]])
    expect(results[0]?.error).toBe("Surface adapter delivery failed")
  })

  test("returns a typed failure for an unknown adapter", async () => {
    const [result] = await new SurfaceRouter([]).deliver(message(), [link("unknown", "two_way")])
    expect(result).toEqual({ deliveryId: "m1:link-unknown", adapter: "unknown", ok: false, error: "Unknown surface adapter: unknown" })
  })

  test("rejects duplicate adapter names", () => {
    expect(() => new SurfaceRouter([recordingAdapter("discord"), recordingAdapter("discord")])).toThrow("Duplicate surface adapter: discord")
  })

  test("starts and stops every adapter", async () => {
    const lifecycle: string[] = []
    const adapter = (name: string): SurfaceAdapter => ({
      ...recordingAdapter(name),
      async start(onEvent: (event: NormalizedSurfaceEvent) => Promise<void>) { lifecycle.push(`start:${name}`); void onEvent },
      async stop() { lifecycle.push(`stop:${name}`) },
    })
    const router = new SurfaceRouter([adapter("discord"), adapter("slack")])
    await router.startAll(async () => {})
    await router.stopAll()
    expect(lifecycle).toEqual(["start:discord", "start:slack", "stop:discord", "stop:slack"])
  })
})
