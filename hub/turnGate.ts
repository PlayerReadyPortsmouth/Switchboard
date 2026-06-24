import type { InboundMessage } from "./types"

/** Outcome of submitting a message to the gate. */
export type SubmitResult = "sent" | "queued" | "overflow"

export interface TurnGateOpts {
  /** Actually deliver a message to the agent (write its stdin frame). */
  send: (inbound: InboundMessage) => void
  maxQueueDepth?: number   // default 8; submissions past this are rejected
  coalesce?: boolean       // fold consecutive same-conversation, same-user queued messages into one
}

/** Serializes an agent's turns: at most one in flight, the rest queued in order.
 *
 *  A persistent agent is a single `claude` process — without a gate a burst of
 *  messages all land on its stdin mid-turn and their replies misroute. The gate
 *  delivers one message, waits for its `result`, then drains the next. It also
 *  exposes `busy`/`queueDepth` — the load signal the status board and the agent
 *  pool read. Pure logic; the real stdin write is injected via `send`. */
export class TurnGate {
  private busy = false
  private queue: InboundMessage[] = []
  constructor(private opts: TurnGateOpts) {}

  isBusy(): boolean { return this.busy }
  queueDepth(): number { return this.queue.length }

  /** Submit a message. Sends immediately when idle; otherwise queues it (until
   *  the depth cap, past which it is rejected as "overflow"). */
  submit(inbound: InboundMessage): SubmitResult {
    if (!this.busy) { this.busy = true; this.opts.send(inbound); return "sent" }
    const cap = this.opts.maxQueueDepth ?? 8
    if (this.opts.coalesce) {
      const last = this.queue[this.queue.length - 1]
      if (last && last.chatId === inbound.chatId && last.userId === inbound.userId) {
        this.queue[this.queue.length - 1] = { ...last, content: `${last.content}\n${inbound.content}` }
        return "queued"
      }
    }
    if (this.queue.length >= cap) return "overflow"
    this.queue.push(inbound)
    return "queued"
  }

  /** Signal that the in-flight turn finished (its `result` arrived). Drains the
   *  next queued message (starting its turn) or goes idle. No-op when idle. */
  turnComplete(): void {
    if (!this.busy) return
    const next = this.queue.shift()
    if (next) this.opts.send(next)   // stays busy: the next turn is now in flight
    else this.busy = false
  }

  /** Drop in-flight + queued state (e.g. the agent process exited/restarted). */
  reset(): void { this.busy = false; this.queue = [] }
}
