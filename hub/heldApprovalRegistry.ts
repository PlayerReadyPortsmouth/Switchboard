import type { ApprovalFire } from "./approvalTypes"

export interface HeldApproval { fingerprint: string; fire: ApprovalFire }

export class HeldApprovalRegistry {
  private readonly held = new Map<string, HeldApproval>()

  activate(id: string, fingerprint: string, fire: ApprovalFire): void {
    if (this.held.has(id)) throw new Error("held_effect_exists")
    this.held.set(id, Object.freeze({ fingerprint, fire }))
  }

  consume(id: string): HeldApproval | null {
    const value = this.held.get(id) ?? null
    if (value) this.held.delete(id)
    return value
  }

  discard(id: string): boolean { return this.held.delete(id) }
  has(id: string): boolean { return this.held.has(id) }
}
