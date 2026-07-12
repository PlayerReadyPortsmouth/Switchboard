import type { Database } from "bun:sqlite"
import { runConversationMigrations } from "./migrations"
import { RepositoryConflictError, RepositoryNotFoundError, type AppendMessageResult, type ConversationRepository } from "./repository"
import type { AppendMessageInput, Conversation, Message, NewConversation, Participant, TransportLink } from "./types"

type Row = Record<string, unknown>
const conversation = (r: Row): Conversation => ({ id: r.id as string, title: r.title as string, primaryAgent: r.primary_agent as string, createdBy: r.created_by as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number, archivedAt: r.archived_at as number | null })
const participant = (r: Row): Participant => ({ conversationId: r.conversation_id as string, identity: r.identity as string, kind: r.kind as Participant["kind"], role: r.role as Participant["role"], createdAt: r.created_at as number })
const message = (r: Row): Message => ({ id: r.id as string, conversationId: r.conversation_id as string, sequence: r.sequence as number, author: r.author as string, origin: r.origin as Message["origin"], content: r.content as string, replyTo: r.reply_to as string | null, state: r.state as Message["state"], clientKey: r.client_key as string | null, createdAt: r.created_at as number })
const link = (r: Row): TransportLink => ({ id: r.id as string, conversationId: r.conversation_id as string, adapter: r.adapter as string, externalLocationId: r.external_location_id as string, label: r.label as string | null, syncMode: r.sync_mode as TransportLink["syncMode"], enabled: Boolean(r.enabled), createdAt: r.created_at as number, updatedAt: r.updated_at as number })

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) { runConversationMigrations(db) }

  createConversation(input: NewConversation): Conversation {
    return this.createConversationWithOwner(input, { conversationId: input.id, identity: input.createdBy, kind: "user", role: "owner", createdAt: input.createdAt })
  }
  createConversationWithOwner(input: NewConversation, owner: Participant): Conversation {
    this.db.transaction(() => {
      if (owner.conversationId !== input.id || owner.identity !== input.createdBy || owner.role !== "owner") {
        throw new RepositoryConflictError("Conversation owner must match the conversation creator")
      }
      this.db.query("INSERT INTO conversations(id,title,primary_agent,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(input.id, input.title, input.primaryAgent, input.createdBy, input.createdAt, input.createdAt)
      this.db.query("INSERT INTO participants(conversation_id,identity,kind,role,created_at) VALUES (?,?,?,?,?)").run(owner.conversationId, owner.identity, owner.kind, owner.role, owner.createdAt)
    })()
    return this.getConversation(input.id)!
  }
  getConversation(id: string): Conversation | null { const r = this.db.query<Row, [string]>("SELECT * FROM conversations WHERE id=?").get(id); return r ? conversation(r) : null }
  listConversations(identity: string, includeArchived = false): Conversation[] {
    return this.db.query<Row, [string, number]>(`SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id=c.id WHERE p.identity=? AND (? OR c.archived_at IS NULL) ORDER BY c.updated_at DESC, c.id`).all(identity, includeArchived ? 1 : 0).map(conversation)
  }
  archiveConversation(id: string, archivedAt: number): Conversation {
    const result = this.db.query("UPDATE conversations SET archived_at=?, updated_at=? WHERE id=?").run(archivedAt, archivedAt, id)
    if (!result.changes) throw new RepositoryNotFoundError(`Conversation ${id} not found`)
    return this.getConversation(id)!
  }
  addParticipant(input: Participant): Participant {
    this.db.query("INSERT INTO participants(conversation_id,identity,kind,role,created_at) VALUES (?,?,?,?,?)").run(input.conversationId, input.identity, input.kind, input.role, input.createdAt)
    return this.getParticipant(input.conversationId, input.identity)!
  }
  getParticipant(conversationId: string, identity: string): Participant | null { const r = this.db.query<Row, [string,string]>("SELECT * FROM participants WHERE conversation_id=? AND identity=?").get(conversationId, identity); return r ? participant(r) : null }

  appendMessage(input: AppendMessageInput): AppendMessageResult { return this.appendTransaction(input) }
  private readonly appendTransaction = (input: AppendMessageInput): AppendMessageResult => this.db.transaction(() => this.appendWithinTransaction(input)).immediate()
  private appendWithinTransaction(input: AppendMessageInput): AppendMessageResult {
    if (input.clientKey) { const found = this.db.query<Row, [string,string]>("SELECT * FROM messages WHERE conversation_id=? AND client_key=?").get(input.conversationId, input.clientKey); if (found) return { message: message(found), inserted: false } }
    const c = this.getConversation(input.conversationId)
    if (!c) throw new RepositoryNotFoundError(`Conversation ${input.conversationId} not found`)
    if (c.archivedAt !== null) throw new RepositoryConflictError(`Conversation ${input.conversationId} is archived`)
    if (input.replyTo) {
      const target = this.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM messages WHERE id=?").get(input.replyTo)
      if (!target || target.conversation_id !== input.conversationId) {
        throw new RepositoryConflictError(`Reply target ${input.replyTo} must belong to conversation ${input.conversationId}`)
      }
    }
    const next = this.db.query<{ sequence: number }, [string]>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM messages WHERE conversation_id=?").get(input.conversationId)!.sequence
    this.db.query("INSERT INTO messages(id,conversation_id,sequence,author,origin,content,reply_to,state,client_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(input.id, input.conversationId, next, input.author, input.origin, input.content, input.replyTo ?? null, input.state ?? "committed", input.clientKey ?? null, input.createdAt)
    this.db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(input.createdAt, input.conversationId)
    return { message: this.getMessage(input.id)!, inserted: true }
  }
  getMessage(id: string): Message | null { const r = this.db.query<Row, [string]>("SELECT * FROM messages WHERE id=?").get(id); return r ? message(r) : null }
  listMessages(conversationId: string, afterSequence = 0, limit = 100): Message[] { return this.db.query<Row, [string,number,number]>("SELECT * FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(conversationId, afterSequence, limit).map(message) }
  createTransportLink(input: Omit<TransportLink, "createdAt" | "updatedAt">, now: number): TransportLink {
    try { this.db.query("INSERT INTO transport_links(id,conversation_id,adapter,external_location_id,label,sync_mode,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(input.id,input.conversationId,input.adapter,input.externalLocationId,input.label,input.syncMode,input.enabled ? 1 : 0,now,now) }
    catch (error) { if (String(error).includes("UNIQUE constraint failed")) throw new RepositoryConflictError(`Transport location ${input.adapter}:${input.externalLocationId} already linked`); throw error }
    return this.listTransportLinks(input.conversationId).find(({ id }) => id === input.id)!
  }
  listTransportLinks(conversationId: string): TransportLink[] { return this.db.query<Row, [string]>("SELECT * FROM transport_links WHERE conversation_id=? ORDER BY created_at,id").all(conversationId).map(link) }
  recordExternalMessage(adapter: string, externalEventId: string, input: AppendMessageInput): Message {
    return this.db.transaction(() => {
      const receipt = this.db.query<{ message_id: string }, [string,string]>("SELECT message_id FROM external_event_receipts WHERE adapter=? AND external_event_id=?").get(adapter, externalEventId)
      if (receipt) return this.getMessage(receipt.message_id)!
      const saved = this.appendWithinTransaction(input).message
      this.db.query("INSERT INTO external_event_receipts(adapter,external_event_id,message_id,received_at) VALUES (?,?,?,?)").run(adapter, externalEventId, saved.id, input.createdAt)
      return saved
    }).immediate()
  }
}
