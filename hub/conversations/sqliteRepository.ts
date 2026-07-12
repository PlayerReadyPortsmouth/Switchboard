import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { runConversationMigrations } from "./migrations"
import { RepositoryConflictError, RepositoryNotFoundError, type AppendMessageResult, type ConversationRepository } from "./repository"
import type { AppendMessageInput, Conversation, Delivery, Message, NewConversation, Participant, TransportLink } from "./types"

type Row = Record<string, unknown>
const conversation = (r: Row): Conversation => ({ id: r.id as string, title: r.title as string, primaryAgent: r.primary_agent as string, createdBy: r.created_by as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number, archivedAt: r.archived_at as number | null })
const participant = (r: Row): Participant => ({ conversationId: r.conversation_id as string, identity: r.identity as string, kind: r.kind as Participant["kind"], role: r.role as Participant["role"], createdAt: r.created_at as number })
const message = (r: Row): Message => ({ id: r.id as string, conversationId: r.conversation_id as string, sequence: r.sequence as number, author: r.author as string, origin: r.origin as Message["origin"], content: r.content as string, replyTo: r.reply_to as string | null, state: r.state as Message["state"], clientKey: r.client_key as string | null, createdAt: r.created_at as number })
const link = (r: Row): TransportLink => ({ id: r.id as string, conversationId: r.conversation_id as string, adapter: r.adapter as string, externalLocationId: r.external_location_id as string, label: r.label as string | null, syncMode: r.sync_mode as TransportLink["syncMode"], enabled: Boolean(r.enabled), createdAt: r.created_at as number, updatedAt: r.updated_at as number })
const delivery = (r: Row): Delivery => ({ id: r.id as string, messageId: r.message_id as string, linkId: r.link_id as string, eventKind: r.event_kind as string, state: r.state as Delivery["state"], attempts: r.attempts as number, nextAttemptAt: r.next_attempt_at as number | null, externalMessageId: r.external_message_id as string | null, error: r.error as string | null, createdAt: r.created_at as number, updatedAt: r.updated_at as number })

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
    const replyTo = input.replyTo?.trim()
    if (input.replyTo !== undefined) {
      if (!replyTo) throw new RepositoryConflictError("Reply target is required when replyTo is provided")
      const target = this.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM messages WHERE id=?").get(replyTo)
      if (!target || target.conversation_id !== input.conversationId) {
        throw new RepositoryConflictError(`Reply target ${replyTo} must belong to conversation ${input.conversationId}`)
      }
    }
    const next = this.db.query<{ sequence: number }, [string]>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM messages WHERE conversation_id=?").get(input.conversationId)!.sequence
    this.db.query("INSERT INTO messages(id,conversation_id,sequence,author,origin,content,reply_to,state,client_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(input.id, input.conversationId, next, input.author, input.origin, input.content, replyTo ?? null, input.state ?? "committed", input.clientKey ?? null, input.createdAt)
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
  resolveTransportLink(adapter: string, externalLocationId: string): TransportLink | null {
    const row = this.db.query<Row, [string, string]>("SELECT * FROM transport_links WHERE adapter=? AND external_location_id=?").get(adapter, externalLocationId)
    return row ? link(row) : null
  }
  appendAgentMessage(input: AppendMessageInput, links: TransportLink[], now: number): { message: Message; deliveries: Delivery[]; inserted: boolean } {
    return this.db.transaction(() => {
      const saved = this.appendWithinTransaction(input)
      return { ...saved, deliveries: this.createDeliveriesWithinTransaction(saved.message.id, links, "message", now) }
    }).immediate()
  }
  createDeliveries(messageId: string, links: TransportLink[], eventKind: string, now: number): Delivery[] {
    return this.db.transaction(() => this.createDeliveriesWithinTransaction(messageId, links, eventKind, now)).immediate()
  }
  private createDeliveriesWithinTransaction(messageId: string, links: TransportLink[], eventKind: string, now: number): Delivery[] {
    const results: Delivery[] = []
    const seen = new Set<string>()
    const messageRow = this.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM messages WHERE id=?").get(messageId)
    if (!messageRow) throw new RepositoryNotFoundError(`Message ${messageId} not found`)
    for (const transportLink of links) {
      if (seen.has(transportLink.id)) continue
      seen.add(transportLink.id)
      const linkRow = this.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM transport_links WHERE id=?").get(transportLink.id)
      if (!linkRow || linkRow.conversation_id !== messageRow.conversation_id) {
        throw new RepositoryConflictError(`Delivery link ${transportLink.id} must belong to conversation ${messageRow.conversation_id}`)
      }
      this.db.query("INSERT OR IGNORE INTO deliveries(id,message_id,link_id,event_kind,state,attempts,next_attempt_at,external_message_id,error,created_at,updated_at) VALUES (?,?,?,?, 'pending',0,NULL,NULL,NULL,?,?)").run(randomUUID(), messageId, transportLink.id, eventKind, now, now)
      const row = this.db.query<Row, [string, string, string]>("SELECT * FROM deliveries WHERE message_id=? AND link_id=? AND event_kind=?").get(messageId, transportLink.id, eventKind)
      if (!row) throw new RepositoryConflictError(`Could not create delivery for link ${transportLink.id}`)
      results.push(delivery(row))
    }
    return results
  }
  markDeliveryDelivered(id: string, externalMessageId: string | null, now: number): Delivery {
    const result = this.db.query("UPDATE deliveries SET state='delivered', external_message_id=?, error=NULL, next_attempt_at=NULL, updated_at=? WHERE id=? AND state IN ('pending','retry_wait')").run(externalMessageId, now, id)
    if (!result.changes) this.throwDeliveryTransitionError(id)
    return this.getDelivery(id)!
  }
  resolveDeliveredExternalMessageId(messageId: string, linkId: string): string | null {
    const inbound = this.db.query<{ external_message_id: string }, [string, string]>("SELECT external_message_id FROM external_message_links WHERE message_id=? AND link_id=?").get(messageId, linkId)
    if (inbound) return inbound.external_message_id
    const row = this.db.query<{ external_message_id: string | null }, [string, string]>("SELECT external_message_id FROM deliveries WHERE message_id=? AND link_id=? AND state='delivered' AND external_message_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(messageId, linkId)
    return row?.external_message_id ?? null
  }
  markDeliveryRetry(id: string, error: string, nextAttemptAt: number | null, exhausted: boolean, now: number): Delivery {
    if (!exhausted && nextAttemptAt === null) throw new RepositoryConflictError("A retry schedule is required unless the delivery is exhausted")
    const result = this.db.query("UPDATE deliveries SET state=?, attempts=attempts+1, next_attempt_at=?, error=?, updated_at=? WHERE id=? AND state IN ('pending','retry_wait')").run(exhausted ? "exhausted" : "retry_wait", exhausted ? null : nextAttemptAt, error.slice(0, 500), now, id)
    if (!result.changes) this.throwDeliveryTransitionError(id)
    return this.getDelivery(id)!
  }
  listDueDeliveries(now: number, limit = 200): Delivery[] {
    const boundedLimit = Math.min(200, Math.max(0, Math.trunc(limit)))
    return this.db.query<Row, [number, number]>("SELECT * FROM deliveries WHERE state='pending' OR (state='retry_wait' AND next_attempt_at<=?) ORDER BY COALESCE(next_attempt_at,created_at),created_at,id LIMIT ?").all(now, boundedLimit).map(delivery)
  }
  private getDelivery(id: string): Delivery | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM deliveries WHERE id=?").get(id)
    return row ? delivery(row) : null
  }
  private throwDeliveryTransitionError(id: string): never {
    if (!this.getDelivery(id)) throw new RepositoryNotFoundError(`Delivery ${id} not found`)
    throw new RepositoryConflictError(`Delivery ${id} is already terminal`)
  }
  recordExternalMessage(adapter: string, externalEventId: string, input: AppendMessageInput, external?: { linkId: string; externalMessageId: string }): Message {
    return this.db.transaction(() => {
      const receipt = this.db.query<{ message_id: string }, [string,string]>("SELECT message_id FROM external_event_receipts WHERE adapter=? AND external_event_id=?").get(adapter, externalEventId)
      const saved = receipt ? this.getMessage(receipt.message_id)! : this.appendWithinTransaction(input).message
      if (!receipt) this.db.query("INSERT INTO external_event_receipts(adapter,external_event_id,message_id,received_at) VALUES (?,?,?,?)").run(adapter, externalEventId, saved.id, input.createdAt)
      if (external) {
        const linkRow = this.db.query<{ conversation_id: string; adapter: string }, [string]>("SELECT conversation_id,adapter FROM transport_links WHERE id=?").get(external.linkId)
        if (!linkRow || linkRow.conversation_id !== saved.conversationId || linkRow.adapter !== adapter) throw new RepositoryConflictError(`External message link ${external.linkId} does not match ${adapter}:${saved.conversationId}`)
        this.db.query("INSERT OR IGNORE INTO external_message_links(message_id,link_id,external_message_id,received_at) VALUES (?,?,?,?)").run(saved.id, external.linkId, external.externalMessageId, input.createdAt)
        const mapping = this.db.query<{ external_message_id: string }, [string,string]>("SELECT external_message_id FROM external_message_links WHERE message_id=? AND link_id=?").get(saved.id, external.linkId)
        if (mapping?.external_message_id !== external.externalMessageId) throw new RepositoryConflictError(`External message mapping conflicts for ${external.linkId}:${external.externalMessageId}`)
      }
      return saved
    }).immediate()
  }
}
