import type { AppendMessageInput, Conversation, Message, NewConversation, Participant, TransportLink } from "./types"

export class RepositoryConflictError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryConflictError" }
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "RepositoryNotFoundError" }
}

export interface ConversationRepository {
  createConversation(input: NewConversation): Conversation
  createConversationWithOwner(input: NewConversation, owner: Participant): Conversation
  getConversation(id: string): Conversation | null
  listConversations(identity: string, includeArchived?: boolean): Conversation[]
  archiveConversation(id: string, archivedAt: number): Conversation
  addParticipant(input: Participant): Participant
  getParticipant(conversationId: string, identity: string): Participant | null
  appendMessage(input: AppendMessageInput): Message
  getMessage(id: string): Message | null
  listMessages(conversationId: string, afterSequence?: number, limit?: number): Message[]
  createTransportLink(input: Omit<TransportLink, "createdAt" | "updatedAt">, now: number): TransportLink
  listTransportLinks(conversationId: string): TransportLink[]
  recordExternalMessage(adapter: string, externalEventId: string, input: AppendMessageInput): Message
}
