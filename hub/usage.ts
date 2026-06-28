import type { TurnUsage } from "./types"

/** Default context window (tokens) used when a model is not in the override map. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** The prompt size sent on the last turn ≈ the conversation's current context
 *  fill: fresh input + everything read from / written to the prompt cache. */
export function contextTokens(u: TurnUsage): number {
  return num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheCreationTokens)
}

/** Resolve a model's context window from the override map (falls back to a
 *  `default` entry, then the hard default). */
export function contextWindow(model: string | undefined, windows?: Record<string, number>): number {
  if (model && windows && typeof windows[model] === "number") return windows[model]!
  if (windows && typeof windows.default === "number") return windows.default
  return DEFAULT_CONTEXT_WINDOW
}

/** Fraction (0..1) of the model's context window the last turn consumed. */
export function fillPct(u: TurnUsage, model: string | undefined, windows?: Record<string, number>): number {
  const w = contextWindow(model, windows)
  return w > 0 ? contextTokens(u) / w : 0
}

/** Parse just the token counts from a raw `usage` object (e.g. an `assistant`
 *  message's `message.usage`). No turn-level cost/meta. Defensive: missing/odd
 *  input → undefined, never throws. */
export function parseUsageObj(u: any): TurnUsage | undefined {
  if (!u || typeof u !== "object") return undefined
  return {
    inputTokens: num(u.input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
  }
}

/** Parse the `usage` object (+ turn metadata) from a raw stream-json `result`
 *  event. Defensive: any missing/odd field becomes 0/undefined, never throws.
 *  Returns undefined when there is no `usage` object at all. NOTE: a `result`
 *  event's usage is CUMULATIVE across the whole turn (every internal tool-call
 *  and sub-agent), so its token counts must NOT be treated as the live context
 *  size — use the final `assistant` frame's usage for fill (see blendUsage). */
export function parseUsage(ev: any): TurnUsage | undefined {
  const base = parseUsageObj(ev?.usage)
  if (!base) return undefined
  return {
    ...base,
    numTurns: optNum(ev.num_turns),
    costUsd: optNum(ev.total_cost_usd),
    durationMs: optNum(ev.duration_ms),
  }
}

/** Combine the final assistant call's usage (`ctx` ≈ the live prompt size, which
 *  is what context fill should measure) with the result event's usage (`cost` ≈
 *  the whole turn's cumulative cost/throughput). Context-fill fields come from
 *  `ctx`; cost/meta fields from `cost`. This stops cumulative turn usage —
 *  inflated by tool-loops and sub-agents — being read as context size (which
 *  could push fill past 100% and trigger spurious compaction). Either side may
 *  be absent; falls back to whichever is present. */
export function blendUsage(ctx?: TurnUsage, cost?: TurnUsage): TurnUsage | undefined {
  if (!ctx && !cost) return undefined
  const c = ctx ?? cost!
  const k = cost ?? ctx!
  return {
    inputTokens: c.inputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheCreationTokens: c.cacheCreationTokens,
    outputTokens: k.outputTokens,
    numTurns: k.numTurns,
    costUsd: k.costUsd,
    durationMs: k.durationMs,
  }
}

function num(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0 }
function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}
