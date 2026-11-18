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

/** Who an agent's current turn is for, and which agents THAT PERSON may use.
 *
 *  `mayConsult` answers "may agent A consult agent B". On its own that lets a person
 *  with no access to B reach B anyway, by asking A to consult it: the agent's
 *  permission is borrowed for a caller who was never granted it. This is the missing
 *  half: a consult made on a person's behalf also needs that person to be allowed the
 *  target.
 *
 *  Kept per agent, and looked up by the chat the consulting process is serving
 *  (`getLastChatId()` on its transport, exact per replica). Two people can have live
 *  turns with one agent at once (a queue, or pooled replicas in the same channel), and
 *  the hub cannot always tell which of them a given consult is for, so the check is
 *  deliberately conservative: EVERY person who could be behind it must be allowed the
 *  target. Entries age out, so a turn that never replied cannot pin a stale speaker to
 *  the agent forever. */
export interface TurnSpeaker {
  userId: string
  chatId: string
  /** Agent names this person may use where they spoke, as resolved at dispatch. */
  permitted: string[]
  at: number
}

export class TurnSpeakers {
  private byAgent = new Map<string, TurnSpeaker[]>()
  constructor(private now: () => number, private maxAgeMs = 15 * 60_000) {}

  begin(agent: string, speaker: Omit<TurnSpeaker, "at">): void {
    const list = this.live(agent)
    list.push({ ...speaker, at: this.now() })
    this.byAgent.set(agent, list)
  }

  /** The agent's reply for `chatId` has been delivered: that turn is over. */
  end(agent: string, chatId: string): void {
    const list = this.live(agent)
    const idx = list.findIndex(s => s.chatId === chatId)
    if (idx >= 0) list.splice(idx, 1)
    if (list.length) this.byAgent.set(agent, list); else this.byAgent.delete(agent)
  }

  /** Everyone who could be behind the agent's turn in `chatId`. With no chat known,
   *  everyone with a live turn on that agent. Empty when there is no person at all
   *  (a schedule, a workflow step, a consult of its own, or a turn that aged out). */
  behind(agent: string, chatId?: string): TurnSpeaker[] {
    const live = this.live(agent)
    return chatId ? live.filter(s => s.chatId === chatId) : live
  }

  private live(agent: string): TurnSpeaker[] {
    const cutoff = this.now() - this.maxAgeMs
    return (this.byAgent.get(agent) ?? []).filter(s => s.at > cutoff)
  }
}

/** May a consult of `targetName` go ahead for the people behind the requester's turn?
 *  Nobody behind it (system-initiated turn) ⇒ allowed; the agent-level `mayConsult`
 *  still applies. Otherwise every one of them must be allowed the target. Returns the
 *  first person who is not, or null when the consult may proceed. */
export function speakerBlocking(speakers: TurnSpeaker[], targetName: string): TurnSpeaker | null {
  return speakers.find(s => !s.permitted.includes(targetName)) ?? null
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
