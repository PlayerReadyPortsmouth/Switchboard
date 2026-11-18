/** Speaker-scoped data tools: an agent asks for "my tickets", and the HUB fetches them
 *  for the person who is actually speaking.
 *
 *  The agent holds no credential and never names the person. It calls one tool,
 *  `my_data { tool, query? }`. The hub works out who the turn is for from the Discord
 *  message that started it, calls the configured read-only endpoint with that identity
 *  and the hub's own key, and hands the response back. So "show me someone else's
 *  deals" is not something the model can do however it is asked: the identity is not an
 *  argument, and the key never enters the agent's process.
 *
 *  The upstream is trusted to scope by the identity it is given. This module's job is
 *  to make sure that identity can only ever be the real speaker's, and to refuse when
 *  it cannot tell who that is. */

export interface SpeakerDataTool {
  /** Path on `baseUrl`, e.g. "/api/hub/my/tickets". */
  path: string
  /** What the agent is told this returns. */
  description: string
}

export interface SpeakerDataConfig {
  enabled?: boolean
  /** e.g. "https://prime.internal". No trailing slash needed. */
  baseUrl: string
  /** Env var holding the hub's bearer key for the upstream. */
  secretEnv: string
  /** Named tools → upstream paths. The agent can only ask for these names. */
  tools: Record<string, SpeakerDataTool>
  timeoutMs?: number
  /** Response bodies longer than this are cut, with a note. Default 20000 chars. */
  maxChars?: number
  /** Changes the speaker may make to their own records, each proposed by the agent and
   *  confirmed by that person on a card before the hub performs it. See speakerActions.ts. */
  actions?: Record<string, import("./speakerActions").SpeakerAction>
  /** How long a proposed action waits for Confirm (default 15 minutes). */
  confirmTtlMs?: number
  /** In a shared channel, send an answer that used these tools to the person by DM and
   *  leave only a one-line pointer in the channel. Default TRUE: a person's own records
   *  should not be posted to a room because of where they happened to ask. */
  privateReplies?: boolean
}

/** Who a data request may be for. `ok:false` carries the sentence the agent is given. */
export type SpeakerVerdict = { ok: true; userId: string } | { ok: false; reason: string }

/** Exactly one person must be behind the turn. Nobody (a schedule, a workflow, a consult
 *  from a colleague) or more than one distinct person (queued turns from two people in
 *  one channel that the hub cannot tell apart) are both refused: a guess here would
 *  show one person another's records. */
export function soleSpeaker(people: { userId: string }[]): SpeakerVerdict {
  const ids = [...new Set(people.map(p => p.userId))]
  if (ids.length === 0) {
    return { ok: false, reason: "(refused: there is no person behind this turn, so there is nobody to fetch records for. Personal records can only be fetched while answering that person directly, not for a colleague's question or a scheduled job.)" }
  }
  if (ids.length > 1) {
    return { ok: false, reason: "(refused: more than one person is waiting on you in this channel and the hub cannot tell which of them this is for, so it will not fetch anyone's records. Ask the person to send their request again.)" }
  }
  return { ok: true, userId: ids[0]! }
}

/** Turns whose answer contains a person's own records, so the reply can be sent to
 *  that person privately instead of into a shared channel.
 *
 *  Marked when a `my_data` fetch SUCCEEDS for an agent in a chat; taken (once) when that
 *  agent's reply for that chat is about to be posted. A refusal or an error marks
 *  nothing: there are no records in that answer to protect. Marks age out, so a turn
 *  that never replied cannot make some later, unrelated answer go private. */
export class PrivateReplies {
  private marks = new Map<string, { userId: string; at: number }>()
  constructor(private now: () => number = () => Date.now(), private maxAgeMs = 15 * 60_000) {}
  private key(agent: string, chatId: string): string { return `${agent}\u0000${chatId}` }
  mark(agent: string, chatId: string, userId: string): void {
    this.marks.set(this.key(agent, chatId), { userId, at: this.now() })
  }
  /** The person this agent's reply in this chat must go to privately, or null. Single-use. */
  take(agent: string, chatId: string): string | null {
    const k = this.key(agent, chatId)
    const m = this.marks.get(k)
    if (!m) return null
    this.marks.delete(k)
    return this.now() - m.at <= this.maxAgeMs ? m.userId : null
  }
}

/** Private answers waiting on their owner's decision to share them.
 *
 *  An answer built from someone's records is DM'd to them with a "Share to the channel"
 *  button. Sharing is theirs alone to do: `claim` hands the text back only to the person
 *  it was sent to, only once, and only for a while. */
export interface PendingShare {
  id: string; userId: string; chatId: string; agent: string; text: string; at: number
  dmChatId?: string; dmMessageId?: string
}

export const SHARE_PREFIX = "share:post:"

export class PendingShares {
  private byId = new Map<string, PendingShare>()
  private seq = 0
  constructor(private now: () => number = () => Date.now(), private maxAgeMs = 60 * 60_000,
    private genId: () => string = () => Math.random().toString(36).slice(2, 10)) {}

  create(userId: string, chatId: string, agent: string, text: string): PendingShare {
    this.sweep()
    const id = `${this.genId()}${++this.seq}`
    const s: PendingShare = { id, userId, chatId, agent, text, at: this.now() }
    this.byId.set(id, s)
    return s
  }

  /** May this person press this share button? (Used to authorise the click at all.) */
  ownedBy(customId: string, userId: string): boolean {
    const s = this.byId.get(customId.slice(SHARE_PREFIX.length))
    return !!s && s.userId === userId
  }

  /** Hand the answer over for posting, or a reason it will not be. Single-use. */
  claim(customId: string, clickerId: string): PendingShare | string {
    if (!customId.startsWith(SHARE_PREFIX)) return "That is not a share button."
    const id = customId.slice(SHARE_PREFIX.length)
    const s = this.byId.get(id)
    if (!s || this.now() - s.at > this.maxAgeMs) {
      this.byId.delete(id)
      return "This answer can no longer be shared (it has expired, or the hub restarted). Ask again to get a fresh one."
    }
    if (s.userId !== clickerId) return "Only the person this answer was sent to can share it."
    this.byId.delete(id)
    return s
  }

  private sweep(): void {
    const cutoff = this.now() - this.maxAgeMs
    for (const [id, s] of this.byId) if (s.at < cutoff) this.byId.delete(id)
  }
}

export interface SpeakerDataDeps {
  fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  secret: (envName: string) => string | undefined
  audit?: (e: { tool: string; agent: string; userId?: string; outcome: "ok" | "deny" | "error"; detail?: Record<string, unknown> }) => void
  /** Called when records were actually fetched for `userId`, so the caller can make the
   *  reply private. Not called for a refusal or an error. */
  onFetched?: (userId: string) => void
}

/** The tools an agent is allowed, as the shim needs them: name + description. */
export function toolsFor(cfg: SpeakerDataConfig | undefined, allowed: string[] | undefined): { name: string; description: string }[] {
  if (!cfg?.enabled || !allowed?.length) return []
  return allowed.filter(n => cfg.tools[n]).map(n => ({ name: n, description: cfg.tools[n]!.description }))
}

/** Run one data request. Always resolves to text for the agent; never throws. */
export async function runSpeakerData(
  cfg: SpeakerDataConfig,
  deps: SpeakerDataDeps,
  req: { agent: string; allowed: string[]; tool: string; query?: string; people: { userId: string }[] },
): Promise<string> {
  const audit = deps.audit ?? (() => {})
  // The agent may only use tools its own config lists, whatever the hub has configured.
  if (!req.allowed.includes(req.tool) || !cfg.tools[req.tool]) {
    audit({ tool: req.tool, agent: req.agent, outcome: "deny", detail: { reason: "unknown_tool" } })
    const names = req.allowed.filter(n => cfg.tools[n])
    return `(refused: "${req.tool}" is not a data tool you have. Available: ${names.join(", ") || "none"}.)`
  }
  const who = soleSpeaker(req.people)
  if (!who.ok) {
    audit({ tool: req.tool, agent: req.agent, outcome: "deny", detail: { reason: "no_sole_speaker", people: req.people.length } })
    return who.reason
  }
  const secret = deps.secret(cfg.secretEnv)
  if (!secret) {
    audit({ tool: req.tool, agent: req.agent, userId: who.userId, outcome: "error", detail: { reason: "no_secret" } })
    return "(unavailable: the hub has no key for the records service. An operator needs to set it.)"
  }
  // The identity goes in a header and a parameter the AGENT never supplies. `query` is
  // the only thing that came from the model, and it is passed as an opaque search term.
  const url = new URL(cfg.baseUrl.replace(/\/+$/, "") + cfg.tools[req.tool]!.path)
  url.searchParams.set("discord_id", who.userId)
  if (req.query) url.searchParams.set("q", req.query.slice(0, 200))
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 15_000)
  ;(timer as { unref?: () => void }).unref?.()
  try {
    const res = await deps.fetch(url.toString(), {
      headers: { authorization: `Bearer ${secret}`, "x-speaker-discord-id": who.userId, accept: "application/json" },
      signal: ctl.signal,
    })
    const body = await res.text()
    if (!res.ok) {
      audit({ tool: req.tool, agent: req.agent, userId: who.userId, outcome: "error", detail: { status: res.status } })
      if (res.status === 404) return "(no records: the records service does not recognise this person's Discord account as a member of staff.)"
      return `(unavailable: the records service answered ${res.status}. Say that you could not fetch it; do not guess.)`
    }
    audit({ tool: req.tool, agent: req.agent, userId: who.userId, outcome: "ok", detail: { chars: body.length } })
    try { deps.onFetched?.(who.userId) } catch {}
    const max = cfg.maxChars ?? 20_000
    return body.length > max
      ? `${body.slice(0, max)}\n(cut: the full response was ${body.length} characters; narrow it with a query.)`
      : body
  } catch (e) {
    audit({ tool: req.tool, agent: req.agent, userId: who.userId, outcome: "error", detail: { error: String(e).slice(0, 120) } })
    return "(unavailable: the records service did not answer in time. Say that you could not fetch it; do not guess.)"
  } finally {
    clearTimeout(timer)
  }
}
