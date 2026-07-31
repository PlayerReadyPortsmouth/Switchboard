import type { GlitchtipAuthorizationResult } from "./glitchtipAutofixAuthorization"
import { matchSpawnTrigger, type CompiledSpawnTrigger } from "./spawnTriggers"

export interface SpawnAuthorizationAudit {
  outcome: "ok" | "deny"
  reason: string
}

export async function dispatchSpawnTriggerReply(
  triggers: CompiledSpawnTrigger[],
  reply: { sourceAgent: string; channelId: string; text: string },
  deps: {
    authorize: (input: {
      authorizationId: string
      taskId: string
      sourceAgent: string
      channelId: string
    }) => Promise<GlitchtipAuthorizationResult>
    runSpawn: (trigger: CompiledSpawnTrigger, groups: RegExpExecArray) => Promise<void>
    audit: (entry: SpawnAuthorizationAudit) => void
  },
): Promise<boolean> {
  for (const trigger of triggers) {
    if (trigger.authorizationMode !== "readyapp-glitchtip") continue
    trigger.re.lastIndex = 0
    const groups = trigger.re.exec(reply.text)
    if (!groups) continue
    const authorization = await deps.authorize({
      taskId: groups[1] ?? "",
      authorizationId: groups[2] ?? "",
      sourceAgent: reply.sourceAgent,
      channelId: reply.channelId,
    })
    deps.audit({ outcome: authorization.ok ? "ok" : "deny", reason: authorization.reason })
    if (authorization.ok) await deps.runSpawn(trigger, groups)
    return true
  }

  if (/(?:^|\s)SPAWN_GLITCHTIP_FIX(?:_QUICK)?\b/.test(reply.text)) {
    deps.audit({ outcome: "deny", reason: "malformed_command" })
    return true
  }

  const match = matchSpawnTrigger(triggers, reply.sourceAgent, reply.text)
  if (!match) return false
  await deps.runSpawn(match.trigger, match.groups)
  return true
}
