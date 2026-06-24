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

/** Resolves a step's awaited outcome: `ok` distinguishes a real reply (true)
 *  from a failure — busy/unavailable/timeout (false). */
type StepResolve = (ok: boolean, output: string) => void

/** Run-and-capture registry for mission steps — the consult primitive applied to
 *  workflows: a step runs on a virtual `mission:<id>` channel; its reply `settle`s
 *  the pending entry (success), while busy/unavailable/timeout `fail` it. Both are
 *  single-shot (first wins, the rest no-op). The engine owns the per-step timeout. */
export class MissionRegistry {
  private byChannel = new Map<string, StepResolve>()
  constructor(private genId: () => string) {}

  open(resolve: StepResolve): { channel: string } {
    const channel = `mission:${this.genId()}`
    this.byChannel.set(channel, resolve)
    return { channel }
  }

  isMissionChannel(channel: string): boolean {
    return this.byChannel.has(channel)
  }

  /** Settle a step with the agent's captured output (success). Single-shot. */
  settle(channel: string, output: string): boolean {
    const resolve = this.byChannel.get(channel)
    if (!resolve) return false
    this.byChannel.delete(channel)
    resolve(true, output)
    return true
  }

  /** Fail a step (busy / unavailable / timed out). Single-shot. */
  fail(channel: string, reason: string): boolean {
    const resolve = this.byChannel.get(channel)
    if (!resolve) return false
    this.byChannel.delete(channel)
    resolve(false, reason)
    return true
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
