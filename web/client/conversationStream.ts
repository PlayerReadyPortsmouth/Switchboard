import type { ConnectionState, ConversationEvent, Message } from "./types"

export interface EventSourceLike { close(): void }
export interface EventSourceHandlers { open(): void; message(data: string): void; error(): void }
export interface ConversationStreamHandlers {
  onMessages(messages: Message[]): void
  onEvent(event: ConversationEvent): void
  onState(state: ConnectionState): void
}

type Timer = unknown
type OnlineCallback = () => void | Promise<void>
interface ConversationStreamDependencies {
  fetchGap(afterSequence: number, conversationId: string): Promise<Message[]>
  open(url: string, handlers: EventSourceHandlers): EventSourceLike
  online(): boolean
  subscribeOnline?(callback: OnlineCallback): () => void
  setTimer?(callback: () => void | Promise<void>, delay: number): Timer
  clearTimer?(timer: Timer): void
}

const RETRY_DELAYS = [1000, 2000, 5000, 10000] as const

const openEventSource = (url: string, handlers: EventSourceHandlers): EventSourceLike => {
  const source = new EventSource(url)
  source.addEventListener("open", handlers.open)
  source.addEventListener("message", event => handlers.message(event.data))
  source.addEventListener("error", handlers.error)
  return source
}

export class ConversationStream {
  private source: EventSourceLike | null = null
  private timer: Timer | null = null
  private active = false
  private conversationId = ""
  private cursor = 0
  private retries = 0
  private generation = 0
  private connectingGeneration: number | null = null
  private sourceAttempt = 0
  private handlers: ConversationStreamHandlers | null = null
  private unsubscribeOnline: (() => void) | null = null
  private readonly setTimer: (callback: () => void | Promise<void>, delay: number) => Timer
  private readonly clearTimer: (timer: Timer) => void
  private readonly subscribeOnline: (callback: OnlineCallback) => () => void

  constructor(private readonly dependencies: ConversationStreamDependencies) {
    this.setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = dependencies.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.subscribeOnline = dependencies.subscribeOnline ?? (callback => {
      const listener = () => { void callback() }
      window.addEventListener("online", listener)
      return () => window.removeEventListener("online", listener)
    })
  }

  async start(conversationId: string, afterSequence: number, handlers: ConversationStreamHandlers): Promise<void> {
    this.stop()
    this.active = true
    this.conversationId = conversationId
    this.cursor = afterSequence
    this.retries = 0
    this.handlers = handlers
    handlers.onState("connecting")
    await this.connect(this.generation)
  }

  stop(): void {
    this.generation++
    this.active = false
    this.source?.close()
    this.source = null
    this.sourceAttempt++
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.clearOnlineListener()
    this.connectingGeneration = null
  }

  private async connect(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.connectingGeneration === generation) return
    this.connectingGeneration = generation
    let failed = false
    try {
      const gap = await this.dependencies.fetchGap(this.cursor, this.conversationId)
      if (!this.isCurrent(generation)) return
      if (gap.length) {
        this.handlers!.onMessages(gap)
        if (!this.isCurrent(generation)) return
        this.cursor = Math.max(this.cursor, ...gap.map(message => message.sequence))
      }
      const url = `/api/conversations/${encodeURIComponent(this.conversationId)}/events?after=${this.cursor}`
      const sourceAttempt = ++this.sourceAttempt
      const source = this.dependencies.open(url, {
        open: () => {
          if (!this.isCurrent(generation) || sourceAttempt !== this.sourceAttempt) return
          this.retries = 0
          this.handlers!.onState("live")
        },
        message: data => this.receive(data, generation, sourceAttempt),
        error: () => {
          if (sourceAttempt === this.sourceAttempt) this.reconnect(generation)
        },
      })
      if (!this.isCurrent(generation) || sourceAttempt !== this.sourceAttempt) {
        source.close()
        return
      }
      this.source = source
    } catch {
      failed = true
    } finally {
      if (this.connectingGeneration === generation) this.connectingGeneration = null
    }
    if (failed) this.reconnect(generation)
  }

  private receive(data: string, generation: number, sourceAttempt: number): void {
    if (!this.isCurrent(generation) || sourceAttempt !== this.sourceAttempt) return
    try {
      const event = JSON.parse(data) as ConversationEvent
      if (event.kind === "message_committed" && event.message) this.cursor = Math.max(this.cursor, event.message.sequence)
      this.handlers!.onEvent(event)
    } catch {
      // Ignore malformed event payloads; reconnect/history remains canonical.
    }
  }

  private reconnect(generation: number): void {
    if (!this.isCurrent(generation) || this.connectingGeneration === generation || this.timer !== null || this.unsubscribeOnline !== null) return
    this.sourceAttempt++
    this.source?.close()
    this.source = null
    if (!this.dependencies.online()) {
      this.handlers!.onState("offline")
      let resumed = false
      this.unsubscribeOnline = this.subscribeOnline(async () => {
        if (resumed) return
        resumed = true
        this.clearOnlineListener()
        if (!this.isCurrent(generation)) return
        this.handlers!.onState("reconnecting")
        await this.connect(generation)
      })
      return
    }
    this.handlers!.onState("reconnecting")
    const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)]
    this.retries++
    this.timer = this.setTimer(async () => {
      this.timer = null
      await this.connect(generation)
    }, delay)
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.handlers !== null && generation === this.generation
  }

  private clearOnlineListener(): void {
    this.unsubscribeOnline?.()
    this.unsubscribeOnline = null
  }
}
