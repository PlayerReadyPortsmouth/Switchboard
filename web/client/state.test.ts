import { expect, test } from "bun:test"
import { initialWorkspaceState, workspaceReducer, type WorkspaceState } from "./state"
import type { CardInfo, ConversationEvent, DocumentAttachment, ToolStep } from "./types"

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

// --- Interactive agent cards ---------------------------------------------------------------

const spec = (title: string, buttons: { customId: string; label: string }[] = []) => ({ title, body: "", buttons })
const cardInfo = (overrides: Partial<CardInfo> = {}): CardInfo => ({
  correlationId: "corr-1", conversationId: "c1", agent: "triage", revision: 1,
  createdAt: 1000, updatedAt: 1000, card: spec("🐛 Cannot view CYP profiles", [{ customId: "triage:fix:1", label: "Fix now" }]),
  ...overrides,
})
const cardEvent = (info: CardInfo, ts = info.updatedAt): ConversationEvent =>
  ({ kind: "card", conversationId: "c1", sequence: ts, ts, card: info })

test("a card event lands in the card slice, not in the raw activity feed", () => {
  const state = reduce(initialWorkspaceState, cardEvent(cardInfo()))
  expect(state.cards).toHaveLength(1)
  expect(state.activity).toEqual([])
})

test("an edit REPLACES the card in place by correlationId instead of appending a second one", () => {
  const posted = reduce(initialWorkspaceState, cardEvent(cardInfo()))
  const edited = reduce(posted, cardEvent(cardInfo({
    revision: 2, updatedAt: 5000,
    card: spec("🚀 Fix ready: CYP profile 403", [{ customId: "deploy:go:1", label: "Deploy" }]),
    history: [{ revision: 1, updatedAt: 1000, card: posted.cards[0]!.card }],
  })))
  expect(edited.cards).toHaveLength(1)
  expect(edited.cards[0]!.revision).toBe(2)
  expect(edited.cards[0]!.card.title).toBe("🚀 Fix ready: CYP profile 403")
  // The anchor is immutable, so the card does not move in the transcript when it is edited.
  expect(edited.cards[0]!.createdAt).toBe(1000)
})

test("an edited card keeps its position — it does not jump to the end", () => {
  const state = reduce(
    initialWorkspaceState,
    cardEvent(cardInfo({ correlationId: "a", createdAt: 1000, updatedAt: 1000 })),
    cardEvent(cardInfo({ correlationId: "b", createdAt: 2000, updatedAt: 2000 })),
    cardEvent(cardInfo({ correlationId: "a", createdAt: 1000, updatedAt: 9000, revision: 2 })),
  )
  expect(state.cards.map(card => card.correlationId)).toEqual(["a", "b"])
})

test("a stale or redelivered revision is ignored, so dead buttons cannot come back", () => {
  const current = reduce(
    initialWorkspaceState,
    cardEvent(cardInfo()),
    cardEvent(cardInfo({ revision: 3, updatedAt: 5000, card: spec("✅ Deployed to live.") })),
  )
  const replayed = reduce(current, cardEvent(cardInfo({ revision: 1 })))
  expect(replayed).toBe(current)
  expect(replayed.cards[0]!.card.title).toBe("✅ Deployed to live.")
  expect(replayed.cards[0]!.card.buttons).toEqual([])
})

test("hydration restores cards when no live event was ever seen", () => {
  const state = workspaceReducer(initialWorkspaceState, { type: "cards/loaded", cards: [
    cardInfo({ correlationId: "a", createdAt: 1000 }),
    cardInfo({ correlationId: "b", createdAt: 2000 }),
  ] })
  expect(state.cards.map(card => card.correlationId)).toEqual(["a", "b"])
})

test("hydration merges with live cards by correlationId without duplicating", () => {
  const live = reduce(initialWorkspaceState, cardEvent(cardInfo({ correlationId: "a", createdAt: 1000 })))
  const merged = workspaceReducer(live, { type: "cards/loaded", cards: [
    cardInfo({ correlationId: "a", createdAt: 1000 }),
    cardInfo({ correlationId: "b", createdAt: 2000 }),
  ] })
  expect(merged.cards).toHaveLength(2)
  expect(merged.cards.map(card => card.correlationId)).toEqual(["a", "b"])
})

test("the higher revision wins the hydrate/live race, whichever way round it lands", () => {
  // Live edit arrives first, then a hydration snapshot taken BEFORE the edit.
  const live = reduce(initialWorkspaceState, cardEvent(cardInfo({ revision: 4, card: spec("✅ Deployed to live.") })))
  const staleHydration = workspaceReducer(live, { type: "cards/loaded", cards: [cardInfo({ revision: 1 })] })
  expect(staleHydration.cards[0]!.revision).toBe(4)

  // …and the other way: hydration carries a revision the stream has not delivered yet.
  const early = reduce(initialWorkspaceState, cardEvent(cardInfo({ revision: 1 })))
  const freshHydration = workspaceReducer(early, { type: "cards/loaded", cards: [cardInfo({ revision: 4, card: spec("✅ Deployed to live.") })] })
  expect(freshHydration.cards[0]!.revision).toBe(4)
  expect(freshHydration.cards).toHaveLength(1)
})

test("ordering is identical whether cards arrived live-first or hydrate-first", () => {
  const one = cardInfo({ correlationId: "b", createdAt: 2000 })
  const two = cardInfo({ correlationId: "a", createdAt: 1000 })
  const liveFirst = workspaceReducer(reduce(initialWorkspaceState, cardEvent(one)), { type: "cards/loaded", cards: [two] })
  const hydrateFirst = reduce(workspaceReducer(initialWorkspaceState, { type: "cards/loaded", cards: [two] }), cardEvent(one))
  expect(liveFirst.cards.map(card => card.correlationId)).toEqual(["a", "b"])
  expect(hydrateFirst.cards.map(card => card.correlationId)).toEqual(["a", "b"])
})

test("selecting another conversation clears the cards", () => {
  const state = reduce(initialWorkspaceState, cardEvent(cardInfo()))
  const switched = workspaceReducer(state, { type: "conversation/selected", conversationId: "c2" })
  expect(switched.cards).toEqual([])
})

// --- In-flight (a click running on the OTHER surface) ---------------------------------------
// The marker shares its card's revision by design: a transient "⏳ Working" is not something
// the card ever SAID, so it must not mint a revision and pad the history trail. That makes the
// equal-revision case meaningful for the first time, and these tests pin both halves of it —
// the marker must get through, and a stale replay still must not.
const inFlight = (at: number, surface: "discord" | "web" = "discord") =>
  ({ surface, customId: "triage:fix:1", at })

test("a Discord click reaches the web card as in-flight at the SAME revision", () => {
  const posted = reduce(initialWorkspaceState, cardEvent(cardInfo()))
  const marked = reduce(posted, cardEvent(cardInfo({ updatedAt: 2000, inFlight: inFlight(2000) })))
  expect(marked.cards[0]!.revision).toBe(1)
  expect(marked.cards[0]!.inFlight).toEqual(inFlight(2000))
  // The buttons are untouched in the data — it is the marker, not an edit, that makes the
  // card unavailable, so the card still says what it said.
  expect(marked.cards[0]!.card.buttons).toHaveLength(1)
})

test("clearing the marker at the same revision gets through too", () => {
  const marked = reduce(initialWorkspaceState, cardEvent(cardInfo()), cardEvent(cardInfo({ updatedAt: 2000, inFlight: inFlight(2000) })))
  const cleared = reduce(marked, cardEvent(cardInfo({ updatedAt: 3000 })))
  expect(cleared.cards[0]!.inFlight).toBeUndefined()
})

test("a redelivered event that changes nothing is still dropped", () => {
  const marked = reduce(initialWorkspaceState, cardEvent(cardInfo()), cardEvent(cardInfo({ updatedAt: 2000, inFlight: inFlight(2000) })))
  const replayed = reduce(marked, cardEvent(cardInfo({ updatedAt: 2000, inFlight: inFlight(2000) })))
  expect(replayed).toBe(marked)
})

test("a stale marker never overwrites a fresher one at the same revision", () => {
  const marked = reduce(initialWorkspaceState, cardEvent(cardInfo()), cardEvent(cardInfo({ updatedAt: 5000, inFlight: inFlight(5000, "web") })))
  const stale = reduce(marked, cardEvent(cardInfo({ updatedAt: 6000, inFlight: inFlight(2000, "discord") })))
  expect(stale.cards[0]!.inFlight).toEqual(inFlight(5000, "web"))
})

test("revisions still never go backwards, marker or no marker", () => {
  const current = reduce(
    initialWorkspaceState,
    cardEvent(cardInfo()),
    cardEvent(cardInfo({ revision: 3, card: spec("✅ Deployed to live.") })),
  )
  // An older revision carrying a marker is exactly the interleaving to worry about: a Discord
  // click's in-flight publish arriving after the agent's real update. It must lose.
  const late = reduce(current, cardEvent(cardInfo({ revision: 1, inFlight: inFlight(9000) })))
  expect(late).toBe(current)
  expect(late.cards[0]!.revision).toBe(3)
  expect(late.cards[0]!.inFlight).toBeUndefined()
})

test("a reload mid-click hydrates the marker rather than re-offering the button", () => {
  // The live copy is the pre-click card; the hydration snapshot was taken after the click.
  const live = reduce(initialWorkspaceState, cardEvent(cardInfo()))
  const merged = workspaceReducer(live, { type: "cards/loaded", cards: [cardInfo({ updatedAt: 2000, inFlight: inFlight(2000) })] })
  expect(merged.cards[0]!.inFlight).toEqual(inFlight(2000))
})

test("hydration does not resurrect a marker the live stream has already cleared", () => {
  const live = reduce(initialWorkspaceState, cardEvent(cardInfo()), cardEvent(cardInfo({ updatedAt: 5000, inFlight: inFlight(5000) })), cardEvent(cardInfo({ updatedAt: 6000 })))
  const merged = workspaceReducer(live, { type: "cards/loaded", cards: [cardInfo({ updatedAt: 2000, inFlight: inFlight(2000) })] })
  expect(merged.cards[0]!.inFlight).toBeUndefined()
})
