import { createHmac } from "node:crypto"
import type { OutboundRoute } from "./types"

export interface OutboundMatch { route: OutboundRoute; groups: string[] }

/** All routes whose `pattern` matches `text` (text-trigger). `groups` are the
 *  regex capture groups (index 0 = whole match). Invalid patterns are skipped. */
export function matchOutbound(text: string, routes: OutboundRoute[]): OutboundMatch[] {
  const out: OutboundMatch[] = []
  for (const route of routes) {
    if (!route.pattern) continue
    let re: RegExp
    try { re = new RegExp(route.pattern) } catch { continue }
    const m = re.exec(text)
    if (m) out.push({ route, groups: [...m] })
  }
  return out
}

/** Render the POST body. With a `template`, interpolate `$0`..`$n` from the
 *  capture groups; without one, fall back to the tool-supplied body, then the
 *  whole match. */
export function renderBody(template: string | undefined, ctx: { groups?: string[]; body?: string }): string {
  if (!template) return ctx.body ?? ctx.groups?.[0] ?? ""
  return template.replace(/\$(\d+)/g, (_, n: string) => ctx.groups?.[Number(n)] ?? "")
}

export interface Signature { signature: string; timestamp: string }

/** HMAC-sign `"<tsSec>.<body>"` → `sha256=<hex>`, returning the timestamp so the
 *  receiver can reconstruct the signed string and reject replays. Symmetric with
 *  the inbound verifier's `sha256=` scheme (hub/webhookListener.ts). */
export function signBody(body: string, secret: string, tsSec: number): Signature {
  const timestamp = String(tsSec)
  const signature = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  return { signature, timestamp }
}

/** Exponential backoff for retry attempt n (1-based): base, 2·base, 4·base, …,
 *  capped at `capMs`. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
}

/** Is `url`'s host in the allowlist? An empty/absent allowlist allows all; an
 *  unparseable URL is rejected. */
export function hostAllowed(url: string, allowed?: string[]): boolean {
  if (!allowed || allowed.length === 0) return true
  try { return allowed.includes(new URL(url).host) } catch { return false }
}

/** Redact any header value that contains a known secret substring, for logging. */
export function redact(headers: Record<string, string>, secrets: string[]): Record<string, string> {
  const secs = secrets.filter(Boolean)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = secs.some(s => v.includes(s)) ? "***" : v
  return out
}
