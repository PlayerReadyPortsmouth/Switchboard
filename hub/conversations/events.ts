import type { Message, MessageState } from "./types"

export interface ConversationEvent {
  kind: "message_committed" | "turn_state" | "activity"
  conversationId: string
  sequence: number
  ts: number
  message?: Message
  state?: MessageState
  detail?: Record<string, unknown>
}

type Callback = (event: ConversationEvent) => void
type Subscription = {
  callback: Callback
  highWaterMark: number
  replaying: boolean
  pending: ConversationEvent[]
}

export class ConversationEventStream {
  private readonly subscriptions = new Map<string, Set<Subscription>>()

  constructor(private readonly history: (conversationId: string, afterSequence: number) => Message[]) {}

  publish(event: ConversationEvent): void {
    for (const subscription of this.subscriptions.get(event.conversationId) ?? []) {
      if (event.sequence <= subscription.highWaterMark) continue
      if (subscription.replaying) subscription.pending.push(event)
      else this.deliver(subscription, event)
    }
  }

  subscribe(conversationId: string, afterSequence: number, callback: Callback): () => void {
    const subscription: Subscription = { callback, highWaterMark: afterSequence, replaying: true, pending: [] }
    const conversationSubscriptions = this.subscriptions.get(conversationId) ?? new Set<Subscription>()
    conversationSubscriptions.add(subscription)
    this.subscriptions.set(conversationId, conversationSubscriptions)

    const replay = this.history(conversationId, afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
    for (const message of replay) {
      this.deliver(subscription, {
        kind: "message_committed",
        conversationId,
        sequence: message.sequence,
        ts: message.createdAt,
        message,
      })
    }
    subscription.replaying = false
    for (const event of subscription.pending.sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence > subscription.highWaterMark) this.deliver(subscription, event)
    }
    subscription.pending.length = 0

    return () => {
      conversationSubscriptions.delete(subscription)
      if (!conversationSubscriptions.size) this.subscriptions.delete(conversationId)
    }
  }

  private deliver(subscription: Subscription, event: ConversationEvent): void {
    if (event.sequence <= subscription.highWaterMark) return
    subscription.highWaterMark = event.sequence
    subscription.callback(event)
  }
}
