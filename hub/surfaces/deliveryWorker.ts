import type { ConversationRepository } from "../conversations/repository"
import type { SurfaceDeliveryResult } from "./types"

type DeliveryRepository = Pick<ConversationRepository,
  "listDueDeliveries" | "getMessage" | "listTransportLinks" | "markDeliveryDelivered" | "markDeliveryRetry">

export interface DeliveryRouter {
  deliver: (message: NonNullable<ReturnType<DeliveryRepository["getMessage"]>>, links: ReturnType<DeliveryRepository["listTransportLinks"]>) => Promise<SurfaceDeliveryResult[]>
}

export interface DeliveryWorkerOptions {
  now?: () => number
  jitter?: () => number
  maxAttempts?: number
  intervalMs?: number
  reportError?: (error: unknown) => void
}

export class DeliveryWorker {
  private active: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private readonly now: () => number
  private readonly jitter: () => number
  private readonly maxAttempts: number
  private readonly intervalMs: number
  private readonly reportError: (error: unknown) => void

  constructor(
    private readonly repo: DeliveryRepository,
    private readonly router: DeliveryRouter,
    options: DeliveryWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.jitter = options.jitter ?? (() => Math.floor(Math.random() * 251))
    this.maxAttempts = options.maxAttempts ?? 5
    this.intervalMs = options.intervalMs ?? 1_000
    this.reportError = options.reportError ?? (error => process.stderr.write(`delivery worker tick failed: ${error}\n`))
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick().catch(this.reportError) }, this.intervalMs)
    this.timer.unref?.()
    void this.tick().catch(this.reportError)
  }

  tick(): Promise<void> {
    if (this.stopped || this.active) return Promise.resolve()
    const run = this.processDue()
    this.active = run
    void run.then(
      () => { if (this.active === run) this.active = undefined },
      () => { if (this.active === run) this.active = undefined },
    )
    return run
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.active
  }

  private async processDue(): Promise<void> {
    const queriedAt = this.now()
    const deliveries = this.repo.listDueDeliveries(queriedAt, 100)
    for (const delivery of deliveries) {
      const now = this.now()
      try {
        const message = this.repo.getMessage(delivery.messageId)
        const link = message && this.repo.listTransportLinks(message.conversationId).find(item => item.id === delivery.linkId)
        if (!message || !link) {
          this.repo.markDeliveryRetry(delivery.id, "Delivery message or transport link not found", null, true, now)
          continue
        }
        const [result] = await this.router.deliver(message, [link])
        if (result?.ok) {
          this.repo.markDeliveryDelivered(delivery.id, result.externalMessageId ?? null, this.now())
          continue
        }
        const attempt = delivery.attempts + 1
        const retryable = result?.retryable !== false
        const exhausted = !retryable || attempt >= this.maxAttempts
        const error = result?.error ?? "Surface adapter returned no delivery result"
        const delay = Math.min(60_000, 1_000 * 2 ** (attempt - 1)) + Math.max(0, Math.min(250, Math.trunc(this.jitter())))
        this.repo.markDeliveryRetry(delivery.id, error, exhausted ? null : this.now() + delay, exhausted, this.now())
      } catch (error) {
        const attempt = delivery.attempts + 1
        const exhausted = attempt >= this.maxAttempts
        const delay = Math.min(60_000, 1_000 * 2 ** (attempt - 1)) + Math.max(0, Math.min(250, Math.trunc(this.jitter())))
        this.repo.markDeliveryRetry(delivery.id, error instanceof Error ? error.message : String(error), exhausted ? null : this.now() + delay, exhausted, this.now())
      }
    }
  }
}
