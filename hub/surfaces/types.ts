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
  // Human-readable location naming, used to title canonical conversations legibly.
  // All optional — an adapter that cannot resolve a name simply omits them and the
  // consumer falls back to the raw external id.
  locationName?: string      // the location's own name; for a thread, the THREAD's name
  threadParentName?: string  // set when the location is a thread: the parent's name
  isDM?: boolean             // direct message: there is no channel name to show
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
