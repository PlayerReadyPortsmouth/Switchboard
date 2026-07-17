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

// Strips the configured base from a pathname, returning a root-relative path ("/…") or null
// when the pathname is not under the base. `base` always has a trailing slash (see webBase.ts).
function stripBase(pathname: string, base: string): string | null {
  if (base === "/") return pathname
  if (pathname === base.slice(0, -1)) return "/"
  if (pathname.startsWith(base)) return pathname.slice(base.length - 1)
  return null
}

export function parseWorkspaceRoute(pathname: string, base = "/"): WorkspaceRoute {
  const rooted = stripBase(pathname, base)
  if (rooted === null) return { destination: "not_found" }

  if (rooted === "/") return { destination: "conversations", conversationId: null }
  if (rooted === "/agents") return { destination: "agents", agent: null }

  const conversation = /^\/conversations\/([^/]+)$/.exec(rooted)
  if (conversation) {
    const conversationId = decodePathPart(conversation[1])
    return conversationId === null ? { destination: "not_found" } : { destination: "conversations", conversationId }
  }

  const agent = /^\/agents\/([^/]+)$/.exec(rooted)
  if (agent) {
    const name = decodePathPart(agent[1])
    return name === null ? { destination: "not_found" } : { destination: "agents", agent: name }
  }

  return { destination: "not_found" }
}

// `base` has a trailing slash and the rooted path a leading slash, so drop one to avoid "//".
const withBase = (base: string, rooted: string): string => `${base.slice(0, -1)}${rooted}`

export const pathForConversation = (conversationId: string | null, base = "/"): string =>
  withBase(base, conversationId === null ? "/" : `/conversations/${encodeURIComponent(conversationId)}`)

export const pathForAgent = (agent: string | null, base = "/"): string =>
  withBase(base, agent === null ? "/agents" : `/agents/${encodeURIComponent(agent)}`)
