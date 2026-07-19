import { formatWebMirrorLine } from "../displayName"
import type { InboundMessage } from "../types"
import type { SurfaceAdapter } from "./adapter"
import type { NormalizedSurfaceEvent, SurfaceDelivery, SurfaceDeliveryResult } from "./types"

export interface DiscordGatewayPort {
  handleInbound(cb: (message: InboundMessage) => void): void
  start(token: string): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string, replyTo: string | undefined, deliveryId: string): Promise<string | undefined>
}

export class DiscordAdapter implements SurfaceAdapter {
  readonly name = "discord"
  readonly capabilities = { text: true, replies: true, cards: false, attachments: false, edits: false, deletes: false }

  constructor(
    private readonly gateway: DiscordGatewayPort,
    private readonly token: string,
    private readonly reportError: (error: unknown) => void = error => process.stderr.write(`discord adapter inbound handler failed: ${error}\n`),
  ) {}

  async start(onEvent: (event: NormalizedSurfaceEvent) => Promise<void>): Promise<void> {
    this.gateway.handleInbound(message => {
      const event = {
        adapter: this.name,
        eventId: message.messageId,
        externalLocationId: message.chatId,
        externalMessageId: message.messageId,
        authorId: message.userId,
        authorName: message.user,
        content: message.content,
        createdAt: Date.parse(message.ts),
        replyToExternalId: message.replyToMessageId,
      }
      void Promise.resolve().then(() => onEvent(event)).catch(this.reportError)
    })
    await this.gateway.start(this.token)
  }

  stop(): Promise<void> { return this.gateway.stop() }

  /** Web messages get a humanized author plus an origin marker so Discord-side
   *  participants can tell them from an ordinary message; every other origin
   *  (notably `agent`) keeps the plain `**author** · content` form. Formatting
   *  is chosen from the canonical `origin`, never by sniffing the author. */
  private line(message: SurfaceDelivery["message"]): string {
    if (message.origin === "web") return formatWebMirrorLine(message.author, message.content)
    return `**${message.author}** · ${message.content}`
  }

  async send(delivery: SurfaceDelivery): Promise<SurfaceDeliveryResult> {
    try {
      const externalMessageId = await this.gateway.sendText(
        delivery.link.externalLocationId,
        this.line(delivery.message),
        delivery.replyToExternalId,
        delivery.deliveryId,
      )
      if (!externalMessageId) return { deliveryId: delivery.deliveryId, adapter: this.name, ok: false, error: "Discord channel unavailable" }
      return { deliveryId: delivery.deliveryId, adapter: this.name, ok: true, externalMessageId }
    } catch (error) {
      return {
        deliveryId: delivery.deliveryId, adapter: this.name, ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...((error as { retryable?: boolean })?.retryable === false ? { retryable: false } : {}),
      }
    }
  }
}
