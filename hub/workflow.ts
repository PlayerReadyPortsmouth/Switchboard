import type { CardSpec, WorkflowRoute } from "./types"

/** Interpolate a step prompt: `{{input}}` → the run input, `{{steps.<id>}}` → a
 *  prior step's captured output (missing ⇒ ""). Other `{{…}}` are left intact. Pure. */
export function renderStepPrompt(template: string, ctx: { input: string; steps: Record<string, string> }): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, ctx.input)
    .replace(/\{\{\s*steps\.([\w-]+)\s*\}\}/g, (_, id: string) => ctx.steps[id] ?? "")
}

export function findWorkflow(workflows: WorkflowRoute[], id: string): WorkflowRoute | undefined {
  return workflows.find((w) => w.id === id)
}

interface PendingStep {
  id: string
  channel: string                    // the virtual channel "mission:<id>"
  label: string                      // "<workflowId>:<stepId>" for tracing
  agent: string
  createdAt: number
  expiresAt: number
  resolve: (output: string) => void  // resolves the step's awaited output
}

/** Run-and-capture registry for mission steps — the consult primitive applied to
 *  workflows: a step runs on a virtual `mission:<id>` channel, its reply settles
 *  the pending entry, stragglers are TTL-swept. Deterministic (injected now/genId). */
export class MissionRegistry {
  private byChannel = new Map<string, PendingStep>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  open(label: string, agent: string, resolve: (output: string) => void): { id: string; channel: string } {
    const id = this.genId()
    const channel = `mission:${id}`
    const createdAt = this.now()
    this.byChannel.set(channel, { id, channel, label, agent, createdAt, expiresAt: createdAt + this.ttlMs, resolve })
    return { id, channel }
  }

  isMissionChannel(channel: string): boolean {
    return this.byChannel.has(channel)
  }

  /** Settle a step with the agent's captured output. Single-shot. */
  settle(channel: string, output: string): boolean {
    const e = this.byChannel.get(channel)
    if (!e) return false
    this.byChannel.delete(channel)
    e.resolve(output)
    return true
  }

  /** Past-deadline steps, removed and returned so the caller resolves each with a
   *  timeout note (and fails the run). */
  sweepExpired(): PendingStep[] {
    const t = this.now()
    const out: PendingStep[] = []
    for (const [channel, e] of this.byChannel) {
      if (e.expiresAt <= t) { this.byChannel.delete(channel); out.push(e) }
    }
    return out
  }
}

export type StepState = "pending" | "running" | "done" | "failed"

/** A run's live state — the engine mutates it and re-renders the card. */
export interface MissionRun {
  runId: string
  workflowId: string
  input: string
  chatId: string
  steps: { id: string; agent: string; state: StepState; output?: string }[]
  state: "running" | "done" | "failed"
}

const GLYPH: Record<StepState, string> = { pending: "⏳", running: "🔄", done: "✅", failed: "❌" }
const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/** Render the live mission progress card: a row per step (glyph · id · agent ·
 *  truncated output) and a title that reflects the run state. Pure. */
export function renderMissionCard(run: MissionRun): CardSpec {
  const rows = run.steps.map((s) => {
    const out = s.output ? ` — ${oneLine(s.output, 80)}` : ""
    return `${GLYPH[s.state]} **${s.id}** \`${s.agent}\`${out}`
  })
  const head = run.state === "done" ? "✅" : run.state === "failed" ? "❌" : "🔄"
  return {
    title: `${head} mission: ${run.workflowId}`,
    body: rows.join("\n") || "(no steps)",
    buttons: [],
    footer: `input: ${oneLine(run.input, 80)}`,
  }
}
