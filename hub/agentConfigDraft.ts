import { planReload } from "./configReload"
import type { AgentConfig, HubConfig, AgentRegistry } from "./types"

export type ChangeTier = "safe" | "hard" | "restart"

export interface AgentChangeClassification {
  tier: ChangeTier
  fullRestart: string[]   // reasons a restart is needed: planReload's own labels
                           // (+agent:/-agent:/agent-mode:/agent-pool:/hub-level keys)
                           // plus this module's own "unapplied:<field>" labels
}

const j = (v: unknown): string => JSON.stringify(v ?? null)

/** Fields !reload's existing apply logic never hot-swaps, and planReload never
 *  flags as needing a restart either — a change to any of these via a hand-edited
 *  file + !reload silently does nothing today. Surfaced here so this module's
 *  classification is honest rather than implying safe/hard/full-restart is
 *  exhaustive. Deliberately NOT a fix to !reload's own apply logic (out of scope
 *  for this phase — see the Phase 3 design spec §1/§8). */
function unappliedFieldDiffs(before: AgentConfig, after: AgentConfig): string[] {
  const out: string[] = []
  if (j(before.emoji) !== j(after.emoji)) out.push("unapplied:emoji")
  if (j(before.description) !== j(after.description)) out.push("unapplied:description")
  const br = before.runtime, ar = after.runtime
  if (j(br.useMemory) !== j(ar.useMemory)) out.push("unapplied:runtime.useMemory")
  if (j(br.injectContext) !== j(ar.injectContext)) out.push("unapplied:runtime.injectContext")
  if (j(br.overseer) !== j(ar.overseer)) out.push("unapplied:runtime.overseer")
  if (j(br.sessionGovernor) !== j(ar.sessionGovernor)) out.push("unapplied:runtime.sessionGovernor")
  if (j(br.maxQueueDepth) !== j(ar.maxQueueDepth)) out.push("unapplied:runtime.maxQueueDepth")
  if (j(br.coalesceBurst) !== j(ar.coalesceBurst)) out.push("unapplied:runtime.coalesceBurst")
  if (j(br.pool) !== j(ar.pool)) out.push("unapplied:runtime.pool")
  if (j(br.audit) !== j(ar.audit)) out.push("unapplied:runtime.audit")
  return out
}

/** Classify one agent's before→after transition. planReload is shaped for a
 *  whole-registry prev/next comparison, so this builds single-entry "registries"
 *  containing only `name` to scope it to just this agent — since `hub` is passed
 *  identically as both prev.hub and next.hub, planReload's hub-level-key diff is
 *  always empty here (Phase 3 never touches hub.config.json), and its add/remove
 *  loops only ever see the one name being diffed. */
export function classifyAgentChange(
  name: string, before: AgentConfig | null, after: AgentConfig | null, hub: HubConfig,
): AgentChangeClassification {
  const prevAgents: AgentRegistry = before ? { [name]: before } : {}
  const nextAgents: AgentRegistry = after ? { [name]: after } : {}
  const plan = planReload({ hub, agents: prevAgents }, { hub, agents: nextAgents })
  const fullRestart = [...plan.fullRestart]
  if (before && after) fullRestart.push(...unappliedFieldDiffs(before, after))
  if (fullRestart.length > 0) return { tier: "restart", fullRestart }
  if (plan.restartAgents.length > 0) return { tier: "hard", fullRestart: [] }
  return { tier: "safe", fullRestart: [] }
}
