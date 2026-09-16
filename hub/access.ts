import type { AgentRegistry } from "./types"

/** Where the message arrived, for agents restricted with `access.channels`. */
export interface CallerContext {
  channelId?: string
  /** Set when channelId is a thread: the parent channel it hangs off. */
  threadParentId?: string
  isDM?: boolean
}

/** Agents the caller may use, given their resolved roles, user id and where they are.
 *
 *  `access.channels` is applied AFTER roles/users and only ever narrows the result, so
 *  it cannot grant access to somebody roles/users did not already allow.
 *
 *  ⚠️ Fails CLOSED: if an agent restricts itself to channels and no context is supplied,
 *  it is omitted. We would rather drop an agent from the list than offer one we cannot
 *  prove is allowed here. */
export function permittedAgents(
  registry: AgentRegistry,
  callerRoles: string[],
  callerUserId: string,
  where?: CallerContext,
): string[] {
  const roleSet = new Set(callerRoles)
  const out: string[] = []
  for (const [name, cfg] of Object.entries(registry)) {
    const roles = cfg.access.roles ?? []
    const users = cfg.access.users ?? []
    const ok =
      roles.includes("*") ||
      roles.some(r => roleSet.has(r)) ||
      users.includes(callerUserId)
    if (!ok) continue
    const channels = cfg.access.channels
    if (channels && channels.length > 0) {
      if (!where || where.isDM) continue
      const here = where.channelId
      const parent = where.threadParentId
      const inChannel =
        (here != null && channels.includes(here)) ||
        (parent != null && channels.includes(parent))
      if (!inChannel) continue
    }
    out.push(name)
  }
  return out
}
