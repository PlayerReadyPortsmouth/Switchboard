/** Speaker-scoped actions: an agent PROPOSES a change to the speaker's own records; the
 *  person confirms it on a card; only then does the hub make the change, as them.
 *
 *  The write-side twin of speakerData.ts, with the same two rules and one more:
 *   1. The agent holds no credential. The hub calls the upstream with its own key.
 *   2. The agent cannot choose whose records are touched. The identity sent upstream is
 *      the person whose Discord message started the turn, never an argument.
 *   3. Nothing is written because a model decided it should be. Every change waits for
 *      that same person to press Confirm on a card that shows exactly what will happen.
 *
 *  A proposal that is not confirmed in time simply lapses. A proposal made with nobody,
 *  or more than one person, behind the turn is refused outright. */
import type { CardSpec } from "./types"
import { soleSpeaker } from "./speakerData"

export interface SpeakerAction {
  /** Path on the speakerData baseUrl, POSTed to on confirm. */
  path: string
  /** What the agent and the person are told this does, e.g. "Add a note to one of your tickets". */
  description: string
  /** The parameters it takes: name → what it is. Anything else the agent sends is dropped. */
  params: Record<string, string>
  /** Parameters that must be present and non-empty. */
  required?: string[]
}

export const ACTION_PREFIX = "act:"
export type ActionVerb = "confirm" | "cancel"

export function actionCustomId(verb: ActionVerb, id: string): string { return `${ACTION_PREFIX}${verb}:${id}` }
export function parseActionCustomId(customId: string): { verb: ActionVerb; id: string } | null {
  const m = /^act:(confirm|cancel):([a-z0-9]+)$/.exec(customId)
  return m ? { verb: m[1] as ActionVerb, id: m[2]! } : null
}

interface Pending {
  id: string; userId: string; agent: string; chatId: string
  action: string; params: Record<string, string>
  at: number; state: "open" | "running" | "done"
  messageId?: string
}

export interface SpeakerActionsDeps {
  sendCard: (chatId: string, card: CardSpec) => Promise<string | undefined>
  editCard: (chatId: string, messageId: string, card: CardSpec) => Promise<void>
  post: (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  secret: (envName: string) => string | undefined
  audit?: (e: { action: string; agent: string; userId?: string; outcome: "ok" | "deny" | "error" | "pending"; detail?: Record<string, unknown> }) => void
  agentEmoji?: (agent: string) => string
  now?: () => number
  genId?: () => string
}

export interface SpeakerActionsConfig {
  baseUrl: string
  secretEnv: string
  actions: Record<string, SpeakerAction>
  timeoutMs?: number
  /** How long a proposal waits for Confirm. Default 15 minutes. */
  confirmTtlMs?: number
}

/** The actions an agent is allowed, as the shim needs them. */
export function actionsFor(
  actions: Record<string, SpeakerAction> | undefined, allowed: string[] | undefined,
): { name: string; description: string; params: Record<string, string>; required: string[] }[] {
  if (!actions || !allowed?.length) return []
  return allowed.filter(n => actions[n]).map(n => ({
    name: n, description: actions[n]!.description, params: actions[n]!.params, required: actions[n]!.required ?? [],
  }))
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export class SpeakerActions {
  private readonly pending = new Map<string, Pending>()
  private readonly now: () => number
  private readonly genId: () => string
  private readonly ttl: number
  private seq = 0
  private work: Promise<void> = Promise.resolve()

  constructor(private readonly cfg: SpeakerActionsConfig, private readonly deps: SpeakerActionsDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.genId = deps.genId ?? (() => Math.random().toString(36).slice(2, 10))
    this.ttl = cfg.confirmTtlMs ?? 15 * 60_000
  }

  /** Resolves once all background card and upstream work started so far has finished. */
  idle(): Promise<void> { return this.work }
  private background(fn: () => Promise<void>): void {
    this.work = this.work.then(fn).catch((e) => { process.stderr.write(`speaker actions: ${e}\n`) })
  }

  private audit(e: Parameters<NonNullable<SpeakerActionsDeps["audit"]>>[0]): void {
    try { this.deps.audit?.(e) } catch {}
  }

  /** What the ledger may hold about a proposal: which action, which parameters were
   *  given, and record references. Never free text such as a note's body. */
  private safeDetail(p: { action: string; params: Record<string, string> }): Record<string, unknown> {
    const refs: Record<string, string> = {}
    for (const [k, v] of Object.entries(p.params)) if (/(^|_)(id|ref)$/i.test(k)) refs[k] = clip(v, 40)
    return { action: p.action, params: Object.keys(p.params), ...(Object.keys(refs).length ? { refs } : {}) }
  }

  private card(p: Pending, state: "ask" | "running" | "done" | "failed" | "cancelled" | "expired", note?: string): CardSpec {
    const def = this.cfg.actions[p.action]!
    const emoji = this.deps.agentEmoji?.(p.agent) ?? ""
    const fields = Object.entries(p.params).map(([k, v]) => ({ name: def.params[k] ?? k, value: clip(v, 1000) || "(empty)", inline: false }))
    const head: Record<typeof state, string> = {
      ask: `<@${p.userId}>, ${emoji} ${p.agent} wants to do this for you. **Nothing has changed yet.**`,
      running: `Confirmed by <@${p.userId}>. Doing it now…`,
      done: `✅ Done, confirmed by <@${p.userId}>.`,
      failed: `❌ Not done. ${note ?? "The records service refused it."} Nothing was changed.`,
      cancelled: `Cancelled by <@${p.userId}>. Nothing was changed.`,
      expired: "This was not confirmed in time. Nothing was changed.",
    }
    return {
      title: `${state === "ask" ? "Confirm" : state === "done" ? "Done" : "Change"}: ${def.description}`,
      body: head[state] + (state === "done" && note ? `\n${clip(note, 500)}` : ""),
      fields,
      buttons: state === "ask" ? [
        { customId: actionCustomId("confirm", p.id), label: "Confirm", style: "success", emoji: "✅" },
        { customId: actionCustomId("cancel", p.id), label: "Cancel", style: "secondary" },
      ] : [],
    }
  }

  /** The agent proposes an action. Always resolves to text for the agent; never throws. */
  async propose(req: {
    agent: string; allowed: string[]; action: string; params: unknown
    chatId: string | undefined; people: { userId: string }[]
  }): Promise<string> {
    const def = this.cfg.actions[req.action]
    if (!def || !req.allowed.includes(req.action)) {
      this.audit({ action: req.action, agent: req.agent, outcome: "deny", detail: { reason: "unknown_action" } })
      const names = req.allowed.filter(n => this.cfg.actions[n])
      return `(refused: "${req.action}" is not an action you have. Available: ${names.join(", ") || "none"}.)`
    }
    const who = soleSpeaker(req.people)
    if (!who.ok || !req.chatId) {
      this.audit({ action: req.action, agent: req.agent, outcome: "deny", detail: { reason: "no_sole_speaker" } })
      return who.ok
        ? "(refused: there is nowhere to show the person a confirmation, so nothing can be changed.)"
        : who.reason.replace("fetch records for", "change records for").replace("fetch anyone's records", "change anyone's records")
    }
    // Keep only declared parameters, as strings; drop everything else the model sent.
    const raw = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>
    const params: Record<string, string> = {}
    for (const k of Object.keys(def.params)) {
      const v = raw[k]
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") params[k] = String(v).slice(0, 4000)
    }
    const missing = (def.required ?? []).filter(k => !params[k]?.trim())
    if (missing.length) return `(refused: missing ${missing.join(", ")}. Ask the person for it, then propose again.)`

    this.sweep()
    const p: Pending = {
      id: `${this.genId()}${++this.seq}`, userId: who.userId, agent: req.agent, chatId: req.chatId,
      action: req.action, params, at: this.now(), state: "open",
    }
    const messageId = await this.deps.sendCard(req.chatId, this.card(p, "ask")).catch(() => undefined)
    if (!messageId) {
      this.audit({ action: req.action, agent: req.agent, userId: who.userId, outcome: "error", detail: { reason: "card_failed" } })
      return "(unavailable: the confirmation card could not be shown, so nothing was proposed or changed. Say so.)"
    }
    p.messageId = messageId
    this.pending.set(p.id, p)
    this.audit({ action: req.action, agent: req.agent, userId: who.userId, outcome: "pending", detail: this.safeDetail(p) })
    return "(proposed: a confirmation card is now in front of the person. NOTHING HAS CHANGED YET. Tell them to check it and press Confirm if it is right. Do not say it is done, and do not propose it again.)"
  }

  /** May this person press this button at all? Only the person the proposal is for. */
  ownedBy(customId: string, userId: string): boolean {
    const c = parseActionCustomId(customId)
    return !!c && this.pending.get(c.id)?.userId === userId
  }

  /** A Confirm or Cancel press. A reason string ⇒ nothing happened (buttons are restored). */
  click(customId: string, clickerId: string): string | undefined {
    const c = parseActionCustomId(customId)
    if (!c) return "That is not an action button."
    const p = this.pending.get(c.id)
    if (!p) return "This is no longer waiting (it expired, or the hub restarted). Ask again."
    if (p.userId !== clickerId) return "Only the person this change is for can confirm or cancel it."
    if (p.state !== "open") return "This has already been dealt with."
    if (this.now() - p.at > this.ttl) {
      this.pending.delete(p.id)
      this.background(async () => { if (p.messageId) await this.deps.editCard(p.chatId, p.messageId, this.card(p, "expired")) })
      return "This was not confirmed in time, so it has lapsed. Ask again."
    }
    if (c.verb === "cancel") {
      this.pending.delete(p.id)
      this.audit({ action: p.action, agent: p.agent, userId: p.userId, outcome: "deny", detail: { ...this.safeDetail(p), decision: "cancelled" } })
      this.background(async () => { if (p.messageId) await this.deps.editCard(p.chatId, p.messageId, this.card(p, "cancelled")) })
      return undefined
    }
    p.state = "running"
    this.background(() => this.run(p))
    return undefined
  }

  private async run(p: Pending): Promise<void> {
    const show = async (state: Parameters<SpeakerActions["card"]>[1], note?: string) => {
      if (p.messageId) await this.deps.editCard(p.chatId, p.messageId, this.card(p, state, note)).catch(() => {})
    }
    await show("running")
    const def = this.cfg.actions[p.action]!
    const secret = this.deps.secret(this.cfg.secretEnv)
    const finish = async (ok: boolean, note: string, detail: Record<string, unknown>) => {
      p.state = "done"
      this.pending.delete(p.id)
      this.audit({ action: p.action, agent: p.agent, userId: p.userId, outcome: ok ? "ok" : "error", detail: { ...this.safeDetail(p), decision: "confirmed", ...detail } })
      await show(ok ? "done" : "failed", note)
    }
    if (!secret) return finish(false, "The hub has no key for the records service.", { reason: "no_secret" })
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 20_000)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const res = await this.deps.post(this.cfg.baseUrl.replace(/\/+$/, "") + def.path, {
        headers: {
          authorization: `Bearer ${secret}`, "content-type": "application/json",
          "x-speaker-discord-id": p.userId, "idempotency-key": p.id,
        },
        // The identity is set here, by the hub. `params` is everything the model contributed.
        body: JSON.stringify({ discord_id: p.userId, params: p.params }),
        signal: ctl.signal,
      })
      const body = await res.text()
      let message = ""
      try { const j = JSON.parse(body); if (typeof j?.message === "string") message = j.message; else if (typeof j?.error === "string") message = j.error } catch {}
      if (!res.ok) return finish(false, message ? `The records service said: ${clip(message, 200)}` : `The records service answered ${res.status}.`, { status: res.status })
      return finish(true, message, { status: res.status })
    } catch (e) {
      return finish(false, "The records service did not answer in time. Check the record before trying again: it may or may not have changed.", { error: String(e).slice(0, 120) })
    } finally {
      clearTimeout(timer)
    }
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttl
    for (const [id, p] of this.pending) {
      if (p.state === "open" && p.at < cutoff) {
        this.pending.delete(id)
        this.background(async () => { if (p.messageId) await this.deps.editCard(p.chatId, p.messageId, this.card(p, "expired")) })
      }
    }
  }
}
