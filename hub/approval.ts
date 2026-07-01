import type { CardSpec } from "./types"

export type ApprovalDecision = "grant" | "deny"
export type ApprovalState = "pending" | "granted" | "denied" | "expired"

/** What an effect asks approval for. `summary` is the one line shown on the card. */
export interface ApprovalRequest {
  kind: string         // effect class: "outbound" | "exec" | …
  target: string       // route id / command id — what will run
  actor: string        // who initiated it: "agent:<name>" | "hub"
  chat?: string        // origin conversation (card fallback + audit)
  summary: string      // one line: what happens if approved
}

/** The held effect, run once on grant. Receives the approval id so it can thread
 *  its own audit row to the approval via `corr`. */
export type ApprovalFire = (corr?: string) => void | Promise<void>

export interface PendingApproval extends ApprovalRequest {
  id: string
  createdAt: number
  expiresAt: number
  state: ApprovalState
  fire: ApprovalFire
}

/** In-memory store of pending approvals. Deterministic (injected `now`/`genId`);
 *  in-memory by design, so a hub restart drops pending approvals — the held
 *  effect simply never fires (fail-closed, the safe default for "require approval"). */
export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  /** Park an effect for approval; returns the pending entry (state "pending"). */
  request(req: ApprovalRequest, fire: ApprovalFire): PendingApproval {
    const createdAt = this.now()
    const e: PendingApproval = {
      ...req, id: this.genId(), createdAt, expiresAt: createdAt + this.ttlMs, state: "pending", fire,
    }
    this.pending.set(e.id, e)
    return e
  }

  get(id: string): PendingApproval | undefined {
    return this.pending.get(id)
  }

  /** Resolve a pending approval. Single-shot: a second call (or after expiry)
   *  returns null, so a double-click can never fire the effect twice. */
  resolve(id: string, decision: ApprovalDecision): PendingApproval | null {
    const e = this.pending.get(id)
    if (!e || e.state !== "pending") return null
    e.state = decision === "grant" ? "granted" : "denied"
    this.pending.delete(id)
    return e
  }

  /** Move every past-deadline entry to "expired" (never fires) and return them. */
  sweepExpired(): PendingApproval[] {
    const t = this.now()
    const out: PendingApproval[] = []
    for (const [id, e] of this.pending) {
      if (e.expiresAt <= t) { e.state = "expired"; this.pending.delete(id); out.push(e) }
    }
    return out
  }

  pendingCount(): number {
    return this.pending.size
  }

  list(): PendingApproval[] {
    return [...this.pending.values()]
  }
}

/** Button customId for an approval decision, in the gateway's `ns:action:arg`
 *  scheme (ns `approval` ≠ the reserved `perm`). */
export function approvalCustomId(id: string, decision: ApprovalDecision): string {
  return `approval:${decision}:${id}`
}

const CUSTOM_ID = /^approval:(grant|deny):(.+)$/

export function parseApprovalCustomId(customId: string): { id: string; decision: ApprovalDecision } | null {
  const m = CUSTOM_ID.exec(customId)
  if (!m) return null
  return { id: m[2], decision: m[1] as ApprovalDecision }
}

const TERMINAL: Record<Exclude<ApprovalState, "pending">, string> = {
  granted: "✅ Approved",
  denied: "✋ Denied",
  expired: "⌛ Expired (auto-denied)",
}

/** Render the approval card: a pending entry gets Approve/Deny buttons; a
 *  resolved one restates the outcome with no buttons. Pure. */
export function renderApprovalCard(e: PendingApproval): CardSpec {
  if (e.state === "pending") {
    return {
      title: "⏳ Approval required",
      body: e.summary,
      fields: [
        { name: "action", value: `${e.kind} · ${e.target}`, inline: true },
        { name: "requested by", value: e.actor, inline: true },
      ],
      buttons: [
        { customId: approvalCustomId(e.id, "grant"), label: "Approve", style: "success", emoji: "✅" },
        { customId: approvalCustomId(e.id, "deny"), label: "Deny", style: "danger", emoji: "✋" },
      ],
    }
  }
  return { title: TERMINAL[e.state], body: e.summary, buttons: [] }
}
