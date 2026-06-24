import type { StatusSnapshot } from "./statusRegistry"
import type { AuditSummary } from "./types"

export interface MetricsInput {
  now: number
  startedAt: number
  status: StatusSnapshot          // StatusRegistry.snapshot()
  audit: AuditSummary             // AuditLog.summary({})
  pendingApprovals: number        // ApprovalRegistry.pendingCount()
}

export interface HealthReport {
  status: "ok" | "degraded"
  uptimeSec: number
  agents: { name: string; alive: boolean; busy: boolean; queueDepth: number; contextFill: number }[]
  pendingApprovals: number
  routeRate10m: number
}

interface Sample { labels?: Record<string, string>; value: number }

/** Escape a label value per the Prometheus text exposition format. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')
}

function sampleLine(name: string, s: Sample): string {
  if (!s.labels || Object.keys(s.labels).length === 0) return `${name} ${s.value}`
  const labels = Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")
  return `${name}{${labels}} ${s.value}`
}

/** One metric family: HELP + TYPE (all gauges here) + its samples. */
function family(name: string, help: string, samples: Sample[]): string {
  const head = `# HELP ${name} ${help}\n# TYPE ${name} gauge`
  return samples.length ? `${head}\n${samples.map((s) => sampleLine(name, s)).join("\n")}` : head
}

const uptimeSec = (i: MetricsInput): number => Math.max(0, Math.floor((i.now - i.startedAt) / 1000))

/** Project the input into Prometheus text exposition. Pure. */
export function renderPrometheus(i: MetricsInput): string {
  const { status, audit } = i
  const b = (x: boolean): number => (x ? 1 : 0)
  const perAgent = (val: (a: StatusSnapshot["agents"][number]) => number) =>
    status.agents.map((a) => ({ labels: { agent: a.name }, value: val(a) }))

  const blocks = [
    family("switchboard_up", "1 if the hub is serving.", [{ value: 1 }]),
    family("switchboard_uptime_seconds", "Seconds since hub start.", [{ value: uptimeSec(i) }]),
    family("switchboard_agent_alive", "1 if the agent transport is alive.", perAgent((a) => b(a.alive))),
    family("switchboard_agent_busy", "1 if the agent has a turn in flight.", perAgent((a) => b(a.busy))),
    family("switchboard_agent_queue_depth", "Queued turns waiting for the agent.", perAgent((a) => a.queueDepth)),
    family("switchboard_agent_context_fill_ratio", "Context window fill, 0..1.", perAgent((a) => a.fillPct)),
    family("switchboard_agent_cost_usd", "Cumulative session cost (usd).", perAgent((a) => a.costUsd ?? 0)),
    family("switchboard_agent_replicas", "Active replicas for a pooled agent.", perAgent((a) => a.replicas ?? 1)),
    family("switchboard_route_rate_10m", "Routing decisions in the last 10 minutes.", [{ value: status.routeRate10m }]),
    family("switchboard_ephemerals_active", "Live ephemeral (spawned) agents.", [{ value: status.ephemerals.length }]),
    family("switchboard_overseers_active", "Agents under an active overseer/governor.", [{ value: status.overseers.length }]),
    family("switchboard_pending_approvals", "Approvals awaiting a human decision.", [{ value: i.pendingApprovals }]),
    // Ledger gauges: counts over the CURRENT audit.jsonl window (rotation drops
    // history), so these are gauges, not monotonic counters.
    family("switchboard_ledger_events", "Audit events by kind in the current ledger window.",
      Object.entries(audit.byKind).map(([kind, n]) => ({ labels: { kind }, value: n }))),
    family("switchboard_ledger_outcomes", "Audit events by outcome in the current ledger window.",
      Object.entries(audit.byOutcome).map(([outcome, n]) => ({ labels: { outcome }, value: n }))),
    family("switchboard_ledger_cost_usd", "Summed turn cost in the current ledger window (usd).", [{ value: audit.costUsd }]),
  ]
  return blocks.join("\n\n") + "\n"
}

/** Project the input into a health report; `degraded` (→ HTTP 503) when agents
 *  exist but none are alive. Pure. */
export function renderHealth(i: MetricsInput): { ok: boolean; body: HealthReport } {
  const { agents } = i.status
  const degraded = agents.length > 0 && !agents.some((a) => a.alive)
  const body: HealthReport = {
    status: degraded ? "degraded" : "ok",
    uptimeSec: uptimeSec(i),
    agents: agents.map((a) => ({ name: a.name, alive: a.alive, busy: a.busy, queueDepth: a.queueDepth, contextFill: a.fillPct })),
    pendingApprovals: i.pendingApprovals,
    routeRate10m: i.status.routeRate10m,
  }
  return { ok: !degraded, body }
}
