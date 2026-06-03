import type { GatedAction } from "./types"

const CUSTOM_ID = /^([a-z][a-z0-9_]*):([a-z0-9_]+):(.+)$/

/** Find the GatedAction whose namespace:action prefix matches this customId. */
export function matchGatedAction(customId: string, actions: GatedAction[]): GatedAction | null {
  const m = CUSTOM_ID.exec(customId)
  if (!m) return null
  return actions.find((a) => a.namespace === m[1] && a.action === m[2]) ?? null
}

/** The `arg` segment of `ns:action:arg` (may itself contain colons). */
export function gatedActionArg(customId: string): string {
  const m = CUSTOM_ID.exec(customId)
  return m ? m[3]! : ""
}

export function requiresApprover(customId: string, actions: GatedAction[]): boolean {
  return matchGatedAction(customId, actions)?.approverOnly === true
}

/** Substitute $arg (word-boundaried) in a gated command/text template. */
export function interpolateCommand(tmpl: string, arg: string): string {
  return tmpl.replace(/\$arg\b/g, arg)
}
