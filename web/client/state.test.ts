import { expect, test } from "bun:test"
import { initialWorkspaceState, workspaceReducer, type WorkspaceState } from "./state"
import type { ConversationEvent, ToolStep } from "./types"

const toolStepEvent = (tool: ToolStep, ts = 1): ConversationEvent =>
  ({ kind: "tool_step", conversationId: "c1", sequence: ts, ts, tool })

const reduce = (state: WorkspaceState, ...events: ConversationEvent[]): WorkspaceState =>
  events.reduce((acc, event) => workspaceReducer(acc, { type: "activity/received", event }), state)

test("a running tool step is appended, then UPDATED IN PLACE when its result arrives", () => {
  const running = reduce(initialWorkspaceState, toolStepEvent({ id: "t1", name: "Read", summary: "hub/index.ts", status: "running" }))
  expect(running.toolSteps).toEqual([{ id: "t1", name: "Read", summary: "hub/index.ts", status: "running" }])

  const settled = reduce(running, toolStepEvent({ id: "t1", name: "Read", summary: "hub/index.ts", status: "ok", durationMs: 412 }, 2))
  // One row, not two — the result pairs back to its use by id.
  expect(settled.toolSteps).toHaveLength(1)
  expect(settled.toolSteps[0]).toEqual({ id: "t1", name: "Read", summary: "hub/index.ts", status: "ok", durationMs: 412 })
})

test("an in-place update keeps the step's position in the spine", () => {
  const state = reduce(
    initialWorkspaceState,
    toolStepEvent({ id: "t1", name: "Read", status: "running" }, 1),
    toolStepEvent({ id: "t2", name: "Bash", status: "running" }, 2),
    toolStepEvent({ id: "t3", name: "Grep", status: "running" }, 3),
    // The middle step finishes first — it must not jump to the end.
    toolStepEvent({ id: "t2", name: "Bash", status: "error", durationMs: 90 }, 4),
  )
  expect(state.toolSteps.map(step => step.id)).toEqual(["t1", "t2", "t3"])
  expect(state.toolSteps[1]!.status).toBe("error")
})

test("tool steps stay out of the raw activity feed and turn states stay out of the step slice", () => {
  const state = reduce(
    initialWorkspaceState,
    toolStepEvent({ id: "t1", name: "Read", status: "running" }),
    { kind: "turn_state", conversationId: "c1", sequence: 2, ts: 2, state: "working" },
  )
  expect(state.toolSteps).toHaveLength(1)
  expect(state.activity.map(event => event.kind)).toEqual(["turn_state"])
})

test("a malformed tool_step with no payload falls through to the activity feed untouched", () => {
  const state = reduce(initialWorkspaceState, { kind: "tool_step", conversationId: "c1", sequence: 1, ts: 1 })
  expect(state.toolSteps).toEqual([])
  expect(state.activity).toHaveLength(1)
})

test("selecting a different conversation clears the step slice", () => {
  const state = reduce(initialWorkspaceState, toolStepEvent({ id: "t1", name: "Read", status: "running" }))
  const switched = workspaceReducer(state, { type: "conversation/selected", conversationId: "c2" })
  expect(switched.toolSteps).toEqual([])
})
