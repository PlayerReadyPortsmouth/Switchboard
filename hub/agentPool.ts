import type { AgentReply, AgentTurnOutcome, InboundMessage, SendOutcome, TurnUsage } from "./types"
import type { AgentTransport } from "./transports/index"

/** The slice of a transport the pool drives. StreamJsonTransport satisfies it. */
export interface PooledReplica {
  readonly name: string
  deliver(chatKey: string, inbound: InboundMessage): boolean | void
  onReply(cb: (r: AgentReply) => void | Promise<void | SendOutcome>): void
  onTurnOutcome?(cb: (outcome: AgentTurnOutcome) => void | Promise<void>): void
  isAvailable(): boolean
  isBusy(): boolean
  queueDepth(): number
  fillPct(windows?: Record<string, number>): number
  lastUsageInfo(): TurnUsage | null
  lastActivityMs(): number
  sendInteraction(customId: string, userId: string, fields?: Record<string, string>): void
  close(): Promise<void>
}

export interface ScaleCfg {
  min: number
  max: number
  scaleUpQueue: number      // total queued across replicas that signals pressure
  scaleUpSustainMs: number  // pressure must hold this long before scaling up
  replicaIdleMs: number     // idle this long ⇒ a spare replica may scale down
}

export interface ReplicaLoad { alive: boolean; busy: boolean; queueDepth: number }

/** Least-loaded ALIVE replica: prefer an idle one, then the shortest queue.
 *  Returns -1 when none are alive. Pure. */
export function pickIndex(loads: ReplicaLoad[]): number {
  let best = -1, bestScore = Infinity
  loads.forEach((l, i) => {
    if (!l.alive) return
    const score = (l.busy ? 1_000_000 : 0) + l.queueDepth
    if (score < bestScore) { bestScore = score; best = i }
  })
  return best
}

/** True when every alive replica is busy, the total queue has crossed the
 *  threshold, and we're still under the replica cap. Pure. */
export function underPressure(loads: ReplicaLoad[], cfg: ScaleCfg): boolean {
  const alive = loads.filter(l => l.alive)
  if (alive.length === 0 || alive.length >= cfg.max) return false
  const totalQ = alive.reduce((s, l) => s + l.queueDepth, 0)
  return alive.every(l => l.busy) && totalQ >= cfg.scaleUpQueue
}

/** True when pressure has been sustained long enough to add a replica. Pure. */
export function scaleUpReady(loads: ReplicaLoad[], cfg: ScaleCfg, pressureSince: number | null, now: number): boolean {
  return underPressure(loads, cfg) && pressureSince != null && (now - pressureSince) >= cfg.scaleUpSustainMs
}

export interface ReplicaDownState { alive: boolean; busy: boolean; primary: boolean; stickyCount: number; idleMs: number }

/** Index of a non-primary, idle, unbound, not-busy replica to retire (or -1).
 *  Never drops below `min`, never the primary, never one mid-turn or with sticky
 *  conversations. Pure. */
export function scaleDownIndex(reps: ReplicaDownState[], cfg: ScaleCfg): number {
  if (reps.filter(r => r.alive).length <= cfg.min) return -1
  return reps.findIndex(r =>
    r.alive && !r.primary && !r.busy && r.stickyCount === 0 && r.idleMs >= cfg.replicaIdleMs)
}

export interface ReplicaPoolDeps extends ScaleCfg {
  /** Spawn (and start) a fresh replica transport under `replicaKey`. */
  spawn: (replicaKey: string) => Promise<PooledReplica>
  now?: () => number
}

/** A logical persistent agent backed by 1..N replicas. Conversations stick to a
 *  replica (context continuity); new conversations load-balance, and sustained
 *  queue pressure spins up another replica (idle ones retire). Implements the
 *  transport surface so it drops into the dispatcher + status board in place of a
 *  single transport. Opt-in per agent — absent ⇒ a plain single transport. */
export class ReplicaPool implements AgentTransport {
  private replicas: PooledReplica[]
  private sticky = new Map<string, PooledReplica>()   // chatKey → replica
  private replyCb: (r: AgentReply) => void | Promise<void | SendOutcome> = () => {}
  private outcomeCb: (outcome: AgentTurnOutcome) => void | Promise<void> = () => {}
  private pressureSince: number | null = null
  private scaling = false

  constructor(readonly name: string, primary: PooledReplica, private deps: ReplicaPoolDeps) {
    this.replicas = [primary]
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private loads(): ReplicaLoad[] {
    return this.replicas.map(r => ({ alive: r.isAvailable(), busy: r.isBusy(), queueDepth: r.queueDepth() }))
  }
  private stickyCount(r: PooledReplica): number {
    let n = 0; for (const v of this.sticky.values()) if (v === r) n++; return n
  }

  onReply(cb: (r: AgentReply) => void | Promise<void | SendOutcome>): void {
    this.replyCb = cb
    for (const r of this.replicas) r.onReply(rr => this.replyCb(rr))
  }

  onTurnOutcome(cb: (outcome: AgentTurnOutcome) => void | Promise<void>): void {
    this.outcomeCb = cb
    for (const r of this.replicas) r.onTurnOutcome?.(outcome => this.outcomeCb(outcome))
  }

  deliver(chatKey: string, inbound: InboundMessage): boolean {
    let r = this.sticky.get(chatKey)
    if (!r || !r.isAvailable()) {
      const idx = pickIndex(this.loads())
      r = idx >= 0 ? this.replicas[idx]! : this.replicas[0]!
      this.sticky.set(chatKey, r)
    }
    return r.deliver(chatKey, inbound) !== false
  }

  /** Periodic load check: scale up under sustained pressure, retire idle spares. */
  async tick(): Promise<void> {
    if (this.scaling) return
    const now = this.now()
    const loads = this.loads()
    this.pressureSince = underPressure(loads, this.deps) ? (this.pressureSince ?? now) : null
    if (scaleUpReady(loads, this.deps, this.pressureSince, now)) { await this.scaleUp(); return }
    const down = this.replicas.map((r, i) => ({
      alive: r.isAvailable(), busy: r.isBusy(), primary: i === 0,
      stickyCount: this.stickyCount(r), idleMs: now - r.lastActivityMs(),
    }))
    const idx = scaleDownIndex(down, this.deps)
    if (idx >= 0) await this.scaleDown(idx)
  }

  private async scaleUp(): Promise<void> {
    if (this.replicas.length >= this.deps.max) return
    this.scaling = true
    try {
      const t = await this.deps.spawn(`${this.name}#${this.replicas.length + 1}`)
      t.onReply(r => this.replyCb(r))
      t.onTurnOutcome?.(outcome => this.outcomeCb(outcome))
      this.replicas.push(t)
      this.pressureSince = null   // cooldown after adding capacity
    } finally { this.scaling = false }
  }

  private async scaleDown(idx: number): Promise<void> {
    if (idx <= 0 || idx >= this.replicas.length) return
    const [r] = this.replicas.splice(idx, 1)
    if (!r) return
    for (const [k, v] of this.sticky) if (v === r) this.sticky.delete(k)
    await r.close()
  }

  // --- transport surface (aggregate across replicas) ---
  isAvailable(): boolean { return this.replicas.some(r => r.isAvailable()) }
  isBusy(): boolean { return this.replicas.some(r => r.isBusy()) }
  queueDepth(): number { return this.replicas.reduce((s, r) => s + r.queueDepth(), 0) }
  fillPct(windows?: Record<string, number>): number { return Math.max(0, ...this.replicas.map(r => r.fillPct(windows))) }
  lastUsageInfo(): TurnUsage | null { return this.replicas[0]?.lastUsageInfo() ?? null }
  lastActivityMs(): number { return Math.max(0, ...this.replicas.map(r => r.lastActivityMs())) }
  /** Card interactions route to the primary replica (v1 limitation). */
  sendInteraction(customId: string, userId: string, fields?: Record<string, string>): void {
    this.replicas[0]?.sendInteraction(customId, userId, fields)
  }
  replicaCount(): number { return this.replicas.filter(r => r.isAvailable()).length }
  async close(): Promise<void> { await Promise.all(this.replicas.map(r => r.close())) }
}
