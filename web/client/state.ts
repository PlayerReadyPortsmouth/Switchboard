import type { ConnectionState, Conversation, ConversationEvent, Message, Session } from "./types"

export interface WorkspaceState {
  session: Session | null
  conversations: Conversation[]
  selectedConversationId: string | null
  messages: Message[]
  activity: ConversationEvent[]
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
  connection: "connecting",
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "session/loaded": return { ...state, session: action.session }
    case "conversations/loaded": return { ...state, conversations: action.conversations }
    case "conversation/selected":
      return action.conversationId === state.selectedConversationId
        ? state
        : { ...state, selectedConversationId: action.conversationId, messages: [], activity: [] }
    case "messages/received": {
      const messages = new Map(state.messages.map(message => [message.id, message]))
      for (const message of action.messages) messages.set(message.id, message)
      return { ...state, messages: [...messages.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)) }
    }
    case "activity/received": return { ...state, activity: [...state.activity, action.event] }
    case "connection/changed": return { ...state, connection: action.connection }
  }
}
