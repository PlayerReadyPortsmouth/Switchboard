import type { JSX } from "react"
import type { ConversationEvent, ToolStep } from "../types"
import { ActivityItem, turnStateEvents } from "./ActivityItem"

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
 *  the old buried "Live activity" disclosure — the point is to see the work happen. */
export function TurnSteps({ steps = [], events = [] }: { steps?: ToolStep[]; events?: ConversationEvent[] }): JSX.Element | null {
  const states = turnStateEvents(events)
  if (!steps.length && !states.length) return null
  return (
    <ol className="turn-spine" aria-label="Turn activity">
      {steps.map(step => <TurnStepRow key={step.id} step={step} />)}
      {states.map((event, index) => <ActivityItem key={`${event.sequence}:${event.state}:${index}`} event={event} />)}
    </ol>
  )
}
