export type WorkspaceRoute =
  | { destination: "conversations"; conversationId: string | null }
  | { destination: "agents"; agent: string | null }
  | { destination: "not_found" }

function decodePathPart(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function parseWorkspaceRoute(pathname: string): WorkspaceRoute {
  if (pathname === "/") return { destination: "conversations", conversationId: null }
  if (pathname === "/agents") return { destination: "agents", agent: null }

  const conversation = /^\/conversations\/([^/]+)$/.exec(pathname)
  if (conversation) {
    const conversationId = decodePathPart(conversation[1])
    return conversationId === null ? { destination: "not_found" } : { destination: "conversations", conversationId }
  }

  const agent = /^\/agents\/([^/]+)$/.exec(pathname)
  if (agent) {
    const name = decodePathPart(agent[1])
    return name === null ? { destination: "not_found" } : { destination: "agents", agent: name }
  }

  return { destination: "not_found" }
}

export const pathForConversation = (conversationId: string | null): string =>
  conversationId === null ? "/" : `/conversations/${encodeURIComponent(conversationId)}`

export const pathForAgent = (agent: string | null): string =>
  agent === null ? "/agents" : `/agents/${encodeURIComponent(agent)}`
