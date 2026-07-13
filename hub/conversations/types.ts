export type ConversationRole = "owner" | "member" | "viewer"
export type ParticipantKind = "user" | "agent" | "external"
export type SyncMode = "two_way" | "inbound_only" | "outbound_only" | "notifications_only"
export type MessageOrigin = "web" | "agent" | "transport" | "system"
export type MessageState = "committed" | "queued" | "working" | "streaming" | "completed" | "failed"
export type DeliveryState = "pending" | "delivered" | "retry_wait" | "exhausted"

export interface Conversation { id: string; title: string; primaryAgent: string; createdBy: string; createdAt: number; updatedAt: number; archivedAt: number | null }
export interface Participant { conversationId: string; identity: string; kind: ParticipantKind; role: ConversationRole; createdAt: number }
export interface Message { id: string; conversationId: string; sequence: number; author: string; origin: MessageOrigin; content: string; replyTo: string | null; state: MessageState; clientKey: string | null; createdAt: number }
export interface TransportLink { id: string; conversationId: string; adapter: string; externalLocationId: string; label: string | null; syncMode: SyncMode; enabled: boolean; createdAt: number; updatedAt: number }
export interface Delivery { id: string; messageId: string; linkId: string; eventKind: string; state: DeliveryState; attempts: number; nextAttemptAt: number | null; externalMessageId: string | null; error: string | null; leaseOwner: string | null; leaseExpiresAt: number | null; createdAt: number; updatedAt: number }
export interface ExternalEventReceipt { adapter: string; externalEventId: string; messageId: string; receivedAt: number }
export interface NewConversation { id: string; title: string; primaryAgent: string; createdBy: string; createdAt: number }
export interface ConversationUpdate { title?: string; primaryAgent?: string }
export interface AppendMessageInput { id: string; conversationId: string; author: string; origin: MessageOrigin; content: string; replyTo?: string; state?: MessageState; clientKey?: string; createdAt: number }
