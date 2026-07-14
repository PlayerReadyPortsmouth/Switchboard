import type { AgentConfig } from "./types"
import type { AgentChangeClassification } from "./agentConfigDraft"

export interface AgentConfigPreview {
  id: string
  actor: string
  agentName: string
  beforeVersion: string
  before: AgentConfig | null
  after: AgentConfig | null
  classification: AgentChangeClassification
  createdAt: number
  expiresAt: number
}

export function agentConfigPreviewMissState(
  preview: AgentConfigPreview | undefined,
  actor: string,
  agentName: string,
  liveVersion: string,
  now: number,
): "conflict" | "not_found" {
  return preview !== undefined
    && preview.expiresAt > now
    && preview.actor === actor
    && preview.agentName === agentName
    && preview.beforeVersion !== liveVersion
    ? "conflict"
    : "not_found"
}

/** Short-lived staging area for an agent-config edit pending operator confirmation.
 *  A sibling of ApprovalRegistry, not a reuse of it — a preview is a self-serve
 *  "are you sure" for the SAME operator's own pending edit (no separate approver
 *  identity, no `fire` callback), different enough to blur both if forced together.
 *  Unlike ApprovalRegistry.resolve, `consume` checks expiry directly (not just
 *  presence) — a stale-but-unswept preview must never silently confirm. */
export class AgentConfigPreviewRegistry {
  private pending = new Map<string, AgentConfigPreview>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  create(
    actor: string, agentName: string, beforeVersion: string,
    before: AgentConfig | null, after: AgentConfig | null,
    classification: AgentChangeClassification,
  ): AgentConfigPreview {
    const createdAt = this.now()
    const p: AgentConfigPreview = {
      id: this.genId(), actor, agentName, beforeVersion, before, after, classification,
      createdAt, expiresAt: createdAt + this.ttlMs,
    }
    this.pending.set(p.id, p)
    return p
  }

  get(id: string): AgentConfigPreview | undefined {
    return this.pending.get(id)
  }

  /** Single-shot: deletes and returns the preview if present and not expired.
   *  A second consume, or one past expiresAt (even if sweepExpired hasn't run
   *  yet), returns null. */
  consume(id: string, actor: string, agentName: string, liveVersion: string): AgentConfigPreview | null {
    const p = this.pending.get(id)
    if (!p) return null
    this.pending.delete(id)
    if (p.expiresAt <= this.now()) return null
    if (p.actor !== actor || p.agentName !== agentName || p.beforeVersion !== liveVersion) return null
    return p
  }

  sweepExpired(): AgentConfigPreview[] {
    const t = this.now()
    const out: AgentConfigPreview[] = []
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= t) { this.pending.delete(id); out.push(p) }
    }
    return out
  }
}
