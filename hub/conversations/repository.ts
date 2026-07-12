import type { AppendMessageInput, Conversation, Delivery, Message, NewConversation, Participant, TransportLink } from "./types"

export class RepositoryConflictError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryConflictError" }
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryNotFoundError" }
}

export interface AppendMessageResult { message: Message; inserted: boolean }
export interface ExternalMessageLink { linkId: string; externalMessageId: string }

export interface ConversationRepository {
  createConversation(input: NewConversation): Conversation
  createConversationWithOwner(input: NewConversation, owner: Participant): Conversation
  getConversation(id: string): Conversation | null
  listConversations(identity: string, includeArchived?: boolean): Conversation[]
  archiveConversation(id: string, archivedAt: number): Conversation
  addParticipant(input: Participant): Participant
  getParticipant(conversationId: string, identity: string): Participant | null
  appendMessage(input: AppendMessageInput): AppendMessageResult
  getMessage(id: string): Message | null
  listMessages(conversationId: string, afterSequence?: number, limit?: number): Message[]
  createTransportLink(input: Omit<TransportLink, "createdAt" | "updatedAt">, now: number): TransportLink
  listTransportLinks(conversationId: string): TransportLink[]
  resolveTransportLink(adapter: string, externalLocationId: string): TransportLink | null
  appendAgentMessage(input: AppendMessageInput, links: TransportLink[], now: number): { message: Message; deliveries: Delivery[]; inserted: boolean }
  createDeliveries(messageId: string, links: TransportLink[], eventKind: string, now: number): Delivery[]
  markDeliveryDelivered(id: string, externalMessageId: string | null, now: number): Delivery
  resolveDeliveredExternalMessageId(messageId: string, linkId: string): string | null
  markDeliveryRetry(id: string, error: string, nextAttemptAt: number | null, exhausted: boolean, now: number): Delivery
  listDueDeliveries(now: number, limit?: number): Delivery[]
  recordExternalMessage(adapter: string, externalEventId: string, input: AppendMessageInput, external?: ExternalMessageLink): Message
}
