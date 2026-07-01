import type { HubConfig } from "./types"
import type { HubChangeClassification } from "./hubConfigDraft"

export interface HubConfigPreview {
  id: string
  before: HubConfig
  after: HubConfig
  classification: HubChangeClassification
  createdAt: number
  expiresAt: number
}

/** Short-lived staging area for a hub-config edit pending operator confirmation.
 *  A simpler sibling of AgentConfigPreviewRegistry (hub/agentConfigPreview.ts) —
 *  no name key, since there is exactly one hub config (before/after are always
 *  full HubConfig objects, never null; no create/remove variant). Same TTL /
 *  single-shot-consume(expiry-checked) / sweepExpired shape otherwise. */
export class HubConfigPreviewRegistry {
  private pending = new Map<string, HubConfigPreview>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  create(before: HubConfig, after: HubConfig, classification: HubChangeClassification): HubConfigPreview {
    const createdAt = this.now()
    const p: HubConfigPreview = {
      id: this.genId(), before, after, classification,
      createdAt, expiresAt: createdAt + this.ttlMs,
    }
    this.pending.set(p.id, p)
    return p
  }

  get(id: string): HubConfigPreview | undefined {
    return this.pending.get(id)
  }

  /** Single-shot: deletes and returns the preview if present and not expired.
   *  A second consume, or one past expiresAt (even if sweepExpired hasn't run
   *  yet), returns null. */
  consume(id: string): HubConfigPreview | null {
    const p = this.pending.get(id)
    if (!p) return null
    this.pending.delete(id)
    if (p.expiresAt <= this.now()) return null
    return p
  }

  sweepExpired(): HubConfigPreview[] {
    const t = this.now()
    const out: HubConfigPreview[] = []
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= t) { this.pending.delete(id); out.push(p) }
    }
    return out
  }
}
