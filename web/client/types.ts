export type MessageOrigin = "web" | "agent" | "transport" | "system"
export type MessageState = "committed" | "queued" | "working" | "streaming" | "completed" | "failed"
export type SyncMode = "two_way" | "inbound_only" | "outbound_only" | "notifications_only"
export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline"

export interface AgentSummary { name: string; alive: boolean; busy: boolean }
export interface Session { identity: string; agents: AgentSummary[] }
export interface Conversation { id: string; title: string; primaryAgent: string; createdBy: string; createdAt: number; updatedAt: number; archivedAt: number | null }
export interface ConversationInput { title: string; primaryAgent: string }
export interface ConversationUpdate { title?: string; primaryAgent?: string }
export interface Message { id: string; conversationId: string; sequence: number; author: string; origin: MessageOrigin; content: string; replyTo: string | null; state: MessageState; clientKey: string | null; createdAt: number }
export interface PostMessageInput { content: string; clientKey: string; replyTo?: string }
export interface TransportLink { id: string; conversationId: string; adapter: string; externalLocationId: string; label: string | null; syncMode: SyncMode; enabled: boolean; createdAt: number; updatedAt: number }

export interface ConversationEvent {
  kind: "message_committed" | "turn_state" | "activity"
  conversationId: string
  sequence: number
  ts: number
  message?: Message
  state?: MessageState
  detail?: Record<string, unknown>
}
