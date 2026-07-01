/** Effort escalation (pure helpers).
 *
 *  A persistent agent is one long-lived `claude` process, so its per-turn effort
 *  (model / reasoning args) is fixed at spawn. To re-run a turn at higher effort we
 *  spawn a short-lived ephemeral CLONE whose runtime swaps in a stronger model and
 *  extra CLI args. Escalation fires two ways (both live in index.ts): manually via
 *  `!hard` (re-run the chat's last turn) and automatically when a turn's tool
 *  results carried error signals. This module holds the pure pieces: building the
 *  clone runtime, counting error signals, and a fixed-window rate cap for the auto
 *  path so a flapping tool can't spawn escalations without bound. */

import type { AgentRuntime } from "./types"

export interface EscalationOptions {
  model?: string          // stronger model for the clone; absent ⇒ keep the base model
  claudeArgs?: string[]   // extra CLI args appended for the clone (e.g. a reasoning-effort flag)
}

/** The higher-effort runtime for an escalated ephemeral clone: swap in the
 *  escalation model (if any) and append its extra args, always a clean run
 *  (non-resumable, no memory, no context injection) so the retry is maximal-effort
 *  and self-contained. */
export function escalatedRuntime(base: AgentRuntime, opts: EscalationOptions): AgentRuntime {
  return {
    ...base,
    model: opts.model ?? base.model,
    claudeArgs: [...(base.claudeArgs ?? []), ...(opts.claudeArgs ?? [])],
    resumable: false,
    useMemory: false,
    injectContext: undefined,
  }
}

/** How many of a turn's tool results were errors. */
export function countErrors(results: { isError: boolean }[]): number {
  return results.reduce((n, r) => n + (r.isError ? 1 : 0), 0)
}

/** A fixed-window rate cap: at most `max` takes per `windowMs`. Pure given a clock.
 *  `max <= 0` blocks everything (auto-escalation off). */
export class RateCap {
  private hits: number[] = []
  constructor(private now: () => number, private max: number, private windowMs = 3_600_000) {}
  tryTake(): boolean {
    if (this.max <= 0) return false
    const cutoff = this.now() - this.windowMs
    this.hits = this.hits.filter((t) => t >= cutoff)
    if (this.hits.length >= this.max) return false
    this.hits.push(this.now())
    return true
  }
}
