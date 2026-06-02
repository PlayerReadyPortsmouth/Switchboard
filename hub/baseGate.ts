import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"
import { randomBytes } from "crypto"

export type DmPolicy = "pairing" | "allowlist" | "disabled"
export interface PendingPair { senderId: string; chatId: string; expiresAt: number }
export interface BaseAccess {
  dmPolicy: DmPolicy
  allowFrom: string[]
  groups: string[]                       // opted-in guild channel ids
  pending: Record<string, PendingPair>   // code → pending
}
export type GateResult =
  | { action: "deliver" }
  | { action: "drop" }
  | { action: "pair"; code: string }

const PAIR_TTL_MS = 60 * 60 * 1000
const MAX_PENDING = 3

function defaults(): BaseAccess {
  return { dmPolicy: "pairing", allowFrom: [], groups: [], pending: {} }
}

/** Layer-0 access wall. Re-reads access.json on every gate() call for live edits. */
export class BaseGate {
  constructor(private path: string) {}

  private read(): BaseAccess {
    try {
      const p = JSON.parse(readFileSync(this.path, "utf8")) as Partial<BaseAccess>
      return {
        dmPolicy: p.dmPolicy ?? "pairing",
        allowFrom: p.allowFrom ?? [],
        groups: p.groups ?? [],
        pending: p.pending ?? {},
      }
    } catch { return defaults() }
  }

  private write(a: BaseAccess): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + ".tmp"
    writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  gate(userId: string, chatId: string, isDM: boolean, nowMs: number): GateResult {
    const a = this.read()
    // prune expired pending
    let changed = false
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < nowMs) { delete a.pending[code]; changed = true }
    }

    if (a.dmPolicy === "disabled") { if (changed) this.write(a); return { action: "drop" } }

    if (!isDM) {
      if (changed) this.write(a)
      return a.groups.includes(chatId) ? { action: "deliver" } : { action: "drop" }
    }

    if (a.allowFrom.includes(userId)) { if (changed) this.write(a); return { action: "deliver" } }
    if (a.dmPolicy === "allowlist") { if (changed) this.write(a); return { action: "drop" } }

    // pairing mode — reuse an existing code for this sender if present
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.senderId === userId) { if (changed) this.write(a); return { action: "pair", code } }
    }
    if (Object.keys(a.pending).length >= MAX_PENDING) { if (changed) this.write(a); return { action: "drop" } }

    const code = randomBytes(3).toString("hex")
    a.pending[code] = { senderId: userId, chatId, expiresAt: nowMs + PAIR_TTL_MS }
    this.write(a)
    return { action: "pair", code }
  }

  /** Current allowlisted user snowflakes (read live from access.json). */
  listAllowed(): string[] {
    return this.read().allowFrom
  }

  /** Approve a pending code: add the sender to allowFrom. Returns the pairing context. */
  approve(code: string, _nowMs: number): { senderId: string; chatId: string } | null {
    const a = this.read()
    const p = a.pending[code]
    if (!p) return null
    if (!a.allowFrom.includes(p.senderId)) a.allowFrom.push(p.senderId)
    delete a.pending[code]
    this.write(a)
    return { senderId: p.senderId, chatId: p.chatId }
  }
}
