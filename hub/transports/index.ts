import type { InboundMessage, AgentReply, AgentTurnOutcome, SendOutcome } from "../types"

export interface AgentTransport {
  readonly name: string
  deliver(chatKey: string, inbound: InboundMessage): boolean | void
  onReply(cb: (reply: AgentReply) => void | Promise<void | SendOutcome>): void
  onTurnOutcome?(cb: (outcome: AgentTurnOutcome) => void | Promise<void>): void
  isAvailable(): boolean
}

/** Routes inbound messages to the right transport and fans replies back out. */
export class Dispatcher {
  private byName = new Map<string, AgentTransport>()
  private replyCb: (r: AgentReply) => void | Promise<void | SendOutcome> = () => {}
  private outcomeCb: (outcome: AgentTurnOutcome) => void | Promise<void> = () => {}

  constructor(transports: AgentTransport[], private readonly reportError: (error: unknown) => void = error => process.stderr.write(`dispatcher callback failed: ${error}\n`)) {
    for (const t of transports) {
      this.byName.set(t.name, t)
      this.bind(t)
    }
  }
  dispatch(agent: string, chatKey: string, inbound: InboundMessage): boolean {
    const t = this.byName.get(agent)
    if (!t || !t.isAvailable()) return false
    return t.deliver(chatKey, inbound) !== false
  }
  isAvailable(agent: string): boolean {
    return this.byName.get(agent)?.isAvailable() ?? false
  }
  onReply(cb: (r: AgentReply) => void | Promise<void | SendOutcome>): void { this.replyCb = cb }
  onTurnOutcome(cb: (outcome: AgentTurnOutcome) => void | Promise<void>): void { this.outcomeCb = cb }
  replace(name: string, t: AgentTransport): void {
    this.byName.set(name, t)
    this.bind(t)
  }

  private bind(t: AgentTransport): void {
    t.onReply(async r => {
      try { await this.replyCb(r) }
      catch (error) { this.safeReport(error); throw error }
    })
    t.onTurnOutcome?.(async outcome => {
      try { await this.outcomeCb(outcome) }
      catch (error) { this.safeReport(error); throw error }
    })
  }

  private safeReport(error: unknown): void {
    try { this.reportError(error) } catch {}
  }
}
