/** Keeps a "typing…" indicator alive on a surface while an agent works a turn.
 *
 *  Discord's typing indicator expires after about ten seconds, so a single ping is
 *  useless for a turn that takes twenty. This refreshes it until the turn settles.
 *
 *  Three properties matter and are what the tests pin:
 *   - **Idempotent start.** A second `start` for a conversation already typing does
 *     nothing, so concurrent turns in one channel cannot stack timers.
 *   - **Bounded.** An agent that never replies would otherwise leave a channel typing
 *     forever. The indicator gives up after `maxMs` even with no terminal state.
 *   - **Never throws.** A failed ping is cosmetic. It must not reach the turn. */
export interface TypingNotifierOptions {
  /** Send one ping. Errors are swallowed by the notifier, so this may throw. */
  send: (conversationId: string) => void | Promise<unknown>
  /** How often to re-ping. Default 8000ms: Discord expires at ~10s. */
  refreshMs?: number
  /** Give up after this long with no terminal state. Default 120000ms. */
  maxMs?: number
  /** Injected for tests. Defaults to setInterval/clearInterval, unref'd so a live
   *  timer can never hold a process (or a test runner) open. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

export interface TypingNotifier {
  start(conversationId: string): void
  stop(conversationId: string): void
  /** Stop everything — used on shutdown so no timer outlives the hub. */
  stopAll(): void
}

export function createTypingNotifier(options: TypingNotifierOptions): TypingNotifier {
  const refreshMs = options.refreshMs ?? 8_000
  const maxMs = options.maxMs ?? 120_000
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setInterval(fn, ms)
    // Node/Bun only: a typing refresh must never be the reason a process stays alive.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  })
  const clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))

  const live = new Map<string, { handle: unknown; startedAt: number }>()

  const ping = (conversationId: string): void => {
    try { void Promise.resolve(options.send(conversationId)).catch(() => {}) } catch {}
  }

  const stop = (conversationId: string): void => {
    const entry = live.get(conversationId)
    if (!entry) return
    live.delete(conversationId)
    try { clearTimer(entry.handle) } catch {}
  }

  return {
    start(conversationId: string): void {
      if (live.has(conversationId)) return
      const startedAt = now()
      const handle = setTimer(() => {
        if (now() - startedAt >= maxMs) { stop(conversationId); return }
        ping(conversationId)
      }, refreshMs)
      live.set(conversationId, { handle, startedAt })
      ping(conversationId)
    },
    stop,
    stopAll(): void {
      for (const conversationId of [...live.keys()]) stop(conversationId)
    },
  }
}
