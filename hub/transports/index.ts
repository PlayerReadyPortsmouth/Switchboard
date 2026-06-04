import type { InboundMessage, AgentReply } from "../types"

export interface AgentTransport {
  readonly name: string
  deliver(chatKey: string, inbound: InboundMessage): void
  onReply(cb: (reply: AgentReply) => void): void
  isAvailable(): boolean
}

/** Routes inbound messages to the right transport and fans replies back out. */
export class Dispatcher {
  private byName = new Map<string, AgentTransport>()
  private replyCb: (r: AgentReply) => void = () => {}

  constructor(transports: AgentTransport[]) {
    for (const t of transports) {
      this.byName.set(t.name, t)
      t.onReply(r => this.replyCb(r))
    }
  }
  dispatch(agent: string, chatKey: string, inbound: InboundMessage): boolean {
    const t = this.byName.get(agent)
    if (!t || !t.isAvailable()) return false
    t.deliver(chatKey, inbound)
    return true
  }
  isAvailable(agent: string): boolean {
    return this.byName.get(agent)?.isAvailable() ?? false
  }
  onReply(cb: (r: AgentReply) => void): void { this.replyCb = cb }
  replace(name: string, t: AgentTransport): void {
    this.byName.set(name, t)
    t.onReply((r) => this.replyCb(r))
  }
}
