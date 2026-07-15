export type WorkspaceDestination = "conversations" | "agents" | "approvals"

export type WorkspaceRoute =
  | { destination: "conversations"; conversationId: string | null }
  | { destination: "agents"; agent: string | null }
  | { destination: "approvals"; approvalId: string | null }
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
  if (pathname === "/approvals") return { destination: "approvals", approvalId: null }

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

  const approval = /^\/approvals\/([^/]+)$/.exec(pathname)
  if (approval) {
    const approvalId = decodePathPart(approval[1])
    return approvalId === null ? { destination: "not_found" } : { destination: "approvals", approvalId }
  }

  return { destination: "not_found" }
}

export const pathForConversation = (conversationId: string | null): string =>
  conversationId === null ? "/" : `/conversations/${encodeURIComponent(conversationId)}`

export const pathForAgent = (agent: string | null): string =>
  agent === null ? "/agents" : `/agents/${encodeURIComponent(agent)}`

export function pathForApproval(
  approvalId: string | null,
  query: { group?: "pending" | "history"; conversationId?: string } = {},
): string {
  const path = approvalId === null ? "/approvals" : `/approvals/${encodeURIComponent(approvalId)}`
  const parameters = new URLSearchParams()
  if (query.group !== undefined) parameters.set("group", query.group)
  if (query.conversationId !== undefined) parameters.set("conversationId", query.conversationId)
  const search = parameters.toString()
  return search ? `${path}?${search}` : path
}
