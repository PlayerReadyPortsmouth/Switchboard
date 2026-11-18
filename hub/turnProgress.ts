/** Turn progress on the ROUTED (legacy) Discord path: a typing indicator for every
 *  turn, and for a request the router judges big, a holding reply the hub keeps up to
 *  date while the agent (and any colleagues it consults) work.
 *
 *  Why this exists: the typing indicator was wired only into the canonical
 *  single-agent path (`TurnCoordinator`). A channel that uses per-message routing is
 *  on the legacy path, so it showed nothing between a message and its answer, and a
 *  long multi-agent turn looked exactly like a dropped one.
 *
 *  The hub owns all of it. An agent is never asked to post a holding message, so a
 *  model that forgets to cannot leave a person staring at silence.
 *
 *  Shape:
 *   - `begin`  when a turn is dispatched. Starts typing; posts the holding reply if big.
 *   - `note`   when something worth reporting happens on that agent's turn
 *              (a colleague consulted, a colleague answered). Edits the holding reply.
 *   - `finish` when the agent's reply is about to be posted. Stops typing and removes
 *              the holding reply, so the channel ends with one message, not two.
 *   - `sweep`  on a timer. A turn that never finished is closed off honestly rather
 *              than left saying "working" forever.
 *
 *  Turns are tracked per agent as a FIFO: a persistent agent serialises its turns,
 *  so a note for agent X always belongs to X's OLDEST unfinished turn. */

export interface TurnProgressDeps {
  /** Post a plain message; resolve its id (undefined if it could not be posted). */
  post: (chatId: string, text: string) => Promise<string | undefined>
  /** Replace a previously posted message's text. Must not throw. */
  edit: (chatId: string, messageId: string, text: string) => Promise<void>
  /** Delete a previously posted message. Must not throw. */
  remove: (chatId: string, messageId: string) => Promise<void>
  /** Typing indicator for a chat. Absent ⇒ no typing (holding replies still work). */
  typing?: { start(chatId: string): void; stop(chatId: string): void }
  /** `**💷 Bill** · ` — the same tag the hub puts on a real reply. */
  tag: (agent: string) => string
  now?: () => number
  /** HH:MM for a progress line. Injected so tests are timezone-independent. */
  clock?: (ts: number) => string
}

export interface TurnProgressOptions {
  /** Post a holding reply for big turns. false ⇒ typing only. Default true. */
  holdingReply?: boolean
  /** Give up on an unfinished turn after this long. Default 15 minutes. */
  maxMs?: number
  /** Most progress lines kept on the holding reply (oldest dropped). Default 8. */
  maxLines?: number
}

interface Turn {
  chatId: string
  agent: string
  startedAt: number
  /** Resolves to the holding message id, or undefined when none was posted. */
  holding: Promise<string | undefined>
  lines: string[]
  /** Serialises edits so a slow edit can never overwrite a newer one. */
  chain: Promise<void>
  done: boolean
}

/** A real Discord location. Virtual channels ("consult:c3", mission channels) are not
 *  places a person is waiting, so they get neither typing nor a holding reply. */
export function isRealChat(chatId: string): boolean {
  return /^\d{5,}$/.test(chatId)
}

export const HOLDING_INTRO =
  "⏳ On it. This looks like a big one, so there may be a quiet spell while I work. " +
  "I'll keep this message updated."

export class TurnProgress {
  private readonly byAgent = new Map<string, Turn[]>()
  private readonly holdingReply: boolean
  private readonly maxMs: number
  private readonly maxLines: number
  private readonly now: () => number
  private readonly clock: (ts: number) => string

  constructor(private readonly deps: TurnProgressDeps, options: TurnProgressOptions = {}) {
    this.holdingReply = options.holdingReply ?? true
    this.maxMs = options.maxMs ?? 15 * 60_000
    this.maxLines = options.maxLines ?? 8
    this.now = deps.now ?? (() => Date.now())
    this.clock = deps.clock ?? ((ts) => new Date(ts).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    }))
  }

  /** A turn has been dispatched to `agent` for `chatId`. */
  begin(chatId: string, agent: string, opts: { big?: boolean } = {}): void {
    if (!isRealChat(chatId)) return
    try { this.deps.typing?.start(chatId) } catch {}
    const turn: Turn = {
      chatId, agent, startedAt: this.now(), lines: [], chain: Promise.resolve(), done: false,
      holding: Promise.resolve(undefined),
    }
    if (opts.big && this.holdingReply) {
      turn.holding = this.deps.post(chatId, this.render(turn)).catch(() => undefined)
    }
    const list = this.byAgent.get(agent) ?? []
    list.push(turn)
    this.byAgent.set(agent, list)
  }

  /** Something happened on `agent`'s current turn. No-op without a holding reply. */
  note(agent: string, text: string): void {
    const turn = this.byAgent.get(agent)?.[0]
    if (!turn || turn.done) return
    turn.lines.push(`• ${this.clock(this.now())} ${text}`)
    if (turn.lines.length > this.maxLines) turn.lines.splice(0, turn.lines.length - this.maxLines)
    this.queueEdit(turn)
  }

  /** `agent`'s reply for `chatId` is about to be posted. Stops typing and removes the
   *  holding reply. Resolves once the holding reply is gone, so the caller can post
   *  the real answer after it and the channel never shows both. */
  async finish(chatId: string, agent: string): Promise<void> {
    const list = this.byAgent.get(agent)
    const idx = list ? list.findIndex(t => t.chatId === chatId) : -1
    if (!list || idx < 0) {
      // Unknown turn (hub restarted mid-turn, or a reply with no dispatch): still make
      // sure nothing is left typing.
      if (isRealChat(chatId)) try { this.deps.typing?.stop(chatId) } catch {}
      return
    }
    const [turn] = list.splice(idx, 1)
    if (list.length === 0) this.byAgent.delete(agent)
    turn.done = true
    if (!this.chatStillActive(chatId)) try { this.deps.typing?.stop(chatId) } catch {}
    const id = await turn.holding
    if (!id) return
    await turn.chain.catch(() => {})
    await this.deps.remove(chatId, id).catch(() => {})
  }

  /** Close off turns that never finished. Returns how many were closed. */
  sweep(): number {
    const cutoff = this.now() - this.maxMs
    let closed = 0
    for (const [agent, list] of [...this.byAgent]) {
      const keep: Turn[] = []
      for (const turn of list) {
        if (turn.startedAt > cutoff) { keep.push(turn); continue }
        turn.done = true
        closed++
        const mins = Math.round(this.maxMs / 60_000)
        void turn.holding.then(async (id) => {
          if (!id) return
          await turn.chain.catch(() => {})
          await this.deps.edit(turn.chatId, id,
            `${this.deps.tag(turn.agent)}⚠️ No answer after ${mins} minutes, so I've stopped waiting. ` +
            "Something may have gone wrong. Please ask again.").catch(() => {})
        })
      }
      if (keep.length) this.byAgent.set(agent, keep); else this.byAgent.delete(agent)
      for (const turn of list) {
        if (turn.done && !this.chatStillActive(turn.chatId)) try { this.deps.typing?.stop(turn.chatId) } catch {}
      }
    }
    return closed
  }

  /** Unfinished turns, for the status board and tests. */
  activeCount(): number {
    let n = 0
    for (const list of this.byAgent.values()) n += list.length
    return n
  }

  private chatStillActive(chatId: string): boolean {
    for (const list of this.byAgent.values()) if (list.some(t => t.chatId === chatId && !t.done)) return true
    return false
  }

  private render(turn: Turn): string {
    const body = turn.lines.length ? `\n${turn.lines.join("\n")}` : ""
    return `${this.deps.tag(turn.agent)}${HOLDING_INTRO}${body}`
  }

  private queueEdit(turn: Turn): void {
    turn.chain = turn.chain.then(async () => {
      const id = await turn.holding
      if (!id || turn.done) return
      await this.deps.edit(turn.chatId, id, this.render(turn))
    }).catch(() => {})
  }
}

/** Fallback when no router decision is available (a pinned channel, or the router
 *  failed): treat a long message as big. Deliberately crude: a wrong "big" costs one
 *  short holding message, a wrong "small" costs nothing beyond today's behaviour. */
export function looksBig(message: string, bigChars = 700): boolean {
  return message.length >= bigChars
}
