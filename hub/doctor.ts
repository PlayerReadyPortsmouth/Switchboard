/** `!doctor` — a hub self-check. Gathers a handful of facts about the running
 *  hub (agent liveness, state-dir writability, router config, pending approvals,
 *  logging switches) and turns them into a pass/warn/fail report. The fact-gather
 *  lives in index.ts; this module is the pure derivation + renderer so it's fully
 *  testable. */

export type CheckStatus = "ok" | "warn" | "fail"

export interface DoctorFacts {
  agents: { name: string; alive: boolean; registered: boolean }[]
  stateDirWritable: boolean
  pendingApprovals: number
  auditEnabled: boolean
  traceEnabled: boolean
  routerModel?: string
}

export interface DoctorCheck { name: string; status: CheckStatus; detail: string }
export interface DoctorReport { status: CheckStatus; checks: DoctorCheck[] }

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 }
function worst(a: CheckStatus, b: CheckStatus): CheckStatus { return RANK[a] >= RANK[b] ? a : b }

/** Derive the report from gathered facts. Overall status = the worst check. */
export function runDoctor(facts: DoctorFacts): DoctorReport {
  const checks: DoctorCheck[] = []

  for (const a of facts.agents) {
    if (a.alive) checks.push({ name: `agent:${a.name}`, status: "ok", detail: "alive" })
    else if (a.registered) checks.push({ name: `agent:${a.name}`, status: "fail", detail: "registered but not available" })
    else checks.push({ name: `agent:${a.name}`, status: "warn", detail: "not yet registered" })
  }

  checks.push(facts.stateDirWritable
    ? { name: "state dir", status: "ok", detail: "writable" }
    : { name: "state dir", status: "fail", detail: "not writable" })

  checks.push(facts.routerModel
    ? { name: "router model", status: "ok", detail: facts.routerModel }
    : { name: "router model", status: "warn", detail: "not configured" })

  checks.push({ name: "audit log", status: "ok", detail: facts.auditEnabled ? "on" : "off" })
  checks.push({ name: "turn trace", status: "ok", detail: facts.traceEnabled ? "on" : "off" })
  checks.push({ name: "pending approvals", status: "ok", detail: String(facts.pendingApprovals) })

  const status = checks.reduce<CheckStatus>((acc, c) => worst(acc, c.status), "ok")
  return { status, checks }
}

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌" }

/** Render a report as a header line plus one line per check. */
export function renderDoctor(report: DoctorReport): string {
  const head = `${ICON[report.status]} **doctor: ${report.status}**`
  const lines = report.checks.map((c) => `${ICON[c.status]} ${c.name} — ${c.detail}`)
  return [head, ...lines].join("\n")
}
