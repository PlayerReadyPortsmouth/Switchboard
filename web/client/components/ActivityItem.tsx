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

export function ActivityDisclosure({ events }: { events: ConversationEvent[] }) {
  const states = events.filter(event => event.kind === "turn_state" && event.state && labels[event.state]).filter((event, index, all) => index === 0 || event.state !== all[index - 1]?.state || event.sequence !== all[index - 1]?.sequence)
  if (!states.length) return null
  return <details className="activity-disclosure"><summary><span className="activity-trace" aria-hidden="true" />Live activity</summary><ol>{states.map((event, index) => <ActivityItem key={`${event.sequence}:${event.state}:${index}`} event={event} />)}</ol></details>
}
