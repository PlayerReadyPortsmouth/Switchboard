import { createHash } from "node:crypto"
import type { OutboundRoute } from "./types"
import { signBody, backoffMs, hostAllowed } from "./outbound"

export interface DeliveryLogEntry {
  id: string; ts: number; attempt: number; status: number | "error"; ok: boolean; idemKey: string
}
export interface DeadLetterEntry {
  id: string; ts: number; url: string; body: string; lastStatus: number | "error"; attempts: number
}

export interface OutboundDeliveryDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>
  appendLog: (e: DeliveryLogEntry) => void
  appendDeadLetter: (e: DeadLetterEntry) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Resolve a route's signing secret (from env) — undefined ⇒ unsigned. */
  secretFor: (route: OutboundRoute) => string | undefined
  retries?: number            // default 3
  allowedHosts?: string[]
}

export interface DeliveryResult { ok: boolean; attempts: number; status: number | "error" | "blocked" }

/** Stable idempotency key for a (route, body) — same across retries so receivers
 *  dedupe; excludes the per-attempt timestamp. */
export function idempotencyKey(id: string, body: string): string {
  return createHash("sha256").update(`${id}:${body}`).digest("hex").slice(0, 32)
}

/** Delivers a route's body with retry → dead-letter, an idempotency key, optional
 *  HMAC signing, a host allowlist, and an append-only delivery log. All IO is
 *  injected; the engine itself is deterministic and unit-tested. */
export class OutboundDelivery {
  constructor(private deps: OutboundDeliveryDeps) {}

  async deliver(route: OutboundRoute, body: string): Promise<DeliveryResult> {
    const now = this.deps.now
    if (!hostAllowed(route.url, this.deps.allowedHosts)) {
      this.deps.appendLog({ id: route.id, ts: now(), attempt: 0, status: "error", ok: false, idemKey: "" })
      return { ok: false, attempts: 0, status: "blocked" }
    }
    const idemKey = idempotencyKey(route.id, body)
    const retries = Math.max(1, this.deps.retries ?? 3)
    const method = route.method ?? "POST"
    const secret = this.deps.secretFor(route)
    let lastStatus: number | "error" = "error"

    for (let attempt = 1; attempt <= retries; attempt++) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "Idempotency-Key": idemKey,
        ...(route.headers ?? {}),
      }
      if (secret) {
        const { signature, timestamp } = signBody(body, secret, Math.floor(now() / 1000))
        headers["X-Switchboard-Signature"] = signature
        headers["X-Switchboard-Timestamp"] = timestamp
      }
      try {
        const res = await this.deps.fetch(route.url, { method, headers, body })
        lastStatus = res.status
        const ok = res.status >= 200 && res.status < 300
        this.deps.appendLog({ id: route.id, ts: now(), attempt, status: res.status, ok, idemKey })
        if (ok) return { ok: true, attempts: attempt, status: res.status }
      } catch {
        lastStatus = "error"
        this.deps.appendLog({ id: route.id, ts: now(), attempt, status: "error", ok: false, idemKey })
      }
      if (attempt < retries) await this.deps.sleep(backoffMs(attempt))
    }
    this.deps.appendDeadLetter({ id: route.id, ts: now(), url: route.url, body, lastStatus, attempts: retries })
    return { ok: false, attempts: retries, status: lastStatus }
  }
}
