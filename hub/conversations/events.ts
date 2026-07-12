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
type ConversationQueue = { events: ConversationEvent[]; draining: boolean }
const REPLAY_PAGE_SIZE = 500

export class ConversationEventStream {
  private readonly subscriptions = new Map<string, Set<Subscription>>()
  private readonly queues = new Map<string, ConversationQueue>()

  constructor(private readonly history: (conversationId: string, afterSequence: number, limit: number) => Message[]) {}

  publish(event: ConversationEvent): void {
    const queue = this.queues.get(event.conversationId) ?? { events: [], draining: false }
    queue.events.push(event)
    this.queues.set(event.conversationId, queue)
    if (queue.draining) return

    queue.draining = true
    try {
      while (queue.events.length) {
        const next = queue.events.shift()!
        for (const subscription of this.subscriptions.get(next.conversationId) ?? []) {
          if (next.sequence <= subscription.highWaterMark) continue
          if (subscription.replaying) subscription.pending.push(next)
          else this.deliver(subscription, next)
        }
      }
    } finally {
      queue.draining = false
      if (!queue.events.length) this.queues.delete(event.conversationId)
    }
  }

  subscribe(conversationId: string, afterSequence: number, callback: Callback): () => void {
    const subscription: Subscription = { callback, highWaterMark: afterSequence, replaying: true, pending: [] }
    const conversationSubscriptions = this.subscriptions.get(conversationId) ?? new Set<Subscription>()
    conversationSubscriptions.add(subscription)
    this.subscriptions.set(conversationId, conversationSubscriptions)

    while (true) {
      const pageStart = subscription.highWaterMark
      const replay = this.history(conversationId, pageStart, REPLAY_PAGE_SIZE)
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
      if (replay.length < REPLAY_PAGE_SIZE || subscription.highWaterMark <= pageStart) break
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
    try {
      subscription.callback(event)
    } catch {
      // Subscriber failures must not interrupt persistence callers or other subscribers.
    }
  }
}
