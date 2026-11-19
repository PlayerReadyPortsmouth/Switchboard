/** The Assistant acting in ReadyApp for the person who is speaking, through ReadyApp's
 *  hub gateway (hubGateway.ts). ReadyApp owns every rule: what each person may read and
 *  do, the shape of each action, the preview, the permission check and the write.
 *
 *  This module is the hub's half:
 *   - decide WHO the turn is for (exactly one person, or refuse);
 *   - show ReadyApp's own preview on a card, adding nothing to it;
 *   - let only that person Confirm or Cancel, once;
 *   - keep the Discord card in step with the card in ReadyApp.
 *
 *  Nothing is written because a model decided it should be. */
import type { CardSpec } from "./types"
import { soleSpeaker } from "./speakerData"
import { GatewayError, renderCatalog, type Catalog, type HubGatewayClient, type Proposal } from "./hubGateway"

export interface ReadyAppGatewayConfig {
  enabled?: boolean
  baseUrl: string
  prefix?: string
  /** This hub's registered client id, e.g. "hub:skippy-4". */
  clientId: string
  /** Env var holding this hub's signing secret. */
  secretEnv: string
  /** Where an unlinked person is sent to link their Discord account. */
  linkUrl?: string
  timeoutMs?: number
  /** Read names offered to agents (ReadyApp still decides per person). */
  reads?: string[]
  /** How long a person's catalog is reused. Default 3 minutes. */
  catalogTtlMs?: number
  /** How often open cards are checked against ReadyApp. Default 20 s. 0 = never. */
  pollMs?: number
}

/** What ONE agent may use of a person's ReadyApp catalog. Names are exact, or end in ".*"
 *  for a family ("deal.*"), or "*" for all. A missing list means none of that kind.
 *  `users` adds extra names for one person ON THIS AGENT ONLY, keyed by Discord user id.
 *  This is a hub-side narrowing: ReadyApp's own per-person switches and permissions still
 *  decide, so a name listed here that ReadyApp does not give the person does nothing. */
export interface AgentScope {
  reads?: string[]
  actions?: string[]
  users?: Record<string, { reads?: string[]; actions?: string[] }>
}

/** `true` (legacy: everything) ⇒ undefined; an object ⇒ that scope; anything else ⇒ nothing. */
export function agentScope(v: boolean | AgentScope | undefined): AgentScope | undefined | null {
  if (v === true) return undefined
  if (v && typeof v === "object") return v
  return null
}

function matches(list: string[] | undefined, name: string): boolean {
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== "string") continue
    if (p === "*" || p === name) return true
    if (p.endsWith(".*") && name.startsWith(p.slice(0, -1))) return true
  }
  return false
}

/** May this agent use this read/action for this person? No scope ⇒ yes (ReadyApp decides). */
export function scopeAllows(scope: AgentScope | undefined, kind: "reads" | "actions", name: string, userId?: string): boolean {
  if (!scope) return true
  return matches(scope[kind], name) || (!!userId && matches(scope.users?.[userId]?.[kind], name))
}

/** A person's catalog as one agent sees it. */
export function scopeCatalog(cat: Catalog, scope: AgentScope | undefined, userId?: string): Catalog {
  if (!scope) return cat
  return { ...cat, reads: cat.reads.filter(r => scopeAllows(scope, "reads", r.name, userId)), actions: cat.actions.filter(a => scopeAllows(scope, "actions", a.kind, userId)) }
}

export const GW_ACTION_PREFIX = "gwa:"
export type GwVerb = "confirm" | "cancel"
export function gwCustomId(verb: GwVerb, id: string): string { return `${GW_ACTION_PREFIX}${verb}:${id}` }
export function parseGwCustomId(customId: string): { verb: GwVerb; id: string } | null {
  const m = /^gwa:(confirm|cancel):([a-z0-9]+)$/.exec(customId)
  return m ? { verb: m[1] as GwVerb, id: m[2]! } : null
}

type CardState = "ask" | "running" | "done" | "failed" | "cancelled" | "expired" | "elsewhere"

interface Pending {
  id: string; cardId: string; userId: string; agent: string
  /** Where the card is shown (the person's DM when they asked in a shared channel). */
  cardChatId: string; messageId: string
  kind: string; target?: { type: string; id: string }
  proposal: Proposal
  at: number; expiresAt: number
  state: "open" | "running"
}

export interface GatewayActionsDeps {
  client: Pick<HubGatewayClient, "catalog" | "read" | "propose" | "confirm" | "cancel" | "status">
  sendCard: (chatId: string, card: CardSpec) => Promise<string | undefined>
  /** Send a card to a person by DM. Null when it could not be delivered. */
  sendCardDM: (userId: string, card: CardSpec) => Promise<{ chatId: string; messageId: string } | null>
  editCard: (chatId: string, messageId: string, card: CardSpec) => Promise<void>
  /** A one-line pointer in the channel where the person asked. */
  notify?: (chatId: string, text: string) => Promise<void>
  audit?: (e: { action: string; target: string; agent: string; userId?: string; outcome: "ok" | "deny" | "error" | "pending"; detail?: Record<string, unknown> }) => void
  agentEmoji?: (agent: string) => string
  now?: () => number
  genId?: () => string
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v))
/** A field name as a person would write it: "dueAt" → "Due at". Presentation only. */
export function label(raw: string): string {
  const s = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]+/g, " ").trim()
  return s && s === s.toLowerCase() || /[a-z][A-Z]/.test(raw) ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s
}
const link = (url: string): string => `[Open in ReadyApp](${url})`

/** Tokens ReadyApp spent writing a summary for a read. Counts only, no price: ReadyApp
 *  reports none, so the hub shows them beside its own costs and does not invent one. */
export interface RaUsage { model?: string; tokensIn: number; tokensOut: number }

/** The `usage` block of a read, when ReadyApp generated a summary for it just now. A
 *  cached summary cost nothing this time and is not counted. */
export function raUsage(data: unknown): RaUsage | undefined {
  const d = data as { usage?: Record<string, unknown>; summaryCached?: unknown } | null
  const u = d?.usage
  if (!u || typeof u !== "object" || d?.summaryCached === true) return undefined
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  const tokensIn = n(u.inputTokens) + n(u.cacheReadInputTokens) + n(u.cacheCreationInputTokens)
  const tokensOut = n(u.outputTokens)
  if (!tokensIn && !tokensOut) return undefined
  return { ...(typeof u.model === "string" ? { model: u.model.slice(0, 64) } : {}), tokensIn, tokensOut }
}

export class GatewayActions {
  private readonly pending = new Map<string, Pending>()
  private readonly catalogs = new Map<string, { at: number; cat: Catalog }>()
  private readonly now: () => number
  private readonly genId: () => string
  private seq = 0
  private work: Promise<void> = Promise.resolve()

  constructor(private readonly cfg: ReadyAppGatewayConfig, private readonly deps: GatewayActionsDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.genId = deps.genId ?? (() => Math.random().toString(36).slice(2, 10))
  }

  idle(): Promise<void> { return this.work }
  private background(fn: () => Promise<void>): void {
    this.work = this.work.then(fn).catch((e) => { process.stderr.write(`gateway actions: ${e}\n`) })
  }
  private audit(e: Parameters<NonNullable<GatewayActionsDeps["audit"]>>[0]): void {
    try { this.deps.audit?.(e) } catch {}
  }

  /** This person's catalog, reused for a few minutes. */
  async catalog(userId: string, fresh = false): Promise<Catalog> {
    const hit = this.catalogs.get(userId)
    if (!fresh && hit && this.now() - hit.at < (this.cfg.catalogTtlMs ?? 180_000)) return hit.cat
    const cat = await this.deps.client.catalog(userId)
    this.catalogs.set(userId, { at: this.now(), cat })
    return cat
  }

  /** A read for the person behind the turn. Always resolves to text for the agent.
   *  `onFetched` is told when records actually came back, so the reply can go privately. */
  async read(req: { agent: string; tool: string; query?: string; recordId?: string; params?: Record<string, unknown>; people: { userId: string }[]; scope?: AgentScope; onFetched?: (userId: string, usage?: RaUsage) => void }): Promise<string> {
    const who = soleSpeaker(req.people)
    if (!who.ok) {
      this.audit({ action: "read", target: req.tool, agent: req.agent, outcome: "deny", detail: { reason: "no_sole_speaker" } })
      return who.reason
    }
    try {
      if (req.tool === "catalog") {
        const cat = scopeCatalog(await this.catalog(who.userId, true), req.scope, who.userId)
        this.audit({ action: "catalog", target: "catalog", agent: req.agent, userId: who.userId, outcome: "ok", detail: { reads: cat.reads.length, actions: cat.actions.length, ...(req.scope ? { scoped: true } : {}) } })
        return `What this person can read and do in ReadyApp through you, right now:\n${renderCatalog(cat)}`
      }
      // This agent's own list comes first: a tool outside it is never sent to ReadyApp.
      if (!scopeAllows(req.scope, "reads", req.tool, who.userId)) {
        this.audit({ action: "read", target: req.tool, agent: req.agent, userId: who.userId, outcome: "deny", detail: { reason: "not_in_agent_scope" } })
        return `(not fetched: "${req.tool}" is not one of your tools. Call the catalog to see what you can read for this person, or point them to the colleague who covers it. Do not guess at their records.)`
      }
      const data = await this.deps.client.read(who.userId, req.tool, req.query, undefined, { id: req.recordId, params: req.params })
      const count = Array.isArray((data as { items?: unknown[] })?.items) ? (data as { items: unknown[] }).items.length : undefined
      const usage = raUsage(data)
      this.audit({ action: "read", target: req.tool, agent: req.agent, userId: who.userId, outcome: "ok", detail: { ...(count === undefined ? {} : { count }), ...(req.recordId ? { record: req.recordId.slice(0, 64) } : {}), ...(usage ? { raModel: usage.model, raTokensIn: usage.tokensIn, raTokensOut: usage.tokensOut } : {}) } })
      try { req.onFetched?.(who.userId, usage) } catch {}
      return clip(JSON.stringify(data), 20_000)
    } catch (e) {
      const g = e instanceof GatewayError ? e : new GatewayError("error", 0, "ReadyApp could not be reached.")
      if (g.code === "catalog_stale") this.catalogs.delete(who.userId)
      this.audit({ action: "read", target: req.tool, agent: req.agent, userId: who.userId, outcome: g.status === 403 || g.status === 404 ? "deny" : "error", detail: { code: g.code, status: g.status } })
      return `(not fetched: ${g.message} Tell the person exactly that and do not guess at their records.${req.recordId && (g.code === "missing_token" || g.code === "read_disabled") ? " The detail view of a single record is not available yet; you can still list or search, and give them the record's link." : ""})`
    }
  }

  /** ReadyApp's proposal as a card. Title, preview, changes and warnings are shown as
   *  returned; the hub adds only who it is for and what state it is in. */
  private card(p: Pick<Pending, "id" | "userId" | "agent" | "proposal">, state: CardState, note?: string): CardSpec {
    const pr = p.proposal
    const emoji = this.deps.agentEmoji?.(p.agent) ?? ""
    const head: Record<CardState, string> = {
      ask: `<@${p.userId}>, ${emoji} ${p.agent} wants to do this for you in ReadyApp. **Nothing has changed yet.**`,
      running: `Confirmed by <@${p.userId}>. Doing it now…`,
      done: `✅ Done, confirmed by <@${p.userId}>.`,
      failed: `❌ Not done. ${note ?? "ReadyApp refused it."}`,
      cancelled: `Cancelled by <@${p.userId}>. Nothing was changed.`,
      expired: "This was not confirmed in time. Nothing was changed.",
      elsewhere: note ?? "This was dealt with in ReadyApp.",
    }
    const fields: { name: string; value: string; inline: boolean }[] = []
    // Shown as ReadyApp sent them, tidied only for reading: "Target: You" says nothing, and
    // a new value already in the preview is not repeated as "(empty) → value".
    const shown = new Map<string, string>()
    for (const f of Array.isArray(pr.preview) ? pr.preview : []) {
      if (str(f.label).toLowerCase() === "target" && str(f.value).toLowerCase() === "you") continue
      const name = label(str(f.label)) || "Detail"
      shown.set(name, str(f.value))
      fields.push({ name: clip(name, 250), value: clip(str(f.value), 1000) || "(empty)", inline: false })
    }
    for (const c of Array.isArray(pr.changes) ? pr.changes : []) {
      const name = label(str(c.field)) || "Change"
      const before = str(c.before), after = str(c.after)
      if (!before && shown.get(name) === after) continue
      fields.push({ name: clip(name, 250), value: clip(before ? `${before} → ${after || "(empty)"}` : after || "(empty)", 1000), inline: false })
    }
    const warnings = (Array.isArray(pr.warnings) ? pr.warnings : []).map(str).filter(Boolean)
    if (warnings.length) fields.push({ name: "⚠️ Check before confirming", value: clip(warnings.map(w => `• ${w}`).join("\n"), 1000), inline: false })
    const lines = [head[state]]
    if (state === "done" && note) lines.push(clip(note, 500))
    if (state === "ask" && pr.external) lines.push("📤 **This goes outside Player Ready.** Read the full text and who it goes to.")
    if (state === "ask" && Array.isArray(pr.editable) && pr.editable.length) {
      lines.push(pr.readyAppUrl
        ? `To change the wording, tell ${p.agent} what to change (it will show you a new card), or ${link(pr.readyAppUrl).replace("Open", "edit it")}.`
        : `To change the wording, tell ${p.agent} what to change and it will show you a new card.`)
    } else if (state === "ask" && pr.readyAppUrl) lines.push(link(pr.readyAppUrl))
    return {
      title: clip(`${pr.external ? "📤 " : ""}${str(pr.title) || "Confirm a change"}`, 250),
      body: lines.join("\n"),
      fields: fields.slice(0, 20),
      buttons: state === "ask" ? [
        { customId: gwCustomId("confirm", p.id), label: "Confirm", style: "success", emoji: "✅" },
        { customId: gwCustomId("cancel", p.id), label: "Cancel", style: "secondary" },
      ] : [],
      ...(state === "ask" ? { footer: "Only you can confirm this. It also appears in your ReadyApp messages." } : {}),
    }
  }

  /** The agent proposes an action. Always resolves to text for the agent; never throws. */
  async propose(req: {
    agent: string; action: string; params: unknown
    chatId: string | undefined; isDM: boolean; people: { userId: string }[]; scope?: AgentScope
  }): Promise<string> {
    const who = soleSpeaker(req.people)
    if (!who.ok || !req.chatId) {
      this.audit({ action: "propose", target: req.action, agent: req.agent, outcome: "deny", detail: { reason: "no_sole_speaker" } })
      return who.ok
        ? "(refused: there is nowhere to show the person a confirmation, so nothing can be changed.)"
        : who.reason.replace("fetch records for", "change records for").replace("fetch anyone's records", "change anyone's records")
    }
    const userId = who.userId
    const raw = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>
    const t = raw.target as { type?: unknown; id?: unknown } | undefined
    const target = t && typeof t === "object" && typeof t.type === "string" && (typeof t.id === "string" || typeof t.id === "number")
      ? { type: t.type, id: String(t.id) } : undefined
    const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? raw.payload : Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "target" && k !== "payload"))
    const safe = { kind: req.action, ...(target ? { target } : {}), payloadFields: Object.keys(payload as object) }

    let proposal: Proposal
    try {
      // Only kinds ReadyApp lists for THIS person may be proposed.
      // ...and, of those, only the ones on THIS agent's list.
      const cat = scopeCatalog(await this.catalog(userId), req.scope, userId)
      const def = cat.actions.find(a => a.kind === req.action)
      if (!def) {
        this.audit({ action: "propose", target: req.action, agent: req.agent, userId, outcome: "deny", detail: { reason: "not_in_catalog" } })
        return `(refused: "${req.action}" is not something this person can do through you. Their actions: ${cat.actions.map(a => a.kind).join(", ") || "none"}. Nothing was proposed.)`
      }
      // Actions on the person's own things (My Day) take ReadyApp's "self" target.
      const types = def.targetTypes?.length ? def.targetTypes : def.targetType ? [def.targetType] : []
      const sent = target ?? (types.includes("self") ? { type: "self", id: "self" } : undefined)
      proposal = await this.deps.client.propose(userId, {
        kind: req.action, ...(sent ? { target: sent } : {}), payload,
        surface: { kind: "discord", channelId: req.chatId, isDM: req.isDM },
      } as Parameters<HubGatewayClient["propose"]>[1])
    } catch (e) {
      const g = e instanceof GatewayError ? e : new GatewayError("error", 0, "ReadyApp could not be reached.")
      if (g.code === "catalog_stale") this.catalogs.delete(userId)
      this.audit({ action: "propose", target: req.action, agent: req.agent, userId, outcome: g.status >= 400 && g.status < 500 ? "deny" : "error", detail: { ...safe, code: g.code, status: g.status } })
      return `(not proposed: ${g.message} Nothing was changed. Tell the person exactly that.${g.code === "invalid_payload" || g.code === "unknown_target" ? " If a field or id was wrong, check the catalog or do a read, then propose again." : ""})`
    }
    if (!proposal?.cardId) {
      this.audit({ action: "propose", target: req.action, agent: req.agent, userId, outcome: "error", detail: { ...safe, reason: "no_card" } })
      return "(not proposed: ReadyApp did not return a confirmation card. Nothing was changed. Say so.)"
    }

    this.sweep()
    const id = `${this.genId()}${++this.seq}`
    const shell = { id, userId, agent: req.agent, proposal }
    // In a shared channel the preview is the person's own records: it goes to them by DM.
    let where: { chatId: string; messageId: string } | null = null
    if (req.isDM) {
      const mid = await this.deps.sendCard(req.chatId, this.card(shell, "ask")).catch(() => undefined)
      where = mid ? { chatId: req.chatId, messageId: mid } : null
    } else {
      where = await this.deps.sendCardDM(userId, this.card(shell, "ask")).catch(() => null)
    }
    if (!where) {
      // Leave no orphan open in ReadyApp that nobody can see from here.
      this.background(async () => { await this.deps.client.cancel(userId, proposal.cardId, `${id}-x`).catch(() => {}) })
      this.audit({ action: "propose", target: req.action, agent: req.agent, userId, outcome: "error", detail: { ...safe, reason: "card_failed" } })
      return req.isDM
        ? "(not proposed: the confirmation card could not be shown, so it was withdrawn. Nothing was changed. Say so.)"
        : "(not proposed: the confirmation card could not be sent to the person by DM, so it was withdrawn. Nothing was changed. Ask them to allow direct messages from this server, or to ask you in a DM.)"
    }
    const exp = Date.parse(str(proposal.expiresAt))
    this.pending.set(id, {
      id, cardId: proposal.cardId, userId, agent: req.agent, cardChatId: where.chatId, messageId: where.messageId,
      kind: req.action, target, proposal, at: this.now(),
      expiresAt: Number.isFinite(exp) ? exp : this.now() + 15 * 60_000, state: "open",
    })
    this.audit({ action: "propose", target: req.action, agent: req.agent, userId, outcome: "pending", detail: { ...safe, cardId: proposal.cardId, external: !!proposal.external } })
    return `(proposed: a confirmation card is now in front of the person${req.isDM ? "" : ", in their DMs, not in this channel: say so"}. NOTHING HAS CHANGED YET. Tell them to check it and press Confirm if it is right. Do not say it is done, and do not propose it again.)`
  }

  ownedBy(customId: string, userId: string): boolean {
    const c = parseGwCustomId(customId)
    return !!c && this.pending.get(c.id)?.userId === userId
  }

  /** A Confirm or Cancel press. A reason string ⇒ nothing happened (buttons are restored). */
  click(customId: string, clickerId: string): string | undefined {
    const c = parseGwCustomId(customId)
    if (!c) return "That is not an action button."
    const p = this.pending.get(c.id)
    if (!p) return "This is no longer waiting (it expired, or the hub restarted). Ask again, or look in your ReadyApp messages."
    if (p.userId !== clickerId) return "Only the person this change is for can confirm or cancel it."
    if (p.state !== "open") return "This has already been dealt with."
    if (this.now() > p.expiresAt) {
      this.pending.delete(p.id)
      this.background(() => this.deps.editCard(p.cardChatId, p.messageId, this.card(p, "expired")))
      return "This was not confirmed in time, so it has lapsed. Ask again."
    }
    p.state = "running"
    this.background(() => (c.verb === "cancel" ? this.runCancel(p) : this.runConfirm(p)))
    return undefined
  }

  private detail(p: Pending): Record<string, unknown> {
    return { agent: p.agent, cardId: p.cardId, kind: p.kind, ...(p.target ? { target: p.target } : {}) }
  }
  private show(p: Pending, state: CardState, note?: string): Promise<void> {
    return this.deps.editCard(p.cardChatId, p.messageId, this.card(p, state, note)).catch(() => {})
  }

  private async runCancel(p: Pending): Promise<void> {
    try {
      await this.deps.client.cancel(p.userId, p.cardId, `${p.id}-c`)
      this.pending.delete(p.id)
      this.audit({ action: "cancel", target: p.kind, agent: p.agent, userId: p.userId, outcome: "ok", detail: this.detail(p) })
      await this.show(p, "cancelled")
    } catch (e) {
      const g = e instanceof GatewayError ? e : new GatewayError("error", 0, "ReadyApp could not be reached.")
      this.audit({ action: "cancel", target: p.kind, agent: p.agent, userId: p.userId, outcome: "error", detail: { ...this.detail(p), code: g.code, status: g.status } })
      // Could not tell ReadyApp: let the poll settle it rather than claim it is cancelled.
      if (await this.settle(p)) return
      this.pending.delete(p.id)
      await this.show(p, "failed", `It could not be cancelled from here (${g.message}) It may still be open in your ReadyApp messages.`)
    }
  }

  private async runConfirm(p: Pending): Promise<void> {
    await this.show(p, "running")
    try {
      const r = await this.deps.client.confirm(p.userId, p.cardId, p.id)
      this.pending.delete(p.id)
      const ok = r.status === "done"
      this.audit({ action: "confirm", target: p.kind, agent: p.agent, userId: p.userId, outcome: ok ? "ok" : "error", detail: { ...this.detail(p), status: r.status } })
      await this.show(p, ok ? "done" : "failed", [str(r.message), r.url ? link(str(r.url)) : ""].filter(Boolean).join("\n") || undefined)
    } catch (e) {
      const g = e instanceof GatewayError ? e : new GatewayError("error", 0, "ReadyApp could not be reached.")
      this.audit({ action: "confirm", target: p.kind, agent: p.agent, userId: p.userId, outcome: g.status >= 400 && g.status < 500 && g.code !== "idempotency_pending" ? "deny" : "error", detail: { ...this.detail(p), code: g.code, status: g.status } })
      // Uncertain outcomes (no answer, still running, a server error): never write again
      // blindly. Ask ReadyApp where the card got to.
      const uncertain = g.code === "timeout" || g.code === "idempotency_pending" || g.status >= 500 || g.status === 0
      if (uncertain) {
        if (await this.settle(p)) return
        this.pending.delete(p.id)
        await this.show(p, "failed", "ReadyApp didn't say whether this went through. Check the record in ReadyApp before trying again.")
        return
      }
      this.pending.delete(p.id)
      await this.show(p, g.code === "expired" ? "expired" : "failed", `${g.message}${g.retryAfterSeconds ? ` (try again in about ${Math.ceil(g.retryAfterSeconds / 60)} min)` : ""} Nothing was changed.`)
    }
  }

  /** Ask ReadyApp for a card's status and, if it is final, show it. True when settled. */
  private async settle(p: Pending): Promise<boolean> {
    let st
    try { st = await this.deps.client.status(p.userId, p.cardId) } catch { return false }
    return this.applyStatus(p, st.status, st.message)
  }

  private async applyStatus(p: Pending, status: string, message?: string): Promise<boolean> {
    const map: Record<string, [CardState, string]> = {
      done: ["done", message || "Done in ReadyApp."],
      cancelled: ["elsewhere", "Cancelled. Nothing was changed."],
      expired: ["expired", ""],
      failed: ["failed", `${message || "ReadyApp could not do it."}`],
    }
    const hit = map[status]
    if (!hit) return false
    this.pending.delete(p.id)
    this.audit({ action: "status", target: p.kind, agent: p.agent, userId: p.userId, outcome: status === "done" ? "ok" : status === "failed" ? "error" : "deny", detail: { ...this.detail(p), status } })
    await this.show(p, hit[0], hit[1] || undefined)
    return true
  }

  /** A status event from ReadyApp's webhook (or anything else that learns a card's fate). */
  async onStatus(cardId: string, status: string, message?: string): Promise<boolean> {
    for (const p of this.pending.values()) if (p.cardId === cardId && p.state === "open") return this.applyStatus(p, status, message)
    return false
  }

  /** Check every open card against ReadyApp, so one confirmed or cancelled there is
   *  updated here. Also lapses cards whose time has passed. */
  async poll(): Promise<void> {
    this.sweep()
    for (const p of [...this.pending.values()]) {
      if (p.state !== "open") continue
      await this.settle(p)
    }
    await this.work
  }

  openCount(): number { return this.pending.size }

  private sweep(): void {
    const now = this.now()
    for (const [id, p] of this.pending) {
      if (p.state === "open" && now > p.expiresAt) {
        this.pending.delete(id)
        this.background(() => this.show(p, "expired"))
      }
    }
  }
}
