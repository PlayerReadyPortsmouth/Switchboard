import type { CardSpec } from "../types"
import type { Message, MessageState } from "./types"

/** One superseded state of a card, kept so an edit never silently destroys what the card
 *  said before. Rendered (if at all) as inert history — its buttons must NOT be clickable,
 *  because only the current revision's buttons are live. */
export interface CardRevision {
  revision: number
  card: CardSpec
  updatedAt: number
}

/** A rich card an agent posted into a conversation, surfaced as an interactive card in the
 *  web transcript.
 *
 *  Like AttachmentInfo, this shape is emitted on the LIVE event AND returned by the
 *  card hydration route, so a card looks identical whether it arrived over SSE or was
 *  rehydrated on load. Keep the two producers in step — a field added here must be filled
 *  by both.
 *
 *  Unlike an attachment, a card MUTATES: `update_card` re-emits the same `correlationId`
 *  with a higher `revision`. The transcript keeps ONE card per correlationId showing the
 *  latest state, anchored at `createdAt` (its first appearance) so an edit never reorders
 *  history. See the Lane C spec for why latest-in-place beats a message per edit — chiefly
 *  that a stale revision's buttons would still look clickable. */
export interface CardInfo {
  correlationId: string
  conversationId: string
  agent: string
  /** 1 on first post, +1 per edit. */
  revision: number
  /** Epoch ms of the FIRST post — the transcript anchor. Never changes across edits. */
  createdAt: number
  /** Epoch ms of THIS revision. */
  updatedAt: number
  /** Current state. Only these buttons are live. */
  card: CardSpec
  /** Prior states, oldest first. Absent when this card has never been edited. */
  history?: CardRevision[]
}

/** A document published into a web conversation, surfaced as an inline card in the transcript.
 *
 *  This shape is emitted on the LIVE event AND returned by the conversation-documents
 *  hydration route, so a card looks identical whether it arrived over SSE or was rehydrated
 *  on load. Keep the two producers in step — a field added here must be filled by both. */
export interface AttachmentInfo {
  token: string
  title: string
  contentType: string
  mode: string
  visibility: string
  /** Optional: the card renders a size only when one is supplied. */
  sizeBytes?: number
  /** Epoch ms, same clock as `Message.createdAt`. The transcript anchors each card to the
   *  nearest preceding agent message by this value, so it must survive hydration — the live
   *  event's own `ts` is lost once the client folds the event into its attachment slice. */
  createdAt: number
}

/** One tool call in an agent's turn, surfaced live in the web transcript's execution
 *  spine. A step is published twice: once as `running` when the tool fires, then once
 *  more with its terminal status — subscribers pair the two by `id`. */
export interface ToolStepInfo {
  id: string        // the tool_use id — pairs a result back to its use
  name: string      // e.g. "Read", "Bash"
  summary?: string  // one-line argument summary, already truncated server-side
  status: "running" | "ok" | "error"
  durationMs?: number
}

export interface ConversationEvent {
  kind: "message_committed" | "turn_state" | "activity" | "attachment" | "tool_step" | "card"
  conversationId: string
  sequence: number
  ts: number
  message?: Message
  state?: MessageState
  detail?: Record<string, unknown>
  attachment?: AttachmentInfo
  tool?: ToolStepInfo
  card?: CardInfo
}

/** Parse a document's `.sbmd`/mirror-row `createdAt` (ISO) into the epoch ms the transcript
 *  anchors on. The live emit and the hydration route both feed the SAME stored string through
 *  here, so a card's anchor is identical whether it arrived over SSE or was rehydrated.
 *  An unparseable stamp yields 0 — the card then anchors before every message and renders in
 *  the transcript's leading group rather than vanishing. Degrade, don't drop. */
export function attachmentCreatedAt(iso: string | undefined): number {
  const parsed = iso ? Date.parse(iso) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** Build an `attachment` event. These are live-only (not replayed from message history), so the
 *  monotonic clock value doubles as the sequence — attachments don't participate in replay
 *  ordering and never advance a subscriber's message high-water mark. */
export function buildAttachmentEvent(conversationId: string, info: AttachmentInfo, now: number): ConversationEvent {
  return { kind: "attachment", conversationId, sequence: now, ts: now, attachment: info }
}

/** Build a `tool_step` event. Live-only exactly like `attachment` (see above): the
 *  monotonic clock doubles as the sequence, and `shouldDeliver` never gates on it, so
 *  a tool step must not advance a subscriber's message replay high-water mark. */
export function buildToolStepEvent(conversationId: string, step: ToolStepInfo, now: number): ConversationEvent {
  return { kind: "tool_step", conversationId, sequence: now, ts: now, tool: step }
}

/** Build a `card` event. Live-only in the same sense as `attachment` and `tool_step` — the
 *  monotonic clock doubles as the sequence, `shouldDeliver` never gates on it, and it must
 *  not advance a subscriber's message replay high-water mark. Reload is served by the card
 *  hydration route, not by event replay, which is why cards are persisted rather than
 *  reconstructed from the event stream. */
export function buildCardEvent(info: CardInfo, now: number): ConversationEvent {
  return { kind: "card", conversationId: info.conversationId, sequence: now, ts: now, card: info }
}

/** Longest argument summary we ship to a client — one spine line, ellipsised in CSS
 *  anyway, so this only bounds the `title` tooltip and the payload size. */
const SUMMARY_LIMIT = 160

/** Fields worth showing per tool, most-specific first — the CLI shows the same thing
 *  (the path for Read, the command for Bash, the pattern for Grep). Unknown tools fall
 *  back to their first string-ish argument, which is right far more often than not. */
const SUMMARY_FIELDS = [
  // `pattern` outranks `path`: for Grep/Glob the pattern is the subject and the path
  // is the scope, and the scope is appended to it below rather than replacing it.
  "command", "file_path", "notebook_path", "pattern", "query", "url", "path", "prompt", "description",
]

/** One-line argument summary for a tool call, truncated server-side. Returns
 *  undefined when there is nothing worth showing (no input, or no legible field). */
export function summariseToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  const pick = SUMMARY_FIELDS.find((field) => typeof input[field] === "string" && (input[field] as string).trim())
    ?? Object.keys(input).find((field) => typeof input[field] === "string" && (input[field] as string).trim())
  if (!pick) return undefined
  // Collapse newlines/runs of whitespace so a heredoc or multi-line command still
  // renders as a single spine line.
  const text = (input[pick] as string).replace(/\s+/g, " ").trim()
  if (!text) return undefined
  const extra = pick === "pattern" && typeof input.path === "string" && input.path.trim() ? `  ${input.path.trim()}` : ""
  const line = text + extra
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
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
          if (!this.shouldDeliver(subscription, next)) continue
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
      if (this.shouldDeliver(subscription, event)) this.deliver(subscription, event)
    }
    subscription.pending.length = 0

    return () => {
      conversationSubscriptions.delete(subscription)
      if (!conversationSubscriptions.size) this.subscriptions.delete(conversationId)
    }
  }

  private deliver(subscription: Subscription, event: ConversationEvent): void {
    if (!this.shouldDeliver(subscription, event)) return
    if (event.kind === "message_committed") subscription.highWaterMark = event.sequence
    try {
      subscription.callback(event)
    } catch {
      // Subscriber failures must not interrupt persistence callers or other subscribers.
    }
  }

  private shouldDeliver(subscription: Subscription, event: ConversationEvent): boolean {
    return event.kind === "message_committed"
      ? event.sequence > subscription.highWaterMark
      : true
  }
}
