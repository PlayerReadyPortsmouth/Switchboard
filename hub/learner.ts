// The Learner, part 1: NOTICE.
//
// Reads what the hub already records (the audit trail and each conversation's
// message cache) and picks out the turns where something did not go the way the
// person expected. Pure and read-only: it changes no prompt and no allow list.
// Later parts diagnose these misses with a model and propose changes for a
// person to approve.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export type MissKind =
  | "tool_not_allowed"      // the agent asked for a tool that is not on its own allow list
  | "tool_off_in_readyapp"  // not in this person's ReadyApp catalog (switched off, or no permission)
  | "tool_error"            // ReadyApp refused or failed the call
  | "agent_said_cannot"     // the agent told the person it could not see or do something
  | "user_corrected"        // the person's next message corrected the agent
  | "user_rephrased"        // the person asked the same thing again
  | "slow_turn"             // the answer took longer than slowMs
  | "card_cancelled"        // the person cancelled a change the agent proposed
  | "consult_refused"       // one agent was not allowed to ask another

export interface AuditRow {
  ts: number; kind: string; actor?: string; action: string; outcome: string
  target?: string | null; chat?: string | null; detail?: Record<string, unknown> | null
}
export interface ConvRow { role: "user" | "agent"; text: string; ts: number; userId?: string; agent?: string }

export interface Miss {
  ts: number; kind: MissKind; agent: string
  userId?: string; chat?: string; tool?: string; reason?: string
  userText?: string; agentText?: string
}

export interface LearnerOptions { since?: number; slowMs?: number; rephraseWindowMs?: number }

const CANNOT = /\b(i (?:can(?:'|’)?t|cannot|am not able to|'m not able to|’m not able to|don(?:'|’)t have (?:access|a way|a tool))|not visible to me|i can only see|isn(?:'|’)t something i can|no read for)\b/i
const CORRECTION = /^\s*(no\b|nope\b|wrong\b|that(?:'|’)?s (?:not|wrong)|not what i|i (?:meant|said|asked)|try again|you (?:missed|didn(?:'|’)t))/i
const clip = (s: string | undefined, n = 300): string | undefined => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s)
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const userOf = (actor?: string): string | undefined => (actor?.startsWith("user:") ? actor.slice(5) : undefined)

const STOP = new Set(["the", "a", "an", "my", "me", "i", "is", "are", "do", "to", "of", "on", "in", "for", "and", "what", "whats", "can", "you", "please", "hey"])
export function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)))
}
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

/** Misses visible in the audit trail. */
export function missesFromAudit(rows: AuditRow[], opts: LearnerOptions = {}): Miss[] {
  const since = opts.since ?? 0, slowMs = opts.slowMs ?? 45_000
  const out: Miss[] = []
  for (const r of rows) {
    if (r.ts < since) continue
    const d = r.detail ?? {}
    const base = { ts: r.ts, userId: userOf(r.actor) ?? str(d.user), chat: r.chat ?? str(d.chat) }
    const reason = str(d.reason) ?? str(d.code)
    if (r.action === "readyapp.read" || r.action === "readyapp.propose" || r.action === "readyapp.confirm") {
      if (r.outcome !== "deny" && r.outcome !== "error") continue
      if (reason === "no_sole_speaker") continue   // a safety refusal working as designed
      const kind: MissKind = reason === "not_in_agent_scope" ? "tool_not_allowed"
        : reason === "not_in_catalog" || reason === "tool_disabled" || reason === "forbidden" ? "tool_off_in_readyapp"
        : "tool_error"
      out.push({ ...base, kind, agent: str(d.agent) ?? "?", tool: r.target ?? undefined, reason })
    } else if (r.action === "readyapp.cancel" && r.outcome === "ok") {
      out.push({ ...base, kind: "card_cancelled", agent: str(d.agent) ?? "?", tool: r.target ?? undefined })
    } else if (r.kind === "consult" && r.outcome === "deny") {
      out.push({ ...base, kind: "consult_refused", agent: userOf(r.actor) ? "?" : (r.actor ?? "?").replace(/^agent:/, ""), tool: r.target ?? undefined, reason })
    } else if (r.kind === "turn" && typeof d.ms === "number" && d.ms >= slowMs) {
      out.push({ ...base, kind: "slow_turn", agent: r.target ?? "?", reason: `${Math.round(d.ms / 1000)}s` })
    }
  }
  return out
}

/** Misses visible in one conversation's messages. */
export function missesFromConversation(chat: string, rows: ConvRow[], opts: LearnerOptions = {}): Miss[] {
  const since = opts.since ?? 0, window = opts.rephraseWindowMs ?? 10 * 60_000
  const out: Miss[] = []
  let lastUser: ConvRow | undefined, lastAgent: ConvRow | undefined
  for (const r of rows) {
    if (r.role === "agent") {
      if (r.ts >= since && CANNOT.test(r.text)) {
        out.push({ ts: r.ts, kind: "agent_said_cannot", agent: r.agent ?? "?", chat, userId: lastUser?.userId, userText: clip(lastUser?.text), agentText: clip(r.text) })
      }
      lastAgent = r
      continue
    }
    if (r.ts >= since && lastAgent && lastUser && r.userId === lastUser.userId && r.ts - lastAgent.ts <= window) {
      const kind: MissKind | undefined = CORRECTION.test(r.text) ? "user_corrected"
        : similarity(r.text, lastUser.text) >= 0.6 ? "user_rephrased" : undefined
      if (kind) out.push({ ts: r.ts, kind, agent: lastAgent.agent ?? "?", chat, userId: r.userId, userText: clip(`${lastUser.text} → ${r.text}`), agentText: clip(lastAgent.text) })
    }
    lastUser = r
  }
  return out
}

export function collectMisses(audit: AuditRow[], conversations: Record<string, ConvRow[]>, opts: LearnerOptions = {}): Miss[] {
  const all = missesFromAudit(audit, opts)
  for (const [chat, rows] of Object.entries(conversations)) all.push(...missesFromConversation(chat, rows, opts))
  return all.sort((a, b) => a.ts - b.ts)
}

export interface AgentFindings { agent: string; total: number; byKind: Partial<Record<MissKind, number>>; tools: { tool: string; kind: MissKind; count: number }[]; examples: Miss[] }

/** Group by agent: what went wrong how often, and which tools keep coming up. */
export function summariseMisses(misses: Miss[], maxExamples = 5): AgentFindings[] {
  const by = new Map<string, AgentFindings>()
  const toolCounts = new Map<string, Map<string, { tool: string; kind: MissKind; count: number }>>()
  for (const m of misses) {
    let f = by.get(m.agent)
    if (!f) { f = { agent: m.agent, total: 0, byKind: {}, tools: [], examples: [] }; by.set(m.agent, f); toolCounts.set(m.agent, new Map()) }
    f.total++
    f.byKind[m.kind] = (f.byKind[m.kind] ?? 0) + 1
    if (m.tool) {
      const tc = toolCounts.get(m.agent)!, key = `${m.kind}:${m.tool}`
      const e = tc.get(key) ?? { tool: m.tool, kind: m.kind, count: 0 }
      e.count++; tc.set(key, e)
    }
    if (m.userText || m.agentText) { f.examples.push(m); if (f.examples.length > maxExamples) f.examples.shift() }
  }
  for (const f of by.values()) f.tools = [...toolCounts.get(f.agent)!.values()].sort((a, b) => b.count - a.count)
  return [...by.values()].sort((a, b) => b.total - a.total)
}

const LABEL: Record<MissKind, string> = {
  tool_not_allowed: "asked for a tool not on its allow list",
  tool_off_in_readyapp: "tool not available to that person in ReadyApp",
  tool_error: "ReadyApp refused or failed a call",
  agent_said_cannot: "told the person it could not",
  user_corrected: "was corrected by the person",
  user_rephrased: "was asked the same thing again",
  slow_turn: "slow answer",
  card_cancelled: "proposed change was cancelled",
  consult_refused: "was not allowed to ask another agent",
}

export function renderFindings(findings: AgentFindings[]): string {
  if (!findings.length) return "No misses recorded."
  return findings.map(f => {
    const lines = [`${f.agent}: ${f.total} miss${f.total === 1 ? "" : "es"}`]
    for (const [k, n] of Object.entries(f.byKind).sort((a, b) => b[1]! - a[1]!)) lines.push(`- ${n} × ${LABEL[k as MissKind]}`)
    for (const t of f.tools.slice(0, 8)) lines.push(`  · ${t.tool} (${t.kind}, ${t.count})`)
    for (const e of f.examples) lines.push(`  > ${e.kind}: "${(e.userText ?? "").replace(/\s+/g, " ")}" → "${(e.agentText ?? "").replace(/\s+/g, " ").slice(0, 160)}"`)
    return lines.join("\n")
  }).join("\n\n")
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as T) } catch { /* a torn last line */ }
  }
  return out
}

/** Read a hub state directory (audit.jsonl + cache/<chat>.jsonl) and collect its misses. */
export function collectFromStateDir(stateDir: string, opts: LearnerOptions = {}): Miss[] {
  const audit = readJsonl<AuditRow>(join(stateDir, "audit.jsonl"))
  const conversations: Record<string, ConvRow[]> = {}
  const cacheDir = join(stateDir, "cache")
  if (existsSync(cacheDir)) {
    for (const f of readdirSync(cacheDir)) if (f.endsWith(".jsonl")) conversations[f.slice(0, -6)] = readJsonl<ConvRow>(join(cacheDir, f))
  }
  return collectMisses(audit, conversations, opts)
}

// bun hub/learner.ts <stateDir> [hours]
if (import.meta.main) {
  const [dir, hours] = process.argv.slice(2)
  if (!dir) { console.error("usage: bun hub/learner.ts <stateDir> [hours=24]"); process.exit(2) }
  const since = Date.now() - Number(hours ?? 24) * 3600_000
  console.log(renderFindings(summariseMisses(collectFromStateDir(dir, { since }))))
}
