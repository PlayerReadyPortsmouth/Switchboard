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

export function acceptsInboundLink(link: TransportLink | null | undefined): link is TransportLink {
  return inboundLinkRoute(link) === "canonical"
}

export function inboundLinkRoute(link: TransportLink | null | undefined): "canonical" | "legacy" {
  return !!link?.enabled && (link.syncMode === "two_way" || link.syncMode === "inbound_only") ? "canonical" : "legacy"
}

export class TurnCoordinator {
  private readonly backgroundDeliveries = new Set<Promise<void>>()
  constructor(
    private readonly service: Pick<ConversationService, "appendUserMessage" | "appendExternalMessage" | "appendAgentMessage">,
    private readonly repo: Pick<ConversationRepository, "getConversation" | "resolveTransportLink" | "listTransportLinks" | "resolveDeliveredExternalMessageId" | "createDeliveries" | "claimDeliveries" | "markDeliveryDelivered" | "markDeliveryRetry">,
    private readonly dispatcher: TurnDispatcher,
    private readonly events: TurnEventPublisher,
    private readonly router: TurnSurfaceRouter,
    private readonly now: () => number,
    private readonly id: () => string,
    private readonly reportError: (error: unknown) => void = error => process.stderr.write(`turn coordinator delivery failed: ${error}\n`),
  ) {}

  async submitWebTurn(identity: string, conversationId: string, input: WebTurnInput): Promise<AppendMessageResult> {
    const result = this.service.appendUserMessage(identity, conversationId, input)
    if (result.inserted) {
      const links = this.repo.listTransportLinks(conversationId).filter(link => link.enabled && link.syncMode !== "inbound_only" && link.syncMode !== "notifications_only")
      let deliveries: Delivery[] = []
      if (links.length) {
        deliveries = this.repo.createDeliveries(result.message.id, links, "message", this.now())
      }
      this.dispatch(conversationId, result.message, `web:${identity}`, identity)
      if (deliveries.length) this.deliverInBackground(result.message, deliveries, links)
    }
    return result
  }

  async acceptSurfaceEvent(event: NormalizedSurfaceEvent): Promise<AppendMessageResult | null> {
    if (![event.adapter,event.eventId,event.externalLocationId,event.externalMessageId,event.authorId,event.authorName,event.content].every(value => typeof value === "string" && value.trim()) || !Number.isFinite(event.createdAt)) {
      const error = new Error("Malformed normalized surface event")
      this.reportError(error)
      throw error
    }
    const link = this.repo.resolveTransportLink(event.adapter, event.externalLocationId)
    if (!acceptsInboundLink(link)) return null
    const input: AppendMessageInput = {
      id: this.id(), conversationId: link.conversationId,
      author: `${event.adapter}:${event.authorId}`, origin: "transport", content: event.content,
      state: "committed", clientKey: `${event.adapter}:${event.eventId}`, createdAt: event.createdAt,
    }
    const result = this.service.appendExternalMessage(event.adapter, event.eventId, input, { linkId: link.id, externalMessageId: event.externalMessageId })
    if (result.inserted) {
      const links = this.repo.listTransportLinks(link.conversationId).filter(item => item.id !== link.id && item.enabled && item.syncMode !== "inbound_only" && item.syncMode !== "notifications_only")
      const deliveries = links.length ? this.repo.createDeliveries(result.message.id, links, "message", this.now()) : []
      this.dispatch(link.conversationId, result.message, `${event.adapter}:${event.authorId}`, `${event.adapter}:${event.authorName}`)
      if (deliveries.length) this.deliverInBackground(result.message, deliveries, links)
    }
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
      this.deliverInBackground(result.message, result.deliveries, links, replyIds)
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

  private persistDeliveryResults(deliveries: Delivery[], results: SurfaceDeliveryResult[]): void {
    for (const [index, result] of results.entries()) {
      const delivery = deliveries[index]
      if (!delivery) continue
      const now = this.now()
      if (result.ok) this.repo.markDeliveryDelivered(delivery.id, result.externalMessageId ?? null, now, "coordinator")
      else this.repo.markDeliveryRetry(delivery.id, result.error ?? "Surface adapter returned no delivery result", result.retryable === false ? null : now + 1_000, result.retryable === false, now, "coordinator")
    }
  }

  private async deliverClaimed(message: Message, deliveries: Delivery[], links: TransportLink[], replyIds?: ReadonlyMap<string,string>): Promise<void> {
    const claimed = this.repo.claimDeliveries(deliveries.map(item => item.id), "coordinator", this.now(), this.now() + 30_000)
    if (!claimed.length) return
    const claimedIds = new Set(claimed.map(item => item.id))
    const claimedLinks = links.filter((_, index) => claimedIds.has(deliveries[index]!.id))
    this.persistDeliveryResults(claimed, await this.router.deliver(message, claimedLinks, "transcript", replyIds))
  }

  private deliverInBackground(message: Message, deliveries: Delivery[], links: TransportLink[], replyIds?: ReadonlyMap<string,string>): void {
    const task = Promise.resolve().then(() => this.deliverClaimed(message, deliveries, links, replyIds)).catch(this.reportError)
    this.backgroundDeliveries.add(task)
    void task.finally(() => this.backgroundDeliveries.delete(task))
  }

  async drainDeliveries(): Promise<void> {
    while (this.backgroundDeliveries.size) await Promise.all([...this.backgroundDeliveries])
  }

  private turnState(message: Message, state: "queued" | "working" | "failed"): void {
    this.events.publish({ kind: "turn_state", conversationId: message.conversationId, sequence: message.sequence, ts: this.now(), state, detail: { messageId: message.id } })
  }
}
