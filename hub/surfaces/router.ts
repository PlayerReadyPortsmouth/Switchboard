import type { Message, TransportLink } from "../conversations/types"
import type { SurfaceAdapter } from "./adapter"
import type { NormalizedSurfaceEvent, SurfaceDeliveryKind, SurfaceDeliveryResult } from "./types"

export class SurfaceRouter {
  private readonly adapters = new Map<string, SurfaceAdapter>()

  constructor(adapters: SurfaceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.name)) throw new Error(`Duplicate surface adapter: ${adapter.name}`)
      this.adapters.set(adapter.name, adapter)
    }
  }

  async startAll(onEvent: (event: NormalizedSurfaceEvent) => Promise<void>): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.start(onEvent)))
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.stop()))
  }

  async deliver(message: Message, links: TransportLink[], kind: SurfaceDeliveryKind = "transcript", replyToExternalIds?: ReadonlyMap<string, string>): Promise<SurfaceDeliveryResult[]> {
    const eligible = links.filter((link) =>
      link.enabled &&
      link.syncMode !== "inbound_only" &&
      (link.syncMode !== "notifications_only" || kind === "notification"),
    )

    return Promise.all(eligible.map(async (link): Promise<SurfaceDeliveryResult> => {
      const deliveryId = `${message.id}:${link.id}`
      const adapter = this.adapters.get(link.adapter)
      if (!adapter) return { deliveryId, adapter: link.adapter, ok: false, error: `Unknown surface adapter: ${link.adapter}`, retryable: false }

      try {
        return await adapter.send({ deliveryId, conversationId: message.conversationId, link, message, replyToExternalId: replyToExternalIds?.get(link.id) })
      } catch {
        return { deliveryId, adapter: link.adapter, ok: false, error: "Surface adapter delivery failed" }
      }
    }))
  }
}
