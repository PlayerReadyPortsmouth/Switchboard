/** Live status of one agent row on the board. */
export interface AgentStatus {
  name: string
  emoji: string
  mode: "persistent" | "ephemeral"
  alive: boolean
  busy: boolean
  queueDepth: number
  fillPct: number          // 0..1 context fill
  costUsd?: number         // cumulative session cost
  replicas?: number        // >1 when the agent is pooled (increment 5)
  lastActivityMs: number
}

/** A single routing decision by the Haiku resolver. */
export interface RouterEvent { ts: number; conv: string; chosen: string; confidence?: number; switched: boolean }

/** What the overseer / governor is doing to an agent right now. */
export interface OverseerStatus { agent: string; goal: string; round: number; max: number; state: "prodding" | "compacting" }

/** A live ephemeral (spawned) agent. */
export interface EphemeralStatus { jobId: string; agent: string; task: string; startedAt: number }

export interface StatusSnapshot {
  now: number
  agents: AgentStatus[]
  overseers: OverseerStatus[]
  routes: RouterEvent[]      // most-recent-last
  routeRate10m: number       // routes in the last 10 minutes
  ephemerals: EphemeralStatus[]
}

/** In-memory snapshot of everything the hub is doing, fed from the existing hot
 *  paths (replies, routing, spawns) plus a heartbeat. Pure state + reducers; the
 *  StatusBoard renders it. Agent + overseer rows are replaced wholesale by the
 *  heartbeat; routes + ephemerals are event-driven. */
export class StatusRegistry {
  private agents: AgentStatus[] = []
  private overseers: OverseerStatus[] = []
  private routes: RouterEvent[] = []
  private ephemerals = new Map<string, EphemeralStatus>()

  constructor(private routeRing = 10) {}

  setAgents(rows: AgentStatus[]): void { this.agents = rows }
  setOverseers(rows: OverseerStatus[]): void { this.overseers = rows }

  recordRoute(e: RouterEvent): void {
    this.routes.push(e)
    if (this.routes.length > this.routeRing) this.routes.shift()
  }

  setEphemeral(s: EphemeralStatus): void { this.ephemerals.set(s.jobId, s) }
  removeEphemeral(jobId: string): void { this.ephemerals.delete(jobId) }

  snapshot(now: number): StatusSnapshot {
    const cutoff = now - 10 * 60 * 1000
    return {
      now,
      agents: this.agents,
      overseers: this.overseers,
      routes: this.routes,
      routeRate10m: this.routes.filter(r => r.ts >= cutoff).length,
      ephemerals: [...this.ephemerals.values()],
    }
  }
}
