import type { PeerEnvelope } from "./peering"

export interface SpoolItem {
  id: string
  target: string
  body: PeerEnvelope
  attempts: number
  nextAt: number
}

export interface PeerSpoolDeps {
  now: () => number
  maxAttempts: number
  baseDelayMs: number
  send: (item: SpoolItem) => Promise<boolean>
  onDeadLetter: (item: SpoolItem) => void
}

export class PeerSpool {
  private items: SpoolItem[] = []
  private seq = 0
  constructor(private deps: PeerSpoolDeps) {}

  enqueue(target: string, body: PeerEnvelope): SpoolItem {
    const item: SpoolItem = { id: `s${++this.seq}`, target, body, attempts: 0, nextAt: this.deps.now() }
    this.items.push(item)
    return item
  }

  async drainOnce(): Promise<void> {
    const t = this.deps.now()
    const due = this.items.filter((i) => i.nextAt <= t)
    for (const item of due) {
      const ok = await this.deps.send(item)
      if (ok) { this.remove(item); continue }
      item.attempts++
      if (item.attempts >= this.deps.maxAttempts) {
        this.remove(item)
        this.deps.onDeadLetter(item)
      } else {
        item.nextAt = t + this.deps.baseDelayMs * 2 ** (item.attempts - 1)
      }
    }
  }

  private remove(item: SpoolItem): void {
    const i = this.items.indexOf(item)
    if (i >= 0) this.items.splice(i, 1)
  }

  size(): number { return this.items.length }
  snapshot(): SpoolItem[] { return this.items.map((i) => ({ ...i })) }
  restore(items: SpoolItem[]): void { this.items = items.map((i) => ({ ...i })); this.seq = items.length }
}
