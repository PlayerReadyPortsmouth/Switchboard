import type { AgentOperationsEvent, ConnectionState } from "./types"

export interface EventSourceLike { close(): void }
export interface EventSourceHandlers { open(): void; message(data: string): void; error(): void }
export interface AgentStreamHandlers {
  onEvent(event: AgentOperationsEvent): void
  onInvalidate(): void
  onState(state: ConnectionState): void
}

type Timer = unknown
type OnlineCallback = () => void | Promise<void>
interface AgentStreamDependencies {
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

export class AgentStream {
  private source: EventSourceLike | null = null
  private timer: Timer | null = null
  private active = false
  private cursor = 0
  private retries = 0
  private generation = 0
  private sourceAttempt = 0
  private handlers: AgentStreamHandlers | null = null
  private unsubscribeOnline: (() => void) | null = null
  private readonly setTimer: (callback: () => void | Promise<void>, delay: number) => Timer
  private readonly clearTimer: (timer: Timer) => void
  private readonly subscribeOnline: (callback: OnlineCallback) => () => void

  constructor(private readonly dependencies: AgentStreamDependencies = {
    open: openEventSource,
    online: () => navigator.onLine,
  }, private readonly basePath = "/") {
    this.setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = dependencies.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.subscribeOnline = dependencies.subscribeOnline ?? (callback => {
      const listener = () => { void callback() }
      window.addEventListener("online", listener)
      return () => window.removeEventListener("online", listener)
    })
  }

  async start(afterSequence: number, handlers: AgentStreamHandlers): Promise<void> {
    this.stop()
    this.active = true
    this.cursor = afterSequence
    this.retries = 0
    this.handlers = handlers
    handlers.onState("connecting")
    this.connect(this.generation)
  }

  stop(): void {
    this.generation++
    this.active = false
    this.sourceAttempt++
    this.source?.close()
    this.source = null
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.clearOnlineListener()
  }

  private connect(generation: number): void {
    if (!this.isCurrent(generation)) return
    try {
      const sourceAttempt = ++this.sourceAttempt
      const source = this.dependencies.open(`${this.basePath.replace(/\/$/, "")}/api/operations/agents/events?after=${this.cursor}`, {
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
      this.reconnect(generation)
    }
  }

  private receive(data: string, generation: number, sourceAttempt: number): void {
    if (!this.isCurrent(generation) || sourceAttempt !== this.sourceAttempt) return
    try {
      const event = JSON.parse(data) as AgentOperationsEvent
      if (event.kind === "snapshot_required" && Number.isSafeInteger(event.sequence)) {
        this.cursor = event.sequence
        this.handlers!.onInvalidate()
        return
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= this.cursor) return
      this.cursor = event.sequence
      this.handlers!.onEvent(event)
    } catch {
      // Ignore malformed payloads; the cursor remains on the last valid event.
    }
  }

  private reconnect(generation: number): void {
    if (!this.isCurrent(generation) || this.timer !== null || this.unsubscribeOnline !== null) return
    this.sourceAttempt++
    this.source?.close()
    this.source = null
    if (!this.dependencies.online()) {
      this.handlers!.onState("offline")
      let resumed = false
      this.unsubscribeOnline = this.subscribeOnline(() => {
        if (resumed) return
        resumed = true
        this.clearOnlineListener()
        if (!this.isCurrent(generation)) return
        this.handlers!.onState("reconnecting")
        this.connect(generation)
      })
      return
    }
    this.handlers!.onState("reconnecting")
    const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)]
    this.retries++
    this.timer = this.setTimer(() => {
      this.timer = null
      this.connect(generation)
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
