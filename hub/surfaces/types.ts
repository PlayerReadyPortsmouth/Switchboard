import type { Message, TransportLink } from "../conversations/types"

export interface NormalizedSurfaceEvent {
  adapter: string
  eventId: string
  externalLocationId: string
  externalMessageId: string
  authorId: string
  authorName: string
  content: string
  createdAt: number
  replyToExternalId?: string
}

export interface SurfaceDelivery {
  deliveryId: string
  conversationId: string
  link: TransportLink
  message: Message
  replyToExternalId?: string
}

export interface SurfaceDeliveryResult {
  deliveryId: string
  adapter: string
  ok: boolean
  externalMessageId?: string
  error?: string
  retryable?: boolean
}

export interface SurfaceCapabilities {
  text: boolean
  replies: boolean
  cards: boolean
  attachments: boolean
  edits: boolean
  deletes: boolean
}

export type SurfaceDeliveryKind = "transcript" | "notification"
