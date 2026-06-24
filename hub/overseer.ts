import type { ClaudeRunner } from "./router"
import type { OverseerPolicy } from "./types"

/** A judge's verdict on a finished turn.
 *  - done    → goal met (or normal chat) → ship it.
 *  - working → concrete work remains → prod the agent on.
 *  - blocked → correctly waiting on a human decision/input → terminal; ship the
 *    reply (it's the question to the human) and DO NOT prod the agent to act alone. */
export type TurnStatus = "done" | "working" | "blocked"
export interface Verdict { status: TurnStatus; reason?: string; nudge?: string }

export function buildJudgePrompt(
  goal: string, conversation: string, latestReply: string,
): { system: string; user: string } {
  const system =
    "You are an overseer judging an agent's latest turn against the user's goal. " +
    'Respond with ONLY JSON: {"status": "done"|"working"|"blocked", "reason": "...", "nudge": "..."}. ' +
    "status=done if the goal is fully met, OR the latest reply is a normal conversational " +
    "answer/question that needs no further work. " +
    "status=working if concrete work remains the agent can do itself — then `nudge` is a " +
    "short, specific instruction for the next step. " +
    "status=blocked ONLY when a human is GENUINELY required: irreversible or destructive " +
    "actions, missing information or credentials only a human has, or a high-stakes/ambiguous " +
    "decision that isn't the agent's to make. " +
    "CRUCIAL: if the agent has merely stopped to ask permission or is being over-cautious " +
    "about something it can reasonably decide itself, do NOT mark it blocked — return " +
    "status=working with a `nudge` telling it to proceed with a sensible default decision " +
    "(stating its assumption) and continue. Default to autonomous progress; reserve blocked " +
    "for real human dependencies. Be strict about real tasks, but never loop on simple Q&A."
  const user =
    `Goal:\n${goal}\n\nRecent conversation:\n${conversation || "(none)"}\n\n` +
    `Agent's latest reply:\n${latestReply}`
  return { system, user }
}

/** Parse the judge's JSON. Accepts `status`, and tolerates a legacy boolean
 *  `done` (true→done, false→working). Returns null when unparseable. */
export function parseJudgeOutput(raw: string): Verdict | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: { status?: unknown; done?: unknown; reason?: unknown; nudge?: unknown }
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  let status: TurnStatus
  if (obj.status === "done" || obj.status === "working" || obj.status === "blocked") status = obj.status
  else if (typeof obj.done === "boolean") status = obj.done ? "done" : "working"
  else return null
  return {
    status,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    nudge: typeof obj.nudge === "string" ? obj.nudge : undefined,
  }
}

export interface OverseerDeps {
  run: ClaudeRunner
  defaultModel: string
  policyFor: (agent: string) => OverseerPolicy | undefined
  /** Deliver a synthesized nudge back to the agent (does not go through routing). */
  deliverNudge: (agent: string, convId: string, text: string) => void
  /** Rendered recent-conversation block, for judge context. */
  recentConversation: (convId: string) => string
  now?: () => number
}

interface Session { goal: string; iterations: number; startedAt: number }

/** The outer agent: for opt-in agents, judge each finished turn against the goal
 *  and re-prod the agent until it's done or hard caps (iterations / wallclock)
 *  are hit. A turn is only judged while a goal session is active for that
 *  (agent, conversation); plain chat that the judge calls "done" never loops. */
export class Overseer {
  private sessions = new Map<string, Session>()
  constructor(private deps: OverseerDeps) {}

  private key(agent: string, convId: string): string { return `${agent}::${convId}` }
  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Active goal sessions, for the status board. */
  snapshot(): { agent: string; convId: string; goal: string; iterations: number }[] {
    return [...this.sessions.entries()].map(([k, s]) => {
      const i = k.indexOf("::")
      return { agent: k.slice(0, i), convId: k.slice(i + 2), goal: s.goal, iterations: s.iterations }
    })
  }

  /** Start (or reset) the goal for an overseen agent — called on each genuine
   *  user-initiated dispatch. No-op for non-overseen agents. */
  begin(agent: string, convId: string, goal: string): void {
    if (!this.deps.policyFor(agent)?.enabled) return
    this.sessions.set(this.key(agent, convId), { goal, iterations: 0, startedAt: this.now() })
  }

  /** Decide what to do with a finished turn's reply. `forward:true` ⇒ send it to
   *  Discord (optionally with a footer); `forward:false` ⇒ swallow it, a nudge
   *  has been delivered and the agent will produce another turn. */
  async intercept(agent: string, convId: string, replyText: string): Promise<{ forward: boolean; footer?: string }> {
    const policy = this.deps.policyFor(agent)
    if (!policy?.enabled) return { forward: true }
    const s = this.sessions.get(this.key(agent, convId))
    if (!s) return { forward: true }                       // no active goal → not overseeing

    const verdict = await this.judge(s.goal, convId, replyText, policy.model ?? this.deps.defaultModel)
    // fail open on garble; done ⇒ ship it; blocked ⇒ ship the question to the human
    // and stop (never prod a blocked agent into acting unilaterally).
    if (!verdict || verdict.status === "done" || verdict.status === "blocked") {
      this.sessions.delete(this.key(agent, convId))
      return { forward: true, footer: verdict?.status === "blocked" ? "⏸ paused — awaiting a human." : undefined }
    }

    const maxIter = policy.maxIterations ?? 4
    const maxWall = policy.maxWallclockMs ?? 600_000
    if (s.iterations >= maxIter || this.now() - s.startedAt > maxWall) {
      this.sessions.delete(this.key(agent, convId))
      return { forward: true, footer: `⏱ overseer stopped after ${s.iterations} round(s).` }
    }
    s.iterations++
    this.deps.deliverNudge(
      agent, convId,
      verdict.nudge?.trim() || "Not done yet — continue until the task is fully complete, then summarise what you did.",
    )
    return { forward: false }
  }

  private async judge(goal: string, convId: string, replyText: string, model: string): Promise<Verdict | null> {
    const { system, user } = buildJudgePrompt(goal, this.deps.recentConversation(convId), replyText)
    try {
      const out = await this.deps.run(
        ["-p", "--model", model, "--append-system-prompt", system, "--output-format", "text"], user,
      )
      return parseJudgeOutput(out)
    } catch { return null }
  }
}
