export type AgentEventInput =
  | { kind: "agent_changed"; agent: string; ts: number }
  | { kind: "agents_snapshot"; ts: number }
  | { kind: "config_applied"; agent: string; ts: number }
  | { kind: "action_completed"; agent: string; action: "reset" | "restart"; ts: number }

export type AgentOperationsEvent = (AgentEventInput | { kind: "snapshot_required"; ts: number }) & { sequence: number }

const eventCopy = (event: AgentOperationsEvent): AgentOperationsEvent => ({ ...event } as AgentOperationsEvent)

export class AgentEventStream {
  private sequence = 0
  private readonly retained: AgentOperationsEvent[] = []
  private readonly subscribers = new Set<(event: AgentOperationsEvent) => void>()
  private readonly pending: AgentOperationsEvent[] = []
  private delivering = false
  private readonly capacity: number

  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity)
  }

  publish(input: AgentEventInput): AgentOperationsEvent {
    const event = Object.freeze({ ...input, sequence: ++this.sequence }) as AgentOperationsEvent
    this.retained.push(event)
    if (this.retained.length > this.capacity) this.retained.shift()
    this.pending.push(event)
    if (!this.delivering) {
      this.delivering = true
      try {
        while (this.pending.length > 0) {
          const next = this.pending.shift()!
          for (const subscriber of [...this.subscribers]) subscriber(eventCopy(next))
        }
      } finally {
        this.delivering = false
      }
    }
    return eventCopy(event)
  }

  subscribe(after: number, callback: (event: AgentOperationsEvent) => void): { unsubscribe(): void } {
    const replayThrough = this.sequence
    const retainedFloor = this.retained[0]?.sequence
    const replay = this.retained.filter(event => event.sequence > after && event.sequence <= replayThrough)
    const buffered: AgentOperationsEvent[] = []
    let replaying = true
    const subscriber = (event: AgentOperationsEvent): void => {
      if (event.sequence <= replayThrough) return
      if (replaying) buffered.push(event)
      else callback(event)
    }

    this.subscribers.add(subscriber)
    try {
      if (retainedFloor !== undefined && after < retainedFloor - 1) {
        callback({ kind: "snapshot_required", ts: Date.now(), sequence: replayThrough })
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
