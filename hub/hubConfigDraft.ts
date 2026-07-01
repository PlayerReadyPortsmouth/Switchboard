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
// Exported so hub/index.ts's previewHubConfigChange can run invalidSafeFieldValue
// (below) against the same list before a preview is ever created.
export const SAFE_KEYS: (keyof HubConfig)[] = [
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

/** Minimal proportionate guard on the 7 fields that get hot-swapped live
 *  immediately on confirm (see confirmHubConfigChange) — NOT full schema
 *  validation (explicit non-goal), just enough to stop an empty/wrong-typed/
 *  dropped safe field from reaching the live hub instantly. Only checks fields
 *  that actually CHANGED (before !== after) — an already-broken field the
 *  operator didn't touch isn't this feature's problem to fix. */
export function invalidSafeFieldValue(before: HubConfig, after: HubConfig): string | null {
  for (const key of SAFE_KEYS) {
    if (j(before[key]) === j(after[key])) continue   // unchanged — not this feature's concern
    if (key === "routerModel" || key === "librarianModel" || key === "distillerModel" || key === "overseerModel") {
      if (typeof after[key] !== "string" || !after[key]) return `${key} must be a non-empty string`
    }
    if (key === "commands" || key === "directCommands") {
      if (after[key] !== undefined && !Array.isArray(after[key])) return `${key} must be an array`
    }
    if (key === "contextWindows") {
      if (after[key] !== undefined && (typeof after[key] !== "object" || after[key] === null || Array.isArray(after[key]))) {
        return "contextWindows must be an object"
      }
    }
  }
  return null
}
