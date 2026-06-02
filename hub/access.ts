import type { AgentRegistry } from "./types"

/** Agents the caller may use, given their resolved roles and user id. */
export function permittedAgents(
  registry: AgentRegistry,
  callerRoles: string[],
  callerUserId: string,
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
    if (ok) out.push(name)
  }
  return out
}
