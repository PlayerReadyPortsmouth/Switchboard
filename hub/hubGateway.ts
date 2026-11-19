/** Client for the ReadyApp hub gateway: the hub acting for the person who is speaking,
 *  with ReadyApp owning every rule (action shapes, permissions, risk, the write itself).
 *
 *  The hub's side of the bargain is small and is all here:
 *   - sign every request with this hub's own secret (never a person's key);
 *   - send WHO is speaking, as the hub determined it, never as the model said it;
 *   - turn ReadyApp's refusals into a sentence the person can act on.
 *
 *  Spec: 2026-11-18-hub-gateway-spec.md. Field names follow that proposal until
 *  ReadyApp's real contracts arrive; they are all in this one file. */
import { createHash, createHmac, randomBytes } from "crypto"

export interface HubGatewayConfig {
  /** e.g. "https://api.readyapp.example". */
  baseUrl: string
  /** Route prefix. Default "/hub/v1". */
  prefix?: string
  /** This hub's registered client id, e.g. "hub:skippy-4". */
  clientId: string
  /** Env var holding this hub's signing secret. */
  secretEnv: string
  timeoutMs?: number
}

export interface SignedHeaders {
  "x-hub-client": string
  "x-hub-timestamp": string
  "x-hub-nonce": string
  "x-hub-signature": string
}

/** hex(HMAC-SHA256(secret, method \n path-with-query \n timestamp \n nonce \n sha256(body))). */
export function signRequest(
  secret: string, clientId: string, method: string, pathWithQuery: string, body: string,
  now: number, nonce: string,
): SignedHeaders {
  const bodyHash = createHash("sha256").update(body).digest("hex")
  const base = [method.toUpperCase(), pathWithQuery, String(now), nonce, bodyHash].join("\n")
  return {
    "x-hub-client": clientId,
    "x-hub-timestamp": String(now),
    "x-hub-nonce": nonce,
    "x-hub-signature": createHmac("sha256", secret).update(base).digest("hex"),
  }
}

export interface CatalogRead { name: string; description: string; params?: Record<string, string> }
export interface CatalogAction {
  kind: string; description: string; targetType?: string; targetTypes?: string[]; blastRadius?: string
  risk?: "auto" | "confirm"; external?: boolean
  schema?: Record<string, unknown>
}
export interface Catalog { version?: string; reads: CatalogRead[]; actions: CatalogAction[] }

export interface Proposal {
  cardId: string
  expiresAt?: string
  risk?: "auto" | "confirm"
  external?: boolean
  title: string
  preview?: { label: string; value: string }[]
  changes?: { field: string; before: string; after: string }[]
  warnings?: string[]
  editable?: { field: string; maxLength?: number }[]
  readyAppUrl?: string
  /** Set when ReadyApp applied a low-risk action immediately instead of making a card. */
  applied?: boolean
  message?: string
}

export interface ActionResult { status: string; message?: string; url?: string }
export interface CardStatus { cardId?: string; status: string; message?: string }

/** A refusal or failure, already phrased for the person. `code` is ReadyApp's error code. */
export class GatewayError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly retryAfterSeconds?: number) {
    super(message)
  }
}

/** ReadyApp's error code → a sentence. `message` from ReadyApp wins when it sent one that
 *  is safe to show (it says so by sending it in `message`). */
export function explain(code: string, status: number, message?: string, linkUrl?: string): string {
  if (message && !["not_linked", "inactive", "hub_disabled"].includes(code)) return message
  switch (code) {
    case "not_linked": return `Your Discord account isn't linked to your ReadyApp account yet.${linkUrl ? ` Link it at ${linkUrl} and try again.` : " Link it in ReadyApp and try again."}`
    case "inactive": return "Your ReadyApp account isn't active, so I can't act for you."
    case "hub_disabled": return "This assistant isn't switched on for you in ReadyApp yet. Ask an admin to turn it on."
    case "forbidden": return "You don't have permission for that in ReadyApp."
    case "unknown_read": case "unknown_target": return "ReadyApp couldn't find that."
    case "invalid_payload": return "ReadyApp didn't accept the details of that request."
    case "action_disabled": return "That action is switched off at the moment."
    case "throttled": return "You've reached the limit for that for now. Try again later."
    case "not_requester": return "Only the person who asked can confirm this."
    case "card_changed": return "The record changed after this was proposed, so it wasn't applied. Ask again to see the current version."
    case "expired": return "This wasn't confirmed in time, so it has lapsed."
    // ReadyApp's general login check answers for any path the gateway does not serve, so
    // this means "no such route here", not a problem with the hub's own sign-in.
    case "missing_token": return "ReadyApp doesn't offer that through this assistant yet."
    case "read_disabled": return "ReadyApp has the detailed view switched off for this account."
    case "idempotency_pending": return "ReadyApp is still working on that. Check the record before trying again."
    case "catalog_stale": return "The list of what you can do has changed. Ask again."
    case "bad_signature": case "stale": case "stale_timestamp": case "unknown_client": case "replayed": case "replayed_nonce":
      return "The assistant couldn't sign in to ReadyApp. An operator needs to check the hub's registration."
    default: return status >= 500 ? "ReadyApp had a problem. Nothing was changed; try again shortly."
      : `ReadyApp refused that (${code || status}).`
  }
}

export interface HubGatewayDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>
  secret: (envName: string) => string | undefined
  now?: () => number
  nonce?: () => string
  /** Told when ReadyApp rejects a request as stale, with the two clocks, so skew is visible. */
  onSkew?: (hubNow: number, serverTime: number) => void
  /** Where an unlinked person is sent. */
  linkUrl?: string
}

export class HubGatewayClient {
  private readonly prefix: string
  private readonly now: () => number
  private readonly nonce: () => string
  constructor(private readonly cfg: HubGatewayConfig, private readonly deps: HubGatewayDeps) {
    this.prefix = cfg.prefix ?? "/hub/v1"
    this.now = deps.now ?? (() => Date.now())
    this.nonce = deps.nonce ?? (() => randomBytes(16).toString("hex"))
  }

  private async call<T>(method: "GET" | "POST", path: string, query: Record<string, string | undefined>, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const secret = this.deps.secret(this.cfg.secretEnv)
    if (!secret) throw new GatewayError("no_secret", 0, "The assistant has no key for ReadyApp. An operator needs to set it.")
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`).join("&")
    const pathWithQuery = `${this.prefix}${path}${qs ? `?${qs}` : ""}`
    const text = body === undefined ? "" : JSON.stringify(body)
    const sentAt = this.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 20_000)
    ;(timer as { unref?: () => void }).unref?.()
    let res
    try {
      res = await this.deps.fetch(this.cfg.baseUrl.replace(/\/+$/, "") + pathWithQuery, {
        method,
        headers: {
          ...signRequest(secret, this.cfg.clientId, method, pathWithQuery, text, sentAt, this.nonce()),
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: text }),
        signal: ctl.signal,
      })
    } catch {
      throw new GatewayError("timeout", 0, "ReadyApp didn't answer in time.")
    } finally {
      clearTimeout(timer)
    }
    const raw = await res.text()
    let json: any = undefined
    try { json = raw ? JSON.parse(raw) : undefined } catch {}
    // ReadyApp wraps successes as { data: ... }.
    if (res.ok) return ((json && typeof json === "object" && "data" in json ? json.data : json) ?? {}) as T
    const code = typeof json?.error === "string" ? json.error : ""
    const serverTime = Number(res.headers?.get("x-server-time") ?? NaN)
    if (Number.isFinite(serverTime)) { try { this.deps.onSkew?.(sentAt, serverTime) } catch {} }
    throw new GatewayError(code, res.status,
      explain(code, res.status, typeof json?.message === "string" ? json.message : undefined, this.deps.linkUrl),
      typeof json?.retryAfterSeconds === "number" ? json.retryAfterSeconds : undefined)
  }

  /** What this person may read and do through this hub. */
  catalog(discordId: string): Promise<Catalog> {
    return this.call<Partial<Catalog>>("GET", "/catalog", { discordId }).then(c => ({
      version: c.version, reads: Array.isArray(c.reads) ? c.reads : [], actions: Array.isArray(c.actions) ? c.actions : [],
    }))
  }

  /** One of the person's reads. The identity is set here; `q` is the model's search text. */
  read(discordId: string, name: string, q?: string, limit?: number, opts: { id?: string; params?: Record<string, unknown> } = {}): Promise<unknown> {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(name)) throw new GatewayError("unknown_read", 404, "ReadyApp couldn't find that.")
    // One record in detail: /read/{name}/{id}. The id is a plain token, never a path.
    if (opts.id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(opts.id)) throw new GatewayError("unknown_target", 404, "ReadyApp couldn't find that.")
    // Filters the catalog lists (status, sort, summary, cursor…). Simple names and short
    // scalar values only; the identity, search text and limit cannot be set this way.
    // The private reply helper for one ticket: /read/tickets/{id}/reply-context. A fixed
    // path, chosen by a fixed word; nothing the model writes becomes part of the path.
    if (opts.params?.view === "reply-context") {
      if (name !== "tickets" || opts.id === undefined) throw new GatewayError("unknown_read", 404, "Reply context is only available for one ticket: give the ticket's id.")
      return this.call("GET", `/read/tickets/${opts.id}/reply-context`, { discordId })
    }
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.params ?? {}).filter(([k]) => k !== "view").slice(0, 8)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k) || ["discordid", "q", "limit"].includes(k.toLowerCase())) continue
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") extra[k] = String(v).slice(0, 200)
    }
    const lim = limit ?? (typeof opts.params?.limit === "number" ? opts.params.limit : undefined)
    return this.call("GET", `/read/${name}${opts.id !== undefined ? `/${opts.id}` : ""}`, {
      discordId, q: q?.slice(0, 200), limit: lim ? String(Math.min(Math.max(1, Math.floor(lim)), 50)) : undefined, ...extra,
    })
  }

  propose(discordId: string, p: { kind: string; target?: { type: string; id: string }; payload: unknown; surface: { kind: string; channelId: string; isDM: boolean } }): Promise<Proposal> {
    return this.call<Proposal>("POST", "/actions/propose", {}, { discordId, ...p })
  }

  confirm(discordId: string, cardId: string, idempotencyKey: string, edits?: Record<string, string>): Promise<ActionResult> {
    return this.call<ActionResult>("POST", `/actions/${encodeURIComponent(cardId)}/confirm`, {}, { discordId, ...(edits ? { edits } : {}) }, { "idempotency-key": idempotencyKey })
  }

  cancel(discordId: string, cardId: string, idempotencyKey: string): Promise<ActionResult> {
    return this.call<ActionResult>("POST", `/actions/${encodeURIComponent(cardId)}/cancel`, {}, { discordId }, { "idempotency-key": idempotencyKey })
  }

  /** Where a card has got to. Status only, by design: no preview comes back. */
  status(discordId: string, cardId: string): Promise<CardStatus> {
    return this.call<CardStatus>("GET", `/actions/${encodeURIComponent(cardId)}`, { discordId })
  }
}

function targetNote(a: CatalogAction): string {
  const types = (a.targetTypes?.length ? a.targetTypes : a.targetType ? [a.targetType] : []).filter(t => t && t !== "self")
  return types.length ? ` [target: a ${types.join(" or ")} id]` : ""
}

/** The catalog as the Assistant should see it: names, what each needs, and how to call
 *  it. Schemas are flattened to "field (type, required)" so the list stays readable. */
export function renderCatalog(c: Catalog): string {
  const reads = c.reads.map(r => `- ${r.name}: ${r.description}${r.params && Object.keys(r.params).length ? ` (optional: ${Object.entries(r.params).map(([k, d]) => `${k} = ${d}`).join("; ")})` : ""}`)
  const actions = c.actions.map(a => {
    const props = (a.schema?.properties ?? {}) as Record<string, { type?: string; enum?: unknown[]; maxLength?: number }>
    const req = new Set(Array.isArray(a.schema?.required) ? a.schema!.required as string[] : [])
    const fields = Object.entries(props).map(([k, s]) => `${k}${req.has(k) ? "*" : ""}${s.enum ? ` (one of ${s.enum.join("/")})` : s.type ? ` (${s.type})` : ""}`).join(", ")
    return `- ${a.kind}: ${a.description}${targetNote(a)}${fields ? ` {${fields}}` : ""}${a.external ? " [goes outside Player Ready]" : ""}`
  })
  return [
    "READS (call my_data with tool = the name; `query` is search text):",
    ...(reads.length ? reads : ["- none"]),
    "ACTIONS (call my_action with action = the kind and params = { target: { type, id }, payload: { fields } }; * marks a required field; ids come from a read, never from memory):",
    ...(actions.length ? actions : ["- none"]),
  ].join("\n")
}
