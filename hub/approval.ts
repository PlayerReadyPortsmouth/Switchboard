import { createHash } from "node:crypto"
import type { CardSpec } from "./types"
import type {
  ApprovalDecision,
  ApprovalNotificationView,
  ApprovalPrincipal,
} from "./approvalTypes"

export type { ApprovalDecision } from "./approvalTypes"

export const LEGACY_APPROVAL_VERSION = "legacy"

export function approvalCustomId(id: string, decision: ApprovalDecision, version: string): string {
  if (!id || !version || id.includes(":") || version.includes(":")) {
    throw new Error("invalid_approval_custom_id")
  }
  return `approval:${decision}:${version}:${id}`
}

const CUSTOM_ID = /^approval:(grant|deny):([^:]+):([^:]+)$/

export function parseApprovalCustomId(customId: string): {
  id: string
  decision: ApprovalDecision
  version: string
} | null {
  const match = CUSTOM_ID.exec(customId)
  return match
    ? { decision: match[1] as ApprovalDecision, version: match[2]!, id: match[3]! }
    : null
}

/**
 * Discord interactions are the preferred idempotency boundary. The fallback is
 * deterministic and binds every decision input when an interaction ID is absent.
 */
export function approvalDecisionKey(
  interactionId: string | undefined,
  approvalId: string,
  version: string,
  decision: ApprovalDecision,
  principal: ApprovalPrincipal,
): string {
  const interaction = interactionId?.trim()
  if (interaction) return `discord:${interaction}`
  const digest = createHash("sha256")
    .update(JSON.stringify([approvalId, version, decision, principal.surface, principal.id]))
    .digest("hex")
  return `discord:fallback:${digest}`
}

function cardFields(view: ApprovalNotificationView): NonNullable<CardSpec["fields"]> {
  return [
    { name: "action", value: `${view.kind} · ${view.target}`, inline: true },
    { name: "requested by", value: `${view.requestedBy.surface}:${view.requestedBy.id}`, inline: true },
    { name: "risk", value: view.risk, inline: true },
  ]
}

function renderNotificationApprovalCard(view: ApprovalNotificationView): CardSpec {
  const fields = cardFields(view)
  if (view.state === "pending") {
    return {
      title: "⏳ Approval required",
      body: view.summary,
      fields,
      buttons: [
        {
          customId: approvalCustomId(view.id, "grant", view.version),
          label: "Approve",
          style: "success",
          emoji: "✅",
        },
        {
          customId: approvalCustomId(view.id, "deny", view.version),
          label: "Deny",
          style: "danger",
          emoji: "✋",
        },
      ],
    }
  }

  if (view.state === "denied") {
    return {
      title: "✋ Denied",
      body: `${view.summary}\n\nThis request was denied and did not run.`,
      fields,
      buttons: [],
    }
  }
  if (view.state === "expired") {
    return {
      title: "⌛ Expired",
      body: `${view.summary}\n\nThis request expired and did not run.`,
      fields,
      buttons: [],
    }
  }
  if (view.state === "interrupted") {
    return {
      title: "⚠️ Interrupted",
      body: `${view.summary}\n\nThe approval lifecycle was interrupted fail-closed and did not run.`,
      fields,
      buttons: [],
    }
  }

  if (view.execution === "pending") {
    return {
      title: "✅ Approved · execution in progress",
      body: view.summary,
      fields,
      buttons: [],
    }
  }
  if (view.execution === "succeeded") {
    return {
      title: "✅ Approved · execution succeeded",
      body: view.summary,
      fields,
      buttons: [],
    }
  }
  if (view.execution === "failed") {
    return {
      title: "⚠️ Approved · execution failed",
      body: `${view.summary}\n\nThe approval was granted, but execution failed.`,
      fields,
      buttons: [],
    }
  }
  return {
    title: "⚠️ Approved · execution outcome unknown",
    body: `${view.summary}\n\nThe approval was granted, but the execution outcome is unknown and must not be replayed automatically.`,
    fields,
    buttons: [],
  }
}

// Task 7 removes this bridge after hub/index.ts moves to ApprovalOperationsService.
// Keeping it isolated here lets Task 6 remain typecheckable and safe in the staged
// branch without widening the canonical notification model used above.

/** @deprecated Task 7 replaces this request shape with ApprovalRequestDescriptor. */
export interface ApprovalRequest {
  kind: string
  target: string
  actor: string
  chat?: string
  summary: string
}

/** @deprecated Task 7 replaces this closure with approvalTypes.ApprovalFire. */
export type ApprovalFire = (corr?: string) => void | Promise<void>

/** @deprecated Task 7 removes the in-memory legacy approval lifecycle. */
export type ApprovalState = "pending" | "granted" | "denied" | "expired"

/** @deprecated Task 7 removes the in-memory legacy approval lifecycle. */
export interface PendingApproval extends ApprovalRequest {
  id: string
  createdAt: number
  expiresAt: number
  state: ApprovalState
  fire: ApprovalFire
}

/** @deprecated Task 7 composes HeldApprovalRegistry and ApprovalOperationsService. */
export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>()

  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  request(req: ApprovalRequest, fire: ApprovalFire): PendingApproval {
    const createdAt = this.now()
    const entry: PendingApproval = {
      ...req,
      id: this.genId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      state: "pending",
      fire,
    }
    this.pending.set(entry.id, entry)
    return entry
  }

  get(id: string): PendingApproval | undefined { return this.pending.get(id) }

  resolve(id: string, decision: ApprovalDecision): PendingApproval | null {
    const entry = this.pending.get(id)
    if (!entry || entry.state !== "pending") return null
    entry.state = decision === "grant" ? "granted" : "denied"
    this.pending.delete(id)
    return entry
  }

  sweepExpired(): PendingApproval[] {
    const now = this.now()
    const expired: PendingApproval[] = []
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        entry.state = "expired"
        this.pending.delete(id)
        expired.push(entry)
      }
    }
    return expired
  }

  pendingCount(): number { return this.pending.size }
  list(): PendingApproval[] { return [...this.pending.values()] }
}

function renderLegacyApprovalCard(entry: PendingApproval): CardSpec {
  if (entry.state === "pending") {
    return {
      title: "⏳ Approval required",
      body: entry.summary,
      fields: [
        { name: "action", value: `${entry.kind} · ${entry.target}`, inline: true },
        { name: "requested by", value: entry.actor, inline: true },
      ],
      buttons: [
        {
          customId: approvalCustomId(entry.id, "grant", LEGACY_APPROVAL_VERSION),
          label: "Approve",
          style: "success",
          emoji: "✅",
        },
        {
          customId: approvalCustomId(entry.id, "deny", LEGACY_APPROVAL_VERSION),
          label: "Deny",
          style: "danger",
          emoji: "✋",
        },
      ],
    }
  }
  const title = entry.state === "granted"
    ? "✅ Approved"
    : entry.state === "denied"
      ? "✋ Denied"
      : "⌛ Expired (auto-denied)"
  return { title, body: entry.summary, buttons: [] }
}

export function renderApprovalCard(view: ApprovalNotificationView): CardSpec
/** @deprecated Compatibility overload for hub/index.ts until Task 7. */
export function renderApprovalCard(view: PendingApproval): CardSpec
export function renderApprovalCard(view: ApprovalNotificationView | PendingApproval): CardSpec {
  return "actor" in view ? renderLegacyApprovalCard(view) : renderNotificationApprovalCard(view)
}
