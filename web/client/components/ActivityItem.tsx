import type { ConversationEvent, MessageState } from "../types"

const labels: Partial<Record<MessageState, string>> = {
  queued: "Queued", working: "Working", streaming: "Streaming", completed: "Completed", failed: "Failed",
}

export function ActivityItem({ event }: { event: ConversationEvent }) {
  const state = event.state && labels[event.state] ? event.state : null
  if (!state) return null
  return (
    <li className={`activity-item activity-${state}`} data-activity-announcement={state}>
      <span className="activity-node" aria-hidden="true" />
      <span>{labels[state]}</span>
      <time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </li>
  )
}

/** The turn_state events worth showing, with consecutive repeats of the same state
 *  within one turn collapsed — a streaming turn emits one `streaming` event per chunk
 *  and each would otherwise be announced to screen readers separately. */
export function turnStateEvents(events: ConversationEvent[]): ConversationEvent[] {
  return events
    .filter(event => event.kind === "turn_state" && event.state && labels[event.state])
    .filter((event, index, all) => index === 0 || event.state !== all[index - 1]?.state || event.sequence !== all[index - 1]?.sequence)
}
