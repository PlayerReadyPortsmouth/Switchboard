/** Two-tier config reload classification (pure — no IO).
 *
 *  A SAFE reload hot-swaps values that every consumer reads at call time — the
 *  router/fallback models, `commands` / `directCommands`, and per-agent `access`
 *  — WITHOUT touching any running agent process. A HARD reload additionally
 *  respawns the persistent agents whose spawn-affecting config (model, claudeArgs,
 *  cwd, resumable, mode, appendSystemPrompt, allowedTools) changed. Some changes
 *  can be applied by NEITHER reload and need a full hub restart: ports/host binds,
 *  the socket path, the state dir, the default agent, adding/removing an agent,
 *  flipping an agent's mode, or a pooled agent's spawn config (pools aren't hot-
 *  respawned). This module classifies a proposed config so the caller (index.ts,
 *  which owns the file read + the imperative apply) can act and report accurately. */

import type { HubConfig, AgentConfig, AgentRegistry } from "./types"

const j = (v: unknown): string => JSON.stringify(v ?? null)

/** The spawn-affecting fingerprint of one agent: the fields baked into its
 *  `claude` process at spawn. A change here can only take effect via a respawn. */
export function agentSpawnSignature(cfg: AgentConfig): string {
  return j({
    mode: cfg.mode,
    model: cfg.runtime?.model,
    claudeArgs: cfg.runtime?.claudeArgs,
    cwd: cfg.runtime?.cwd,
    resumable: cfg.runtime?.resumable,
    appendSystemPrompt: cfg.runtime?.appendSystemPrompt,
    allowedTools: cfg.runtime?.allowedTools,
  })
}

export interface ReloadPlan {
  restartAgents: string[]   // persistent, non-pooled agents whose spawn signature changed (HARD reload targets)
  fullRestart: string[]     // labels of changes NEITHER reload can apply (need a full hub restart)
}

/** Hub-level keys wired into boot-time constructs (listeners, socket, paths) that
 *  no live reload can swap — changing any requires a full hub restart. */
const HUB_FULL_RESTART_KEYS: (keyof HubConfig)[] = [
  "socketPath", "stateDir", "defaultAgent",
  "metricsPort", "metricsHost", "webPort", "webHost", "webhookPort",
]

/** Classify prev→next into the agents a hard reload must respawn and the changes
 *  that need a full hub restart. (Safe hot-swaps aren't listed — the caller always
 *  applies those.) */
export function planReload(
  prev: { hub: HubConfig; agents: AgentRegistry },
  next: { hub: HubConfig; agents: AgentRegistry },
): ReloadPlan {
  const restartAgents: string[] = []
  const fullRestart: string[] = []

  for (const key of HUB_FULL_RESTART_KEYS) {
    if (j(prev.hub[key]) !== j(next.hub[key])) fullRestart.push(String(key))
  }

  for (const n of Object.keys(next.agents)) if (!prev.agents[n]) fullRestart.push(`+agent:${n}`)
  for (const n of Object.keys(prev.agents)) if (!next.agents[n]) fullRestart.push(`-agent:${n}`)

  for (const n of Object.keys(next.agents)) {
    const a = prev.agents[n]; const b = next.agents[n]
    if (!a || !b) continue
    if (a.mode !== b.mode) { fullRestart.push(`agent-mode:${n}`); continue }
    if (b.mode !== "persistent") continue          // ephemeral agents spawn per-use; nothing to respawn
    if (agentSpawnSignature(a) === agentSpawnSignature(b)) continue
    // A pooled agent runs behind an AgentPool (replicas), not a single transport —
    // the hard-reload respawn path can't hot-swap it, so flag a full restart.
    if (a.runtime?.pool || b.runtime?.pool) fullRestart.push(`agent-pool:${n}`)
    else restartAgents.push(n)
  }
  return { restartAgents, fullRestart }
}
