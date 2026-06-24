import type { GovernorPolicy, TurnUsage } from "./types"
import { contextTokens } from "./usage"

/** What the hub should do with a finished turn after the governor inspects it. */
export interface GovernorDecision {
  forward: boolean          // send this reply to Discord? (false ⇒ governor swallowed it)
  footer?: string           // optional note appended to a forwarded reply
  suppressOverseer?: boolean // don't let the prod-loop add a turn while compacting
}

export interface SessionGovernorDeps {
  policyFor: (agent: string) => GovernorPolicy | undefined
  /** Context window (tokens) for the agent's model. */
  windowFor: (agent: string) => number
  /** Synthesized system message → the agent (checkpoint nudge / handoff request). */
  deliver: (agent: string, convId: string, text: string) => void
  /** Plain note → Discord (the compaction notice). */
  notify: (convId: string, text: string) => void
  /** Drop + respawn the agent's session (resetAgentSession). */
  reset: (agent: string, convId: string) => Promise<void>
  /** Record the handoff into the conversation cache (continuity trace + distiller). */
  recordHandoff: (agent: string, convId: string, summary: string) => void
  now?: () => number
}

const DEFAULT_SOFT = 0.75
const DEFAULT_HARD = 0.90

const HANDOFF_REQUEST =
  "⚠️ You are near your context limit. Reply with a concise handoff (≤200 words): the current " +
  "task, what is already done, and the exact next step. Do not do any other work — just the handoff."

function checkpointNudge(pct: number): string {
  return `You're at ~${pct}% of your context window. Save anything important now with the ` +
    "`remember` tool, finish the current step, and avoid starting large new file reads."
}

interface GovSession { phase: "normal" | "awaiting-handoff"; softNotified: boolean }

/** Keeps a persistent agent's context bounded. On each finished turn it reads the
 *  turn's token usage; at a soft threshold it nudges the agent to checkpoint to
 *  memory, and at a hard threshold it runs an orchestrated compaction: ask for a
 *  handoff summary, persist it, reset the session, and seed the fresh one with the
 *  handoff. Opt-in per agent; a no-op without usage or a policy. */
export class SessionGovernor {
  private sessions = new Map<string, GovSession>()
  private pendingSeed = new Map<string, string>()
  constructor(private deps: SessionGovernorDeps) {}

  private key(agent: string, convId: string): string { return `${agent}::${convId}` }
  private session(key: string): GovSession {
    let s = this.sessions.get(key)
    if (!s) { s = { phase: "normal", softNotified: false }; this.sessions.set(key, s) }
    return s
  }

  /** Inspect a finished turn. `usage` absent (e.g. a card-only turn) ⇒ no-op. */
  async observe(agent: string, convId: string, _replyText: string, usage?: TurnUsage): Promise<GovernorDecision> {
    const policy = this.deps.policyFor(agent)
    if (!policy?.enabled || !usage) return { forward: true }
    const window = this.deps.windowFor(agent)
    const fill = window > 0 ? contextTokens(usage) / window : 0
    const pct = Math.round(fill * 100)
    const soft = policy.softPct ?? DEFAULT_SOFT
    const hard = policy.hardPct ?? DEFAULT_HARD
    const key = this.key(agent, convId)
    const s = this.session(key)

    // The reply we were waiting for IS the handoff summary: persist, seed, reset.
    if (s.phase === "awaiting-handoff") {
      const summary = _replyText.trim()
      if (summary) {
        this.deps.recordHandoff(agent, convId, summary)
        this.pendingSeed.set(key, summary)
      }
      this.sessions.delete(key)              // fresh session ⇒ fresh governor state
      await this.deps.reset(agent, convId)
      this.deps.notify(convId, "🧹 Context compacted — fresh session (handoff carried over).")
      return { forward: false, suppressOverseer: true }
    }

    if (fill >= hard) {
      s.phase = "awaiting-handoff"
      this.deps.deliver(agent, convId, HANDOFF_REQUEST)
      return { forward: true, suppressOverseer: true, footer: `⚠️ ~${pct}% context — compacting after this.` }
    }

    if (fill >= soft) {
      if (!s.softNotified) { s.softNotified = true; this.deps.deliver(agent, convId, checkpointNudge(pct)) }
      return { forward: true }               // soft is silent to the user
    }

    s.softNotified = false                    // dropped back below soft ⇒ re-arm
    return { forward: true }
  }

  /** Take (and clear) a pending post-compaction handoff to seed the next dispatch. */
  takeSeed(agent: string, convId: string): string | null {
    const k = this.key(agent, convId)
    const v = this.pendingSeed.get(k) ?? null
    if (v != null) this.pendingSeed.delete(k)
    return v
  }

  /** True while a compaction handoff is in flight — used to suppress the overseer. */
  isCompacting(agent: string, convId: string): boolean {
    return this.sessions.get(this.key(agent, convId))?.phase === "awaiting-handoff"
  }
}
