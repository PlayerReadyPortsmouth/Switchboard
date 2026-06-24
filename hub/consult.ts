import type { AgentConfig, AgentReply } from "./types"

/** The text a consult should return for a target's reply, or undefined if this
 *  reply kind doesn't answer (so the consult keeps waiting). A card is serialized
 *  to its title + body, so an agent that answers with a card still settles the
 *  consult instead of letting it time out. */
export function consultAnswerFromReply(reply: AgentReply): string | undefined {
  if (reply.kind === "reply" && reply.text !== undefined) return reply.text
  if ((reply.kind === "card" || reply.kind === "update") && reply.card) return `${reply.card.title}\n\n${reply.card.body}`
  return undefined
}

/** May `requester` consult `targetName` (config `target`)? Allowed only when the
 *  target lists the requester (or `"*"`) in `access.consultableBy`. A self-consult
 *  is always denied (removes the trivial deadlock); an unknown target is denied. */
export function mayConsult(requester: string, targetName: string, target: AgentConfig | undefined): boolean {
  if (!target || requester === targetName) return false
  const list = target.access.consultableBy
  if (!list || list.length === 0) return false
  return list.includes("*") || list.includes(requester)
}

export interface PendingConsult {
  id: string
  channel: string                    // the virtual channel "consult:<id>"
  requester: string
  target: string
  createdAt: number
  expiresAt: number
  resolve: (answer: string) => void  // writes ask_agent_result back to the requester's socket
}

/** In-memory store of in-flight consults, keyed by their virtual channel id.
 *  The target agent's reply on that channel settles the consult; a deadline
 *  sweep resolves stragglers with a timeout note. Deterministic (injected
 *  `now`/`genId`). */
export class ConsultRegistry {
  private byChannel = new Map<string, PendingConsult>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  open(requester: string, target: string, resolve: (answer: string) => void): PendingConsult {
    const id = this.genId()
    const createdAt = this.now()
    const e: PendingConsult = {
      id, channel: `consult:${id}`, requester, target, createdAt, expiresAt: createdAt + this.ttlMs, resolve,
    }
    this.byChannel.set(e.channel, e)
    return e
  }

  isConsultChannel(channel: string): boolean {
    return this.byChannel.has(channel)
  }

  /** Settle a pending consult with the target's answer. Single-shot: a later
   *  reply on a freed channel returns null. Calls the stored resolve once. */
  settle(channel: string, answer: string): PendingConsult | null {
    const e = this.byChannel.get(channel)
    if (!e) return null
    this.byChannel.delete(channel)
    e.resolve(answer)
    return e
  }

  /** Past-deadline consults, removed from the map and returned so the caller can
   *  resolve each with a timeout note (and audit it). */
  sweepExpired(): PendingConsult[] {
    const t = this.now()
    const out: PendingConsult[] = []
    for (const [channel, e] of this.byChannel) {
      if (e.expiresAt <= t) { this.byChannel.delete(channel); out.push(e) }
    }
    return out
  }

  pendingCount(): number {
    return this.byChannel.size
  }
}
