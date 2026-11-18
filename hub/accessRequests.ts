/** Access requests: when a person is refused an agent, give them a button to ask for it
 *  and give that agent's owners a button to decide.
 *
 *  Three pieces, all hub-side. No agent takes part, so no agent can grant itself or its
 *  caller anything:
 *   - `AccessGrantStore`  grants a person an agent, optionally until a deadline, on disk.
 *   - customId helpers     `access:<action>:<agent>~<userId>` on the hub's own cards.
 *   - `AccessRequests`     the flow: offer → request → approve / deny, with every button
 *                          press authorised against the Discord id of whoever clicked.
 *
 *  A grant only ever ADDS a person to an agent's `access.users`; `access.channels` still
 *  narrows where that agent may be used, exactly as it does for a configured user. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname } from "path"
import type { CardSpec } from "./types"

export interface AccessGrant {
  userId: string
  agent: string
  grantedBy: string
  grantedAt: number
  /** null ⇒ no expiry. */
  expiresAt: number | null
}

export class AccessGrantStore {
  private grants: AccessGrant[] = []
  constructor(private readonly path: string, private readonly now: () => number = () => Date.now()) {
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8"))
        if (Array.isArray(raw)) this.grants = raw.filter(isGrant)
      }
    } catch { this.grants = [] }   // an unreadable file grants nothing: fail closed
  }

  /** Grant (or replace) a person's access to an agent. */
  grant(g: Omit<AccessGrant, "grantedAt">): AccessGrant {
    const grant: AccessGrant = { ...g, grantedAt: this.now() }
    this.grants = this.grants.filter(x => !(x.userId === g.userId && x.agent === g.agent))
    this.grants.push(grant)
    this.save()
    return grant
  }

  revoke(userId: string, agent: string): boolean {
    const before = this.grants.length
    this.grants = this.grants.filter(x => !(x.userId === userId && x.agent === agent))
    if (this.grants.length === before) return false
    this.save()
    return true
  }

  /** Agents this person currently holds a live grant for. */
  agentsFor(userId: string): string[] {
    const t = this.now()
    return this.grants
      .filter(g => g.userId === userId && (g.expiresAt === null || g.expiresAt > t))
      .map(g => g.agent)
  }

  /** Live grants, for an operator listing. Expired ones are dropped from disk here. */
  list(): AccessGrant[] {
    const t = this.now()
    const live = this.grants.filter(g => g.expiresAt === null || g.expiresAt > t)
    if (live.length !== this.grants.length) { this.grants = live; this.save() }
    return [...live]
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(this.grants, null, 2) + "\n", { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (e) { process.stderr.write(`access grants: save failed: ${e}\n`) }
  }
}

function isGrant(x: any): x is AccessGrant {
  return x && typeof x.userId === "string" && typeof x.agent === "string"
    && typeof x.grantedBy === "string" && typeof x.grantedAt === "number"
    && (x.expiresAt === null || typeof x.expiresAt === "number")
}

// ---- customIds -------------------------------------------------------------

export type AccessAction = "request" | "approve" | "approveperm" | "deny"
const ACTIONS: AccessAction[] = ["request", "approve", "approveperm", "deny"]

/** `access:<action>:<agent>~<userId>`. The agent name may itself contain "~"-free text
 *  only; the user id is always the part after the LAST "~". */
export function accessCustomId(action: AccessAction, agent: string, userId: string): string {
  return `access:${action}:${agent}~${userId}`
}

export function parseAccessCustomId(id: string): { action: AccessAction; agent: string; userId: string } | null {
  const m = /^access:([a-z]+):(.+)~(\d{5,})$/.exec(id)
  if (!m || !ACTIONS.includes(m[1] as AccessAction)) return null
  return { action: m[1] as AccessAction, agent: m[2]!, userId: m[3]! }
}

// ---- the flow --------------------------------------------------------------

export interface AccessRequestsDeps {
  /** Post a card; resolve its message id. */
  sendCard: (chatId: string, card: CardSpec) => Promise<string | undefined>
  editCard: (chatId: string, messageId: string, card: CardSpec) => Promise<void>
  /** Post plain text. Used for the line that pings people: an embed never notifies. */
  sendPlain: (chatId: string, text: string) => Promise<void>
  /** Who may decide a request for this agent. Empty ⇒ nobody can, and the offer says so. */
  ownersOf: (agent: string) => string[]
  agentExists: (agent: string) => boolean
  agentEmoji: (agent: string) => string
  grants: AccessGrantStore
  audit: (e: { action: string; outcome: "ok" | "deny"; actor: string; agent: string; userId: string; detail?: Record<string, unknown> }) => void
  now?: () => number
}

export interface AccessRequestsOptions {
  /** Where approval cards go. Absent ⇒ the chat the request was made in. */
  approvalChannelId?: string
  /** Length of a time-limited grant. Default 24 hours. */
  grantHours?: number
  /** Do not offer the same person the same agent again within this window. Default 10 min. */
  offerCooldownMs?: number
}

interface Pending { chatId: string; offerMessageId?: string; approvalChatId?: string; approvalMessageId?: string; state: "offered" | "requested" | "decided" }

/** A reason string means "this click did nothing": the gateway restores the buttons and
 *  tells the clicker why. `undefined` means handled. */
export type ClickResult = string | undefined

export class AccessRequests {
  private readonly pending = new Map<string, Pending>()
  private readonly lastOffer = new Map<string, number>()
  private readonly grantHours: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(private readonly deps: AccessRequestsDeps, private readonly options: AccessRequestsOptions = {}) {
    this.grantHours = options.grantHours ?? 24
    this.cooldownMs = options.offerCooldownMs ?? 10 * 60_000
    this.now = deps.now ?? (() => Date.now())
  }

  private key(agent: string, userId: string): string { return `${agent}~${userId}` }

  /** A person was refused `agent` in `chatId`: offer them a way to ask for it. */
  async offer(chatId: string, userId: string, agent: string): Promise<void> {
    if (!this.deps.agentExists(agent)) return
    const k = this.key(agent, userId)
    const last = this.lastOffer.get(k)
    if (last !== undefined && this.now() - last < this.cooldownMs) return
    this.lastOffer.set(k, this.now())
    const owners = this.deps.ownersOf(agent)
    const name = `${this.deps.agentEmoji(agent)} ${agent}`.trim()
    const card: CardSpec = owners.length
      ? {
          title: `🔒 Access needed: ${name}`,
          body: `<@${userId}>, you don't have access to **${agent}**. You can ask for it, and one of ${agent}'s owners will decide.`,
          buttons: [{ customId: accessCustomId("request", agent, userId), label: `Request access to ${agent}`, style: "primary", emoji: "🙋" }],
        }
      : {
          title: `🔒 Access needed: ${name}`,
          body: `<@${userId}>, you don't have access to **${agent}**, and nobody is set up to approve requests for it yet. Ask an operator.`,
          buttons: [],
        }
    const id = await this.deps.sendCard(chatId, card).catch(() => undefined)
    this.pending.set(k, { chatId, offerMessageId: id, state: "offered" })
  }

  /** A button on one of this module's cards was clicked.
   *
   *  Synchronous on purpose: the gateway needs the verdict straight away (a reason puts
   *  the buttons back and tells the clicker), so every authorisation and state check
   *  happens here, before anything is posted. The posting and editing that follows runs
   *  in the background; `idle()` resolves when it has finished. */
  click(customId: string, clickerId: string): ClickResult {
    const p = parseAccessCustomId(customId)
    if (!p) return "That button is not an access request."
    if (!this.deps.agentExists(p.agent)) return `The agent "${p.agent}" no longer exists.`
    return p.action === "request" ? this.onRequest(p.agent, p.userId, clickerId) : this.onDecision(p.action, p.agent, p.userId, clickerId)
  }

  /** Resolves once all background card work started so far has finished. */
  idle(): Promise<void> { return this.work }

  private work: Promise<void> = Promise.resolve()
  private background(fn: () => Promise<void>): void {
    this.work = this.work.then(fn).catch((e) => { process.stderr.write(`access requests: ${e}\n`) })
  }

  private onRequest(agent: string, userId: string, clickerId: string): ClickResult {
    // Only the person who was refused may ask on their own behalf.
    if (clickerId !== userId) return "Only the person this card is for can press that."
    const k = this.key(agent, userId)
    const pend = this.pending.get(k)
    if (!pend) return "This request has expired (the hub restarted). Ask again to get a fresh card."
    if (pend.state !== "offered") return "This has already been requested."
    const owners = this.deps.ownersOf(agent)
    if (!owners.length) return `Nobody is set up to approve requests for ${agent}.`
    pend.state = "requested"
    const dest = this.options.approvalChannelId ?? pend.chatId
    const name = `${this.deps.agentEmoji(agent)} ${agent}`.trim()
    const approval: CardSpec = {
      title: `🙋 Access request: ${name}`,
      body: `<@${userId}> is asking for access to **${agent}**.`,
      fields: [{ name: "Who can decide", value: owners.map(o => `<@${o}>`).join(" "), inline: false }],
      buttons: [
        { customId: accessCustomId("approve", agent, userId), label: `Approve ${this.grantHours}h`, style: "success", emoji: "✅" },
        { customId: accessCustomId("approveperm", agent, userId), label: "Approve permanently", style: "secondary" },
        { customId: accessCustomId("deny", agent, userId), label: "Deny", style: "danger" },
      ],
    }
    this.deps.audit({ action: "access_request", outcome: "ok", actor: `user:${userId}`, agent, userId })
    this.background(async () => {
      // The embed cannot notify anyone, so the ping rides in a plain line above it.
      await this.deps.sendPlain(dest, `${owners.map(o => `<@${o}>`).join(" ")} access request for **${agent}**, decision needed below.`).catch(() => {})
      const approvalId = await this.deps.sendCard(dest, approval).catch(() => undefined)
      if (!approvalId) {
        // Could not reach the owners: put the request back so the person can try again.
        pend.state = "offered"
        if (pend.offerMessageId) await this.deps.editCard(pend.chatId, pend.offerMessageId, {
          title: `🔒 Access needed: ${name}`,
          body: `<@${userId}>, I couldn't post your request to ${agent}'s owners. Try again in a moment.`,
          buttons: [{ customId: accessCustomId("request", agent, userId), label: `Request access to ${agent}`, style: "primary", emoji: "🙋" }],
        }).catch(() => {})
        return
      }
      pend.approvalChatId = dest; pend.approvalMessageId = approvalId
      if (pend.offerMessageId) {
        await this.deps.editCard(pend.chatId, pend.offerMessageId, {
          title: `🔒 Access requested: ${name}`,
          body: `<@${userId}>, your request has gone to ${agent}'s owners. You'll be told here when they decide.`,
          buttons: [],
        }).catch(() => {})
      }
    })
    return undefined
  }

  private onDecision(action: Exclude<AccessAction, "request">, agent: string, userId: string, clickerId: string): ClickResult {
    // The whole point: the decision belongs to the agent's owners and nobody else. Checked
    // against whoever actually pressed the button, never against anything on the card.
    if (!this.deps.ownersOf(agent).includes(clickerId)) {
      this.deps.audit({ action: "access_decision", outcome: "deny", actor: `user:${clickerId}`, agent, userId, detail: { reason: "not_an_owner", wanted: action } })
      return `Only ${agent}'s owners can decide this.`
    }
    if (clickerId === userId) return "You can't approve your own request."
    const k = this.key(agent, userId)
    const pend = this.pending.get(k)
    if (!pend || pend.state !== "requested") return "This request is no longer open."
    pend.state = "decided"
    const name = `${this.deps.agentEmoji(agent)} ${agent}`.trim()
    let verdict: string, notice: string
    if (action === "deny") {
      verdict = `❌ Denied by <@${clickerId}>.`
      notice = `<@${userId}>, your request for access to **${agent}** was denied by <@${clickerId}>.`
      this.deps.audit({ action: "access_decision", outcome: "deny", actor: `user:${clickerId}`, agent, userId, detail: { decision: "deny" } })
    } else {
      const expiresAt = action === "approveperm" ? null : this.now() + this.grantHours * 3_600_000
      this.deps.grants.grant({ userId, agent, grantedBy: clickerId, expiresAt })
      const until = expiresAt === null ? "with no end date" : `for ${this.grantHours} hours`
      verdict = `✅ Approved by <@${clickerId}> ${until}.`
      notice = `<@${userId}>, you now have access to **${agent}** ${until}, approved by <@${clickerId}>.`
      this.deps.audit({ action: "access_decision", outcome: "ok", actor: `user:${clickerId}`, agent, userId, detail: { decision: action, expiresAt } })
    }
    this.pending.delete(k)
    this.lastOffer.delete(k)
    this.background(async () => {
      if (pend.approvalChatId && pend.approvalMessageId) {
        await this.deps.editCard(pend.approvalChatId, pend.approvalMessageId, {
          title: `🙋 Access request: ${name}`,
          body: `<@${userId}> asked for access to **${agent}**.\n\n${verdict}`,
          buttons: [],
        }).catch(() => {})
      }
      await this.deps.sendPlain(pend.chatId, notice).catch(() => {})
    })
    return undefined
  }
}
