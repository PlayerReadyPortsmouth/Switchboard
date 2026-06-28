import type { CardSpec } from "./types"
import type { AgentStatus, StatusSnapshot } from "./statusRegistry"

function pct(f: number): string { return `${Math.round(Math.max(0, f) * 100)}%` }
function ageStr(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`
}

/** One persistent-agent line: `🤖 assistant  ● busy  ctx 62%  q:2  $0.04  ×2`. */
export function agentLine(a: AgentStatus): string {
  const dot = !a.alive ? "✖ offline" : a.busy ? "● busy" : "○ idle"
  const parts = [`${a.emoji} **${a.name}**`, dot, `ctx ${pct(a.fillPct)}`]
  if (a.queueDepth > 0) parts.push(`q:${a.queueDepth}`)
  if (typeof a.costUsd === "number") parts.push(`$${a.costUsd.toFixed(2)}`)
  if (a.replicas && a.replicas > 1) parts.push(`×${a.replicas}`)
  if (a.busy && a.currentTool) parts.push(`⚙ ${a.currentTool}`)
  else if (!a.busy && a.lastTool?.error) parts.push(`⚠ ${a.lastTool.name} failed`)
  return parts.join("  ")
}

/** Render the whole snapshot to a single Discord embed (CardSpec). Pure. */
export function renderBoard(s: StatusSnapshot): CardSpec {
  const fields: NonNullable<CardSpec["fields"]> = []

  const persistent = s.agents.filter(a => a.mode === "persistent")
  fields.push({
    name: "Persistent agents",
    value: persistent.length ? persistent.map(agentLine).join("\n") : "_none_",
  })

  if (s.overseers.length) {
    fields.push({
      name: "Overseer",
      value: s.overseers.map(o =>
        o.state === "compacting"
          ? `${o.agent} → 🧹 compacting context`
          : `${o.agent} → "${o.goal.slice(0, 80)}" (round ${o.round}/${o.max})`,
      ).join("\n"),
    })
  }

  const last = s.routes[s.routes.length - 1]
  fields.push({
    name: "Router (haiku)",
    value: last
      ? `last: ${last.chosen}${last.switched ? " (switched)" : ""}` +
        `${typeof last.confidence === "number" ? ` ${last.confidence.toFixed(2)}` : ""}` +
        ` · ${s.routeRate10m} routes/10m`
      : `idle · ${s.routeRate10m} routes/10m`,
  })

  if (s.ephemerals.length) {
    fields.push({
      name: "Ephemeral agents",
      value: s.ephemerals.map(e =>
        `⚡ ${e.agent} \`${e.jobId}\` ${e.task.slice(0, 48)} (${ageStr(s.now - e.startedAt)})`,
      ).join("\n"),
    })
  }

  const t = new Date(s.now).toISOString().slice(11, 19)
  return { title: "📡 Switchboard — live", body: "", fields, buttons: [], footer: `updated ${t} UTC` }
}

/** Minimum-interval emitter: collapses a burst of update requests into at most
 *  one emit per `intervalMs`. Pure + deterministic (caller supplies `now`). */
export class Throttle {
  private last = -Infinity
  private scheduled = false
  constructor(private intervalMs: number) {}

  /** `emit:true` ⇒ flush now. Otherwise, if `scheduleInMs` is set, the caller
   *  should arm a single deferred flush; a `request` while one is pending is a
   *  no-op (the pending flush will use the freshest snapshot). */
  request(now: number): { emit: boolean; scheduleInMs?: number } {
    if (this.scheduled) return { emit: false }
    const since = now - this.last
    if (since >= this.intervalMs) { this.last = now; return { emit: true } }
    this.scheduled = true
    return { emit: false, scheduleInMs: this.intervalMs - since }
  }

  /** Call when a scheduled flush actually fires. */
  fire(now: number): void { this.last = now; this.scheduled = false }
}
