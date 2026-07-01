import type { HubConfig } from "./types"

export type HubChangeTier = "safe" | "restart"

export interface HubChangeClassification {
  tier: HubChangeTier
  fullRestart: string[]   // names of changed top-level HubConfig fields nothing applies live —
                           // whether that's because they're boot-time-only (ports, socketPath,
                           // defaultAgent, ...) or simply not covered by !reload's existing hot-swap
                           // logic (audit, escalation, statusRefreshMs, ...). Both mean the same
                           // thing to the operator, so this list makes no distinction between them.
}

// The exact 7 fields !reload's existing apply logic hot-swaps live today
// (see hub/index.ts's !reload branch and the applySafeHubFields helper it uses).
const SAFE_KEYS: (keyof HubConfig)[] = [
  "routerModel", "librarianModel", "distillerModel", "overseerModel",
  "contextWindows", "commands", "directCommands",
]

const j = (v: unknown): string => JSON.stringify(v ?? null)

/** Classify a hub-config before→after transition. Deliberately does not use
 *  planReload (see this file's header note in the plan) — a plain set-difference
 *  against SAFE_KEYS is both correct and simpler for a hub-only, non-registry diff. */
export function classifyHubChange(before: HubConfig, after: HubConfig): HubChangeClassification {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)])
  const fullRestart: string[] = []
  for (const key of keys) {
    const k = key as keyof HubConfig
    if (j(before[k]) !== j(after[k]) && !SAFE_KEYS.includes(k)) fullRestart.push(key)
  }
  return fullRestart.length > 0 ? { tier: "restart", fullRestart } : { tier: "safe", fullRestart: [] }
}
