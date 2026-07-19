import type { CardInfo, ConnectionState, Conversation, ConversationEvent, DocumentAttachment, Message, Session, ToolStep } from "./types"

export interface WorkspaceState {
  session: Session | null
  conversations: Conversation[]
  selectedConversationId: string | null
  messages: Message[]
  activity: ConversationEvent[]
  attachments: DocumentAttachment[]
  cards: CardInfo[]
  toolSteps: ToolStep[]
  connection: ConnectionState
}

export type WorkspaceAction =
  | { type: "session/loaded"; session: Session }
  | { type: "conversations/loaded"; conversations: Conversation[] }
  | { type: "conversation/selected"; conversationId: string | null }
  | { type: "messages/received"; messages: Message[] }
  | { type: "activity/received"; event: ConversationEvent }
  | { type: "attachments/loaded"; attachments: DocumentAttachment[] }
  | { type: "cards/loaded"; cards: CardInfo[] }
  | { type: "connection/changed"; connection: ConnectionState }

export const initialWorkspaceState: WorkspaceState = {
  session: null,
  conversations: [],
  selectedConversationId: null,
  messages: [],
  activity: [],
  attachments: [],
  cards: [],
  toolSteps: [],
  connection: "connecting",
}

/** Attachments are ordered by publish time, tie-broken by token so the sort is total and
 *  stable. Both entry points (live SSE, hydration on load) run through this, so the rendered
 *  order can't depend on which of the two happened to arrive first — the race is real, since
 *  the hydration fetch and the event stream are started by the same effect. */
const orderAttachments = (attachments: DocumentAttachment[]): DocumentAttachment[] =>
  [...attachments].sort((left, right) => left.createdAt - right.createdAt || left.token.localeCompare(right.token))

/** Cards order by FIRST appearance, never by `updatedAt` — the whole point of anchoring at
 *  `createdAt` is that an edit leaves the card where it is instead of teleporting it to the
 *  bottom of the transcript every time an agent touches it. Tie-broken by correlationId so
 *  the sort is total, and so live-first and hydrate-first produce the same order. */
const orderCards = (cards: CardInfo[]): CardInfo[] =>
  [...cards].sort((left, right) => left.createdAt - right.createdAt || left.correlationId.localeCompare(right.correlationId))

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "session/loaded": return { ...state, session: action.session }
    case "conversations/loaded": return { ...state, conversations: action.conversations }
    case "conversation/selected":
      return action.conversationId === state.selectedConversationId
        ? state
        : { ...state, selectedConversationId: action.conversationId, messages: [], activity: [], attachments: [], cards: [], toolSteps: [] }
    case "messages/received": {
      const messages = new Map(state.messages.map(message => [message.id, message]))
      for (const message of action.messages) messages.set(message.id, message)
      return { ...state, messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)) }
    }
    case "activity/received": {
      const { event } = action
      // Attachment events fan into a token-deduped list (the transcript renders
      // them as inline document cards), never into the raw activity feed.
      if (event.kind === "attachment" && event.attachment) {
        if (state.attachments.some(existing => existing.token === event.attachment!.token)) return state
        return { ...state, attachments: orderAttachments([...state.attachments, event.attachment]) }
      }
      // A card is the one event kind that REPLACES rather than appends: `update_card` re-emits
      // the same correlationId at a higher revision, and the transcript shows exactly one card
      // per correlationId. Replacing in place (rather than appending a second card) is what
      // keeps a superseded revision's buttons off the screen — the Lane C spec's safety point.
      if (event.kind === "card" && event.card) {
        const incoming = event.card
        const index = state.cards.findIndex(existing => existing.correlationId === incoming.correlationId)
        if (index === -1) return { ...state, cards: orderCards([...state.cards, incoming]) }
        // Revisions only move forward. A re-delivered or out-of-order older revision is
        // dropped rather than applied, so a redelivery can never resurrect dead buttons.
        if (state.cards[index]!.revision >= incoming.revision) return state
        const cards = [...state.cards]
        cards[index] = incoming
        // No re-sort: `createdAt` is immutable across revisions, so the position is unchanged.
        return { ...state, cards }
      }
      // Tool steps land in their own id-keyed slice: a step first arrives `running`
      // and is later re-published with its terminal status, so the result UPDATES the
      // existing row in place (keeping its position in the spine) rather than
      // appending a duplicate.
      if (event.kind === "tool_step" && event.tool) {
        const step = event.tool
        const index = state.toolSteps.findIndex(existing => existing.id === step.id)
        if (index === -1) return { ...state, toolSteps: [...state.toolSteps, step] }
        const toolSteps = [...state.toolSteps]
        toolSteps[index] = step
        return { ...state, toolSteps }
      }
      return { ...state, activity: [...state.activity, event] }
    }
    // Restores the cards a remount would otherwise lose. Live events WIN on conflict: a token
    // already in the slice keeps the version it has, because the live emit and the mirror row
    // describe the same document and re-seating it would only churn the render. Anything the
    // stream delivered while this fetch was in flight therefore survives it.
    case "attachments/loaded": {
      const known = new Set(state.attachments.map(attachment => attachment.token))
      const added = action.attachments.filter(attachment => !known.has(attachment.token))
      if (!added.length) return state
      return { ...state, attachments: orderAttachments([...state.attachments, ...added]) }
    }
    // Restores the cards a remount would otherwise lose. Merged by correlationId so a card
    // that also arrived live is not duplicated, and resolved by REVISION rather than by
    // arrival order: the hydration fetch and the event stream start from the same effect, so
    // either can carry the newer state and only the revision number says which. Highest
    // revision wins; a tie keeps the live copy, which is already mounted.
    case "cards/loaded": {
      const merged = new Map(action.cards.map(card => [card.correlationId, card]))
      for (const live of state.cards) {
        const hydrated = merged.get(live.correlationId)
        if (!hydrated || live.revision >= hydrated.revision) merged.set(live.correlationId, live)
      }
      return { ...state, cards: orderCards([...merged.values()]) }
    }
    case "connection/changed": return { ...state, connection: action.connection }
  }
}
