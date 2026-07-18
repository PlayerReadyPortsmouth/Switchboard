import type { ConnectionState, Conversation, ConversationEvent, DocumentAttachment, Message, Session } from "./types"

export interface WorkspaceState {
  session: Session | null
  conversations: Conversation[]
  selectedConversationId: string | null
  messages: Message[]
  activity: ConversationEvent[]
  attachments: DocumentAttachment[]
  connection: ConnectionState
}

export type WorkspaceAction =
  | { type: "session/loaded"; session: Session }
  | { type: "conversations/loaded"; conversations: Conversation[] }
  | { type: "conversation/selected"; conversationId: string | null }
  | { type: "messages/received"; messages: Message[] }
  | { type: "activity/received"; event: ConversationEvent }
  | { type: "connection/changed"; connection: ConnectionState }

export const initialWorkspaceState: WorkspaceState = {
  session: null,
  conversations: [],
  selectedConversationId: null,
  messages: [],
  activity: [],
  attachments: [],
  connection: "connecting",
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "session/loaded": return { ...state, session: action.session }
    case "conversations/loaded": return { ...state, conversations: action.conversations }
    case "conversation/selected":
      return action.conversationId === state.selectedConversationId
        ? state
        : { ...state, selectedConversationId: action.conversationId, messages: [], activity: [], attachments: [] }
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
        return { ...state, attachments: [...state.attachments, event.attachment] }
      }
      return { ...state, activity: [...state.activity, event] }
    }
    case "connection/changed": return { ...state, connection: action.connection }
  }
}
