export type ProductionIngressResult<T> = { accepted: true; value: T } | { accepted: false }

/** Synchronous process-wide admission boundary for conversation producers. */
export class ProductionIngressGate {
  private open = true
  close(): void { this.open = false }
  tryRun<T>(producer: () => T): ProductionIngressResult<T> {
    if (!this.open) return { accepted: false }
    return { accepted: true, value: producer() }
  }
}
