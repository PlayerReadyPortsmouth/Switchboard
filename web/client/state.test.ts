import { expect, test } from "bun:test"
import { initialWorkspaceState, workspaceReducer, type WorkspaceState } from "./state"
import type { ConversationEvent, DocumentAttachment, ToolStep } from "./types"

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

// --- Attachment hydration -------------------------------------------------------------
// `attachment` events are live-only (they never advance the message replay high-water mark),
// so a remount refetches messages but would lose every card. `attachments/loaded` restores
// them from the durable mirror rows; these tests pin the merge in both arrival orders.

const attachment = (token: string, createdAt = 1_000): DocumentAttachment =>
  ({ token, title: `${token}.md`, contentType: "text/markdown", mode: "view", visibility: "org", createdAt })

const attachmentEvent = (token: string, createdAt = 1_000): ConversationEvent =>
  ({ kind: "attachment", conversationId: "c1", sequence: Date.now(), ts: createdAt, attachment: attachment(token, createdAt) })

test("hydration restores attachment cards with no live events at all", () => {
  // Exactly Aurora's navigate-away-and-back case: a fresh state, messages refetched, and the
  // only source of cards is the hydration fetch.
  const state = workspaceReducer(initialWorkspaceState, {
    type: "attachments/loaded",
    attachments: [attachment("tok-1", 1_000), attachment("tok-2", 2_000)],
  })
  expect(state.attachments.map(a => a.token)).toEqual(["tok-1", "tok-2"])
})

test("hydration after a live event does not duplicate the shared token", () => {
  const live = reduce(initialWorkspaceState, attachmentEvent("tok-1", 1_000))
  const merged = workspaceReducer(live, {
    type: "attachments/loaded",
    attachments: [attachment("tok-1", 1_000), attachment("tok-2", 2_000)],
  })
  expect(merged.attachments.map(a => a.token)).toEqual(["tok-1", "tok-2"])
})

test("a live event after hydration does not duplicate an already-hydrated token", () => {
  // The reverse race: the SSE stream and the hydration fetch start in the same effect, so
  // either can land first and the result must be identical.
  const hydrated = workspaceReducer(initialWorkspaceState, {
    type: "attachments/loaded",
    attachments: [attachment("tok-1", 1_000), attachment("tok-2", 2_000)],
  })
  const merged = reduce(hydrated, attachmentEvent("tok-1", 1_000), attachmentEvent("tok-3", 3_000))
  expect(merged.attachments.map(a => a.token)).toEqual(["tok-1", "tok-2", "tok-3"])
})

test("attachments order by publish time regardless of which source delivered them first", () => {
  const live = reduce(initialWorkspaceState, attachmentEvent("late", 9_000))
  const merged = workspaceReducer(live, { type: "attachments/loaded", attachments: [attachment("early", 1_000)] })
  expect(merged.attachments.map(a => a.token)).toEqual(["early", "late"])
})

test("a hydration that adds nothing new returns the SAME state object (no needless re-render)", () => {
  const live = reduce(initialWorkspaceState, attachmentEvent("tok-1", 1_000))
  const merged = workspaceReducer(live, { type: "attachments/loaded", attachments: [attachment("tok-1", 1_000)] })
  expect(merged).toBe(live)
})

test("selecting a different conversation clears hydrated attachments", () => {
  const state = workspaceReducer(initialWorkspaceState, { type: "attachments/loaded", attachments: [attachment("tok-1")] })
  expect(workspaceReducer(state, { type: "conversation/selected", conversationId: "c2" }).attachments).toEqual([])
})
