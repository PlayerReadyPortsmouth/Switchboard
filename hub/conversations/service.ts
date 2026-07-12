import { RepositoryConflictError, RepositoryNotFoundError, type AppendMessageResult, type ConversationRepository } from "./repository"
import type { Conversation, Message, SyncMode, TransportLink } from "./types"
import type { ConversationEventStream } from "./events"

export class ConversationForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = "ConversationForbiddenError" }
}

export class ConversationValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ConversationValidationError" }
}

type CreateInput = { title: string; primaryAgent: string }
type UserMessageInput = { content: string; clientKey: string; replyTo?: string }
type LinkInput = { adapter: string; externalLocationId: string; label?: string | null; syncMode?: SyncMode; enabled?: boolean }
export const MAX_MESSAGES_PAGE_SIZE = 200

export class ConversationService {
  constructor(
    private repo: ConversationRepository,
    private now: () => number,
    private id: () => string,
    private events?: ConversationEventStream,
  ) {}

  create(identity: string, input: CreateInput): Conversation {
    const title = input.title.trim()
    const primaryAgent = input.primaryAgent.trim()
    if (!title) throw new ConversationValidationError("Conversation title is required")
    if (!primaryAgent) throw new ConversationValidationError("Primary agent is required")
    const createdAt = this.now()
    const conversationId = this.id()
    return this.repo.createConversationWithOwner(
      { id: conversationId, title, primaryAgent, createdBy: identity, createdAt },
      { conversationId, identity, kind: "user", role: "owner", createdAt },
    )
  }

  list(identity: string, includeArchived = false): Conversation[] {
    return this.repo.listConversations(identity, includeArchived)
  }

  get(identity: string, conversationId: string): Conversation {
    const conversation = this.requireConversation(conversationId)
    this.requireParticipant(identity, conversationId)
    return conversation
  }

  archive(identity: string, conversationId: string): Conversation {
    this.requireRole(identity, conversationId, ["owner"])
    return this.repo.archiveConversation(conversationId, this.now())
  }

  appendUserMessage(identity: string, conversationId: string, input: UserMessageInput): AppendMessageResult {
    if (!input.content.trim()) throw new ConversationValidationError("Message content is required")
    if (!input.clientKey?.trim()) throw new ConversationValidationError("Client key is required")
    const replyTo = input.replyTo?.trim()
    if (input.replyTo !== undefined && !replyTo) throw new ConversationValidationError("Reply target is required when replyTo is provided")
    this.requireRole(identity, conversationId, ["owner", "member"])
    try {
      const result = this.repo.appendMessage({ id: this.id(), conversationId, author: identity, origin: "web", content: input.content, ...(replyTo === undefined ? {} : { replyTo }), state: "committed", clientKey: input.clientKey, createdAt: this.now() })
      if (result.inserted) {
        this.events?.publish({ kind: "message_committed", conversationId, sequence: result.message.sequence, ts: result.message.createdAt, message: result.message })
      }
      return result
    } catch (error) {
      if (error instanceof RepositoryConflictError) throw new ConversationValidationError(error.message)
      throw error
    }
  }

  history(identity: string, conversationId: string, afterSequence = 0, limit = 100): Message[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new ConversationValidationError("Message cursor must be a non-negative integer")
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGES_PAGE_SIZE) throw new ConversationValidationError(`Message page size must be between 1 and ${MAX_MESSAGES_PAGE_SIZE}`)
    this.requireParticipant(identity, conversationId)
    return this.repo.listMessages(conversationId, afterSequence, limit)
  }

  addTransportLink(identity: string, conversationId: string, input: LinkInput): TransportLink {
    this.requireRole(identity, conversationId, ["owner"])
    const adapter = input.adapter.trim()
    const externalLocationId = input.externalLocationId.trim()
    if (!adapter) throw new ConversationValidationError("Transport adapter is required")
    if (!externalLocationId) throw new ConversationValidationError("External location ID is required")
    return this.repo.createTransportLink({ id: this.id(), conversationId, adapter, externalLocationId, label: input.label ?? null, syncMode: input.syncMode ?? "two_way", enabled: input.enabled ?? true }, this.now())
  }

  listTransportLinks(identity: string, conversationId: string): TransportLink[] {
    this.requireParticipant(identity, conversationId)
    return this.repo.listTransportLinks(conversationId)
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.repo.getConversation(conversationId)
    if (!conversation) throw new RepositoryNotFoundError(`Conversation ${conversationId} not found`)
    return conversation
  }

  private requireParticipant(identity: string, conversationId: string) {
    this.requireConversation(conversationId)
    const participant = this.repo.getParticipant(conversationId, identity)
    if (!participant) throw new ConversationForbiddenError(`Identity ${identity} cannot access conversation ${conversationId}`)
    return participant
  }

  private requireRole(identity: string, conversationId: string, roles: Array<"owner" | "member" | "viewer">) {
    const participant = this.requireParticipant(identity, conversationId)
    if (!roles.includes(participant.role)) throw new ConversationForbiddenError(`Role ${participant.role} cannot perform this action`)
    return participant
  }
}
