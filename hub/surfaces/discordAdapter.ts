import type { InboundMessage } from "../types"
import type { SurfaceAdapter } from "./adapter"
import type { NormalizedSurfaceEvent, SurfaceDelivery, SurfaceDeliveryResult } from "./types"

export interface DiscordGatewayPort {
  handleInbound(cb: (message: InboundMessage) => void): void
  start(token: string): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string, replyTo?: string): Promise<string | undefined>
}

export class DiscordAdapter implements SurfaceAdapter {
  readonly name = "discord"
  readonly capabilities = { text: true, replies: true, cards: true, attachments: true, edits: true, deletes: false }

  constructor(private readonly gateway: DiscordGatewayPort, private readonly token: string) {}

  async start(onEvent: (event: NormalizedSurfaceEvent) => Promise<void>): Promise<void> {
    this.gateway.handleInbound(message => {
      void onEvent({
        adapter: this.name,
        eventId: message.messageId,
        externalLocationId: message.chatId,
        externalMessageId: message.messageId,
        authorId: message.userId,
        authorName: message.user,
        content: message.content,
        createdAt: Date.parse(message.ts),
        replyToExternalId: message.replyToMessageId,
      })
    })
    await this.gateway.start(this.token)
  }

  stop(): Promise<void> { return this.gateway.stop() }

  async send(delivery: SurfaceDelivery): Promise<SurfaceDeliveryResult> {
    try {
      const externalMessageId = await this.gateway.sendText(
        delivery.link.externalLocationId,
        `**${delivery.message.author}** · ${delivery.message.content}`,
        delivery.message.replyTo ?? undefined,
      )
      if (!externalMessageId) return { deliveryId: delivery.deliveryId, adapter: this.name, ok: false, error: "Discord channel unavailable" }
      return { deliveryId: delivery.deliveryId, adapter: this.name, ok: true, externalMessageId }
    } catch (error) {
      return { deliveryId: delivery.deliveryId, adapter: this.name, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
