import { useEffect, useState, type JSX } from "react"
import type { ConversationEvent, ToolStep } from "../types"
import { ActivityItem, turnStateEvents } from "./ActivityItem"
import { useNarrowViewport } from "./useNarrowViewport"

const statusLabels: Record<ToolStep["status"], string> = { running: "running", ok: "ok", error: "error" }

/** Durations read as CLI timings: sub-second in milliseconds, then seconds to one
 *  decimal, then minutes — never more precision than the number deserves. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

/** Where the collapsed/expanded choice is remembered. Session-scoped on purpose: it is a
 *  reading preference for the conversation in front of you, not a durable setting, and it
 *  should not follow someone into next week. */
const SPINE_OPEN_KEY = "switchboard:turn-spine-open"

const readStoredOpen = (): boolean | null => {
  try {
    const stored = sessionStorage.getItem(SPINE_OPEN_KEY)
    return stored === null ? null : stored === "true"
  } catch { return null }  // private mode / storage disabled — fall back to the default
}
const writeStoredOpen = (open: boolean): void => {
  try { sessionStorage.setItem(SPINE_OPEN_KEY, String(open)) } catch { /* preference is best-effort */ }
}

/** The one-line stand-in for the collapsed spine. It has to carry enough that collapsing
 *  costs no *signal*, only detail: how much work happened, whether it is still going, and —
 *  most importantly — whether any of it failed. A failure is an outcome, not process, so it
 *  is named here rather than hidden behind a tap. */
export function summariseSteps(steps: ToolStep[]): string {
  if (!steps.length) return "No tool calls"
  const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`
  const failed = steps.filter(step => step.status === "error").length
  if (failed) return `${count} · ${failed} failed`
  if (steps.some(step => step.status === "running")) return `${count} · running`
  const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
  return total ? `${count} · ${formatDuration(total)}` : count
}

function TurnStepRow({ step }: { step: ToolStep }): JSX.Element {
  // Once a duration is known it takes the status column, so the outcome is carried
  // by colour alone — which screen readers can't see. Name it for them, but only
  // then, or "running" would be announced twice.
  const showsDuration = step.status !== "running" && step.durationMs !== undefined
  return (
    <li className="turn-step" data-status={step.status} data-tool={step.name}>
      <span className="turn-step-node" aria-hidden="true" />
      <span className="turn-step-name">{step.name}</span>
      <span className="turn-step-summary" title={step.summary ?? ""}>{step.summary ?? ""}</span>
      <span className="turn-step-status">
        {showsDuration ? formatDuration(step.durationMs!) : statusLabels[step.status]}
      </span>
      {showsDuration ? <span className="sr-only">{` ${statusLabels[step.status]}`}</span> : null}
    </li>
  )
}

/** The transcript's execution spine: every tool the agent ran this turn, in order,
 *  with the turn's own lifecycle states folded into the same vertical rail. Replaces
 *  the old buried "Live activity" disclosure — the point is to see the work happen.
 *
 *  On a ~390px screen that spine can run past a dozen rows and push the conversation itself
 *  off-screen, so there it collapses to `summariseSteps`'s single line and opens on tap.
 *  Desktop is unchanged: the space is free there and the work is worth seeing by default.
 *  The collapse is a native `<details>`, so the toggle needs no JS and is keyboard-operable
 *  for free; JS only chooses the initial state and remembers a deliberate choice. */
export function TurnSteps({ steps = [], events = [] }: { steps?: ToolStep[]; events?: ConversationEvent[] }): JSX.Element | null {
  const narrow = useNarrowViewport()
  const [open, setOpen] = useState<boolean | null>(null)
  // Read the stored preference after mount rather than during render: sessionStorage is not
  // available while the module is being evaluated in every environment we run in (tests, SSR-
  // shaped tooling), and this keeps the first paint deterministic.
  useEffect(() => { setOpen(readStoredOpen()) }, [])

  const states = turnStateEvents(events)
  if (!steps.length && !states.length) return null

  const spine = (
    <ol className="turn-spine" aria-label="Turn activity">
      {steps.map(step => <TurnStepRow key={step.id} step={step} />)}
      {states.map((event, index) => <ActivityItem key={`${event.sequence}:${event.state}:${index}`} event={event} />)}
    </ol>
  )
  // Wide viewports keep the bare spine — no disclosure wrapper at all, so nothing about the
  // desktop transcript's markup or behaviour changes.
  if (!narrow) return spine

  return (
    <details
      className="turn-spine-disclosure"
      data-region="turn-spine-disclosure"
      open={open ?? false}
      onToggle={event => {
        const next = (event.currentTarget as HTMLDetailsElement).open
        setOpen(next)
        writeStoredOpen(next)
      }}
    >
      <summary className="turn-spine-summary">
        <span className="turn-spine-summary-label">Turn activity</span>
        <span className="turn-spine-summary-detail">{summariseSteps(steps)}</span>
      </summary>
      {spine}
    </details>
  )
}
