export interface ConfiguredValueSentinel { redacted: true; configured: true }

export const isConfiguredValueSentinel = (value: unknown): value is ConfiguredValueSentinel => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2 && record.redacted === true && record.configured === true
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string")
const nonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1

/** Authoritative validation for values accepted by the Agents config preview API.
 * Omission of either opaque field deliberately means removal. The exact sentinel
 * may only preserve a value represented by the server's original projection. */
export function editableAgentConfigError(value: unknown, original?: unknown): string | null {
  if (!record(value)) return "Configuration must match the documented agent shape."
  if (typeof value.emoji !== "string" || typeof value.description !== "string" || (value.mode !== "persistent" && value.mode !== "ephemeral")) return "Configuration must match the documented agent shape."
  if (!record(value.access)) return "Configuration access must be an object."
  for (const key of ["roles", "users", "consultableBy", "peerableBy"] as const) {
    if ((key === "roles" || value.access[key] !== undefined) && !strings(value.access[key])) return `Configuration access ${key} must be a string array.`
  }
  if (!record(value.runtime) || typeof value.runtime.cwd !== "string") return "Configuration runtime cwd must be a string."
  const runtime = value.runtime
  if (runtime.model !== undefined && typeof runtime.model !== "string") return "Configuration runtime model must be a string."
  if (runtime.allowedTools !== undefined && !strings(runtime.allowedTools)) return "Configuration allowed tools must be a string array."
  for (const key of ["resumable", "useMemory", "coalesceBurst", "audit"] as const) {
    if (runtime[key] !== undefined && typeof runtime[key] !== "boolean") return `Configuration runtime ${key} must be true or false.`
  }
  if (runtime.injectContext !== undefined && runtime.injectContext !== "always" && runtime.injectContext !== "onSwitch" && runtime.injectContext !== "never") return "Configuration context injection must be always, onSwitch, or never."
  if (runtime.maxQueueDepth !== undefined && !nonNegativeInteger(runtime.maxQueueDepth)) return "Configuration queue depth must be a non-negative integer."
  if (runtime.overseer !== undefined) {
    if (!record(runtime.overseer) || typeof runtime.overseer.enabled !== "boolean") return "Configuration overseer must have a boolean enabled field."
    for (const key of ["maxIterations", "maxWallclockMs"] as const) if (runtime.overseer[key] !== undefined && !nonNegativeInteger(runtime.overseer[key])) return `Configuration overseer ${key} must be a non-negative integer.`
    if (runtime.overseer.model !== undefined && typeof runtime.overseer.model !== "string") return "Configuration overseer model must be a string."
  }
  if (runtime.sessionGovernor !== undefined) {
    if (!record(runtime.sessionGovernor) || typeof runtime.sessionGovernor.enabled !== "boolean") return "Configuration session governor must have a boolean enabled field."
    const governor = runtime.sessionGovernor
    if (governor.softPct !== undefined && !unit(governor.softPct)) return "Configuration session governor softPct must be between 0 and 1."
    if (governor.hardPct !== undefined && !unit(governor.hardPct)) return "Configuration session governor hardPct must be between 0 and 1."
    if (governor.strategy !== undefined && governor.strategy !== "restart" && governor.strategy !== "cli") return "Configuration session governor strategy must be restart or cli."
    const soft = typeof governor.softPct === "number" ? governor.softPct : .75
    const hard = typeof governor.hardPct === "number" ? governor.hardPct : .9
    if (soft > hard) return "Configuration session governor soft threshold cannot exceed the hard threshold."
  }
  if (runtime.pool !== undefined) {
    if (!record(runtime.pool)) return "Configuration pool must be an object."
    for (const key of ["min", "max", "scaleUpQueue", "scaleUpSustainMs", "replicaIdleMs"] as const) if (runtime.pool[key] !== undefined && !nonNegativeInteger(runtime.pool[key])) return `Configuration pool ${key} must be a non-negative integer.`
    if (runtime.pool.isolateCwd !== undefined && typeof runtime.pool.isolateCwd !== "boolean") return "Configuration pool isolateCwd must be true or false."
    if (typeof runtime.pool.min === "number" && typeof runtime.pool.max === "number" && runtime.pool.min > runtime.pool.max) return "Configuration pool minimum cannot exceed maximum."
  }
  const originalRuntime = record(original) && record(original.runtime) ? original.runtime : undefined
  const opaque: Array<["claudeArgs" | "appendSystemPrompt", "array" | "string"]> = [["claudeArgs", "array"], ["appendSystemPrompt", "string"]]
  for (const [key, kind] of opaque) {
    const candidate = runtime[key]
    if (isConfiguredValueSentinel(candidate)) {
      if (!isConfiguredValueSentinel(originalRuntime?.[key])) return "Configured values can only preserve a value already configured on the server."
    } else if (candidate !== undefined && (kind === "array" ? !strings(candidate) : typeof candidate !== "string")) {
      return key === "claudeArgs" ? "Claude arguments must be a string array or the unchanged configured value." : "Appended system prompt must be a string or the unchanged configured value."
    }
  }
  return null
}
