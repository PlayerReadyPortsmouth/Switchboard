export type ApprovalEventInput =
  | { kind: "approval_changed"; approvalId: string; pendingCount: number; ts: number }
  | { kind: "approvals_snapshot"; pendingCount: number; ts: number }

export type ApprovalOperationsEvent = (
  ApprovalEventInput | { kind: "snapshot_required"; pendingCount?: number; ts: number }
) & { sequence: number }

const eventCopy = (event: ApprovalOperationsEvent): ApprovalOperationsEvent => (
  { ...event } as ApprovalOperationsEvent
)

export class ApprovalEventStream {
  private sequence = 0
  private latestPendingCount: number | undefined
  private readonly retained: ApprovalOperationsEvent[] = []
  private readonly subscribers = new Set<(event: ApprovalOperationsEvent) => void>()
  private readonly pending: ApprovalOperationsEvent[] = []
  private delivering = false
  private readonly capacity: number

  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity)
  }

  publish(input: ApprovalEventInput): ApprovalOperationsEvent {
    this.latestPendingCount = input.pendingCount
    const event = Object.freeze({ ...input, sequence: ++this.sequence }) as ApprovalOperationsEvent
    this.retained.push(event)
    if (this.retained.length > this.capacity) this.retained.shift()
    this.pending.push(event)
    if (!this.delivering) {
      this.delivering = true
      let failed = false
      let failure: unknown
      try {
        while (this.pending.length > 0) {
          const next = this.pending.shift()!
          for (const subscriber of [...this.subscribers]) {
            try {
              subscriber(eventCopy(next))
            } catch (error) {
              this.subscribers.delete(subscriber)
              if (!failed) {
                failed = true
                failure = error
              }
            }
          }
        }
      } finally {
        this.delivering = false
      }
      if (failed) throw failure
    }
    return eventCopy(event)
  }

  subscribe(
    after: number,
    callback: (event: ApprovalOperationsEvent) => void,
  ): { unsubscribe(): void } {
    const replayThrough = this.sequence
    const retainedFloor = this.retained[0]?.sequence
    const replay = this.retained.filter(event => event.sequence > after && event.sequence <= replayThrough)
    const buffered: ApprovalOperationsEvent[] = []
    let replaying = true
    const subscriber = (event: ApprovalOperationsEvent): void => {
      if (event.sequence <= replayThrough) return
      if (replaying) buffered.push(event)
      else callback(event)
    }

    this.subscribers.add(subscriber)
    try {
      if (after > replayThrough || (retainedFloor !== undefined && after < retainedFloor - 1)) {
        callback({
          kind: "snapshot_required",
          ...(this.latestPendingCount === undefined ? {} : { pendingCount: this.latestPendingCount }),
          ts: Date.now(),
          sequence: replayThrough,
        })
      } else {
        for (const event of replay) callback(eventCopy(event))
      }
      while (buffered.length > 0) callback(buffered.shift()!)
      replaying = false
    } catch (error) {
      this.subscribers.delete(subscriber)
      throw error
    }

    return { unsubscribe: () => this.subscribers.delete(subscriber) }
  }
}
