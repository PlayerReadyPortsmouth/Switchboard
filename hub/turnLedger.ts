/** The turn ledger: one audit record per agent turn, answering "who asked, which agent
 *  did the work, what did it touch, and what did it cost".
 *
 *  Before this the ledger could say a message was routed to an agent (`route`) and, in
 *  a separate store with its own retention, which tools an agent ran (`trace`). Nothing
 *  joined a person to the cost of what they asked for. A `turn` record does:
 *
 *    actor   user:<id>            the one person behind the turn
 *            agent:<name>         a colleague's consult (the person is in detail.forUser)
 *            system               a schedule, webhook or workflow step
 *            user:unattributed    more than one person could be behind it (see detail)
 *    target  the agent (registry key) that did the work
 *    cost    USD for THIS turn (the CLI reports a running session total; this is the delta)
 *    detail  tokens in/out/cached, tools used with counts, colleagues consulted,
 *            data tools called, wall time
 *
 *  Metadata only, like the rest of the ledger: never the message or the answer. */
import type { AuditInput, TurnUsage } from "./types"

interface Open { tools: Map<string, number>; consulted: string[]; data: string[] }

export interface TurnClose {
  /** Process key (agent name, or a replica / clone key). */
  key: string
  agent: string
  chat: string
  usage?: TurnUsage
  /** Everyone who could be behind the turn, with when it began. */
  speakers: { userId: string; at?: number }[]
  /** Set when this turn answered a colleague's consult. */
  consultedBy?: string
  /** The person behind the consulting agent's own turn, when exactly one. */
  forUser?: string
}

export class TurnLedger {
  private open = new Map<string, Open>()
  private lastCost = new Map<string, number>()
  constructor(private now: () => number = () => Date.now()) {}

  private get(key: string): Open {
    let o = this.open.get(key)
    if (!o) { o = { tools: new Map(), consulted: [], data: [] }; this.open.set(key, o) }
    return o
  }

  /** The process ran these tools during its current turn. */
  tools(key: string, names: string[]): void {
    const o = this.get(key)
    for (const n of names) o.tools.set(n, (o.tools.get(n) ?? 0) + 1)
  }

  /** The process consulted a colleague during its current turn. */
  consulted(key: string, target: string): void { this.get(key).consulted.push(target) }

  /** The process fetched speaker-scoped records during its current turn. */
  data(key: string, tool: string): void { this.get(key).data.push(tool) }

  /** The turn's reply has arrived: build its ledger record and reset for the next turn. */
  close(c: TurnClose): AuditInput {
    const o = this.open.get(c.key) ?? { tools: new Map(), consulted: [], data: [] }
    this.open.delete(c.key)

    // The CLI reports cumulative session cost. A drop means a fresh session, so the
    // whole figure is this turn's.
    let cost: number | undefined
    if (c.usage?.costUsd !== undefined) {
      const prev = this.lastCost.get(c.key)
      cost = prev !== undefined && c.usage.costUsd >= prev ? c.usage.costUsd - prev : c.usage.costUsd
      cost = Math.round(cost * 1e6) / 1e6
      this.lastCost.set(c.key, c.usage.costUsd)
    }

    const ids = [...new Set(c.speakers.map(s => s.userId))]
    let actor: string
    const detail: Record<string, unknown> = {}
    if (c.consultedBy) {
      actor = `agent:${c.consultedBy}`
      if (c.forUser) detail.forUser = c.forUser
    } else if (ids.length === 1) {
      actor = `user:${ids[0]}`
    } else if (ids.length === 0) {
      actor = "system"
    } else {
      actor = "user:unattributed"
      detail.candidates = ids
    }

    if (c.usage) {
      detail.tokensIn = c.usage.inputTokens
      detail.tokensOut = c.usage.outputTokens
      detail.tokensCacheRead = c.usage.cacheReadTokens
      detail.tokensCacheWrite = c.usage.cacheCreationTokens
    }
    if (o.tools.size) detail.tools = Object.fromEntries(o.tools)
    if (o.consulted.length) detail.consulted = o.consulted
    if (o.data.length) detail.data = o.data
    const began = c.speakers.map(s => s.at).filter((x): x is number => typeof x === "number")
    const ms = c.usage?.durationMs ?? (began.length ? this.now() - Math.min(...began) : undefined)
    if (ms !== undefined) detail.ms = Math.round(ms)
    if (c.key !== c.agent) detail.process = c.key

    return {
      kind: "turn", actor, action: c.consultedBy ? "consult_answer" : "answer",
      target: c.agent, chat: c.chat, outcome: "ok", detail,
      ...(cost !== undefined ? { cost } : {}),
    }
  }
}

// ---- rollup ----------------------------------------------------------------

export interface TurnRow { actor: string; target?: string; cost?: number; detail?: Record<string, unknown> }

interface Tally { turns: number; cost: number; tokensIn: number; tokensOut: number }
const blank = (): Tally => ({ turns: 0, cost: 0, tokensIn: 0, tokensOut: 0 })
const add = (t: Tally, r: TurnRow): void => {
  t.turns++
  t.cost += r.cost ?? 0
  t.tokensIn += Number(r.detail?.tokensIn ?? 0) + Number(r.detail?.tokensCacheRead ?? 0) + Number(r.detail?.tokensCacheWrite ?? 0)
  t.tokensOut += Number(r.detail?.tokensOut ?? 0)
  t.cost = Math.round(t.cost * 1e6) / 1e6   // keep sums of small floats readable
}

/** Usage by person and by agent. A consult's cost is charged to the person it was for
 *  (detail.forUser) when known, so "what did Aurora's questions cost" includes the
 *  colleagues her agent asked. */
export function rollupTurns(rows: TurnRow[]): { byPerson: Record<string, Tally>; byAgent: Record<string, Tally>; total: Tally } {
  const byPerson: Record<string, Tally> = {}, byAgent: Record<string, Tally> = {}
  const total = blank()
  for (const r of rows) {
    const person = r.actor.startsWith("agent:")
      ? (typeof r.detail?.forUser === "string" ? `user:${r.detail.forUser}` : "system")
      : r.actor
    add(byPerson[person] ??= blank(), r)
    add(byAgent[r.target ?? "?"] ??= blank(), r)
    add(total, r)
  }
  return { byPerson, byAgent, total }
}

const money = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`
const k = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)

/** `!usage` output. Person ids are rendered as mentions; the caller must send it with
 *  mentions suppressed so a usage report pings nobody. */
export function renderUsage(rows: TurnRow[], label: string): string {
  if (rows.length === 0) return `**Usage, ${label}**\nNo turns recorded. (Is \`turn\` in audit.kinds?)`
  const { byPerson, byAgent, total } = rollupTurns(rows)
  const line = (name: string, t: Tally) => `${name}: ${t.turns} turn${t.turns === 1 ? "" : "s"}, ${money(t.cost)}, ${k(t.tokensIn)} in / ${k(t.tokensOut)} out`
  const who = (a: string) => a.startsWith("user:") && /^\d+$/.test(a.slice(5)) ? `<@${a.slice(5)}>` : a
  const sorted = (m: Record<string, Tally>) => Object.entries(m).sort((x, y) => y[1].cost - x[1].cost || y[1].turns - x[1].turns)
  return [
    `**Usage, ${label}**: ${total.turns} turns, ${money(total.cost)}`,
    "**By person**",
    ...sorted(byPerson).map(([a, t]) => line(who(a), t)),
    "**By agent**",
    ...sorted(byAgent).map(([a, t]) => line(a, t)),
  ].join("\n")
}

/** `!usage`, `!usage 7` (days), `!usage today`. Null when the text is not this command. */
export function parseUsageCommand(text: string): { days: number } | null {
  const m = /^!usage(?:\s+(\S+))?$/i.exec(text.trim())
  if (!m) return null
  const arg = (m[1] ?? "").toLowerCase()
  if (!arg || arg === "today") return { days: 1 }
  const n = Number(arg.replace(/d$/, ""))
  return Number.isFinite(n) && n > 0 && n <= 90 ? { days: Math.floor(n) } : { days: 1 }
}
