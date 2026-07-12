import type { AgentReply, InboundMessage } from "../types"
import type { NormalizedSurfaceEvent, SurfaceDeliveryResult } from "../surfaces"
import type { ConversationEvent } from "./events"
import type { AppendMessageResult, ConversationRepository } from "./repository"
import type { ConversationService } from "./service"
import type { AppendMessageInput, Delivery, Message, TransportLink } from "./types"

export interface TurnDispatcher {
  dispatch(agent: string, conversationId: string, inbound: InboundMessage): boolean
}

export interface TurnEventPublisher { publish(event: ConversationEvent): void }
export interface TurnSurfaceRouter { deliver(message: Message, links: TransportLink[], kind?: "transcript" | "notification", replyToExternalIds?: ReadonlyMap<string, string>): Promise<SurfaceDeliveryResult[]> }
export type AgentTurnResult = { message: Message; deliveries: Delivery[]; inserted: boolean }

type WebTurnInput = { content: string; clientKey: string; replyTo?: string }

export class TurnCoordinator {
  constructor(
    private readonly service: Pick<ConversationService, "appendUserMessage" | "appendExternalMessage" | "appendAgentMessage">,
    private readonly repo: Pick<ConversationRepository, "getConversation" | "resolveTransportLink" | "listTransportLinks" | "resolveDeliveredExternalMessageId">,
    private readonly dispatcher: TurnDispatcher,
    private readonly events: TurnEventPublisher,
    private readonly router: TurnSurfaceRouter,
    private readonly now: () => number,
    private readonly id: () => string,
  ) {}

  async submitWebTurn(identity: string, conversationId: string, input: WebTurnInput): Promise<AppendMessageResult> {
    const result = this.service.appendUserMessage(identity, conversationId, input)
    if (result.inserted) this.dispatch(conversationId, result.message, `web:${identity}`, identity)
    return result
  }

  async acceptSurfaceEvent(event: NormalizedSurfaceEvent): Promise<AppendMessageResult | null> {
    const link = this.repo.resolveTransportLink(event.adapter, event.externalLocationId)
    if (!link?.enabled || link.syncMode === "outbound_only" || link.syncMode === "notifications_only") return null
    const input: AppendMessageInput = {
      id: this.id(), conversationId: link.conversationId,
      author: `${event.adapter}:${event.authorId}`, origin: "transport", content: event.content,
      state: "committed", clientKey: `${event.adapter}:${event.eventId}`, createdAt: event.createdAt,
    }
    const result = this.service.appendExternalMessage(event.adapter, event.eventId, input, { linkId: link.id, externalMessageId: event.externalMessageId })
    if (result.inserted) this.dispatch(link.conversationId, result.message, `${event.adapter}:${event.authorId}`, `${event.adapter}:${event.authorName}`)
    return result
  }

  async acceptAgentReply(reply: AgentReply): Promise<AgentTurnResult | null> {
    if (reply.kind !== "reply") return null
    const text = reply.text?.trim()
    if (!text) return null
    const callbackId = reply.correlationId ?? reply.messageId
    if (!callbackId) throw new Error("Agent text replies require a correlationId or messageId")
    const conversation = this.repo.getConversation(reply.chatId)
    if (!conversation) return null
    const links = this.repo.listTransportLinks(conversation.id).filter((link) => link.enabled && link.syncMode !== "inbound_only" && link.syncMode !== "notifications_only")
    const result = this.service.appendAgentMessage({
      id: this.id(), conversationId: conversation.id, author: reply.agent, origin: "agent", content: text,
      replyTo: reply.replyTo, state: "completed", clientKey: `agent:${reply.agent}:${callbackId}`, createdAt: this.now(),
    }, links)
    if (result.inserted) {
      const replyIds = new Map<string, string>()
      if (result.message.replyTo) for (const link of links) {
        const externalId = this.repo.resolveDeliveredExternalMessageId(result.message.replyTo, link.id)
        if (externalId) replyIds.set(link.id, externalId)
      }
      await this.router.deliver(result.message, links, "transcript", replyIds)
    }
    return result
  }

  private dispatch(conversationId: string, message: Message, userId: string, user: string): void {
    const conversation = this.repo.getConversation(conversationId)
    if (!conversation) return
    this.turnState(message, "queued")
    const inbound: InboundMessage = { chatId: conversationId, messageId: message.id, userId, user, content: message.content, ts: new Date(message.createdAt).toISOString(), isDM: false }
    try {
      if (this.dispatcher.dispatch(conversation.primaryAgent, conversationId, inbound)) this.turnState(message, "working")
      else this.turnState(message, "failed")
    } catch (error) {
      this.turnState(message, "failed")
      throw error
    }
  }

  private turnState(message: Message, state: "queued" | "working" | "failed"): void {
    this.events.publish({ kind: "turn_state", conversationId: message.conversationId, sequence: message.sequence, ts: this.now(), state, detail: { messageId: message.id } })
  }
}
