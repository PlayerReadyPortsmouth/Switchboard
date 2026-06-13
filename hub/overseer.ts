import type { ClaudeRunner } from "./router"
import type { OverseerPolicy } from "./types"

/** A judge's verdict on whether the agent has finished the goal. */
export interface Verdict { done: boolean; reason?: string; nudge?: string }

export function buildJudgePrompt(
  goal: string, conversation: string, latestReply: string,
): { system: string; user: string } {
  const system =
    "You are an overseer judging whether an agent has FULLY completed the user's goal. " +
    'Respond with ONLY JSON: {"done": <bool>, "reason": "...", "nudge": "..."}. ' +
    "done=true if the goal is fully met, OR the latest reply is a normal conversational " +
    "answer / question that needs no further work. done=false ONLY if concrete work " +
    "clearly remains. When done=false, `nudge` is a short, specific instruction telling " +
    "the agent exactly what to finish next. Be strict about real tasks, but never loop on " +
    "simple Q&A or chit-chat."
  const user =
    `Goal:\n${goal}\n\nRecent conversation:\n${conversation || "(none)"}\n\n` +
    `Agent's latest reply:\n${latestReply}`
  return { system, user }
}

/** Parse the judge's JSON. Returns null when unparseable / missing `done`. */
export function parseJudgeOutput(raw: string): Verdict | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: { done?: unknown; reason?: unknown; nudge?: unknown }
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (typeof obj.done !== "boolean") return null
  return {
    done: obj.done,
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
    if (!verdict || verdict.done) {                        // fail open on garble; done ⇒ ship it
      this.sessions.delete(this.key(agent, convId))
      return { forward: true }
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
