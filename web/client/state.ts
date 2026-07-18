import type { ConnectionState, Conversation, ConversationEvent, DocumentAttachment, Message, Session, ToolStep } from "./types"

export interface WorkspaceState {
  session: Session | null
  conversations: Conversation[]
  selectedConversationId: string | null
  messages: Message[]
  activity: ConversationEvent[]
  attachments: DocumentAttachment[]
  toolSteps: ToolStep[]
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
  toolSteps: [],
  connection: "connecting",
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "session/loaded": return { ...state, session: action.session }
    case "conversations/loaded": return { ...state, conversations: action.conversations }
    case "conversation/selected":
      return action.conversationId === state.selectedConversationId
        ? state
        : { ...state, selectedConversationId: action.conversationId, messages: [], activity: [], attachments: [], toolSteps: [] }
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
    case "connection/changed": return { ...state, connection: action.connection }
  }
}
