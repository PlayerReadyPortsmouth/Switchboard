import type { AgentConfig } from "./types"
import type { PooledReplica } from "./agentPool"
import type { GitExec } from "./threadGit"
import { addWorktree, removeWorktree } from "./threadGit"
import { ThreadStateStore } from "./threadState"

export interface ThreadAgentDeps {
  spawn: (threadId: string, agentName: string, cfg: AgentConfig) => Promise<PooledReplica>
  // Counterpart to `spawn`: called right after a replica is closed (suspend or
  // hard cleanup) so the caller can drop its own bookkeeping (e.g. the shared
  // transport map) for this thread. Never skip this — an un-despawned entry
  // leaks forever and can route a later interaction to a closed transport.
  despawn: (threadId: string) => void
  git: GitExec
  baseCwd: (agentName: string, threadWorktreeRepo?: string) => string
  worktreeRoot: (agentName: string, threadWorktreeRepo?: string) => string
  idleTimeoutMinutes: number
  maxConcurrentInstancesPerChannel: number
  now?: () => number
}

export type EnsureInstanceResult =
  | { ok: true; replica: PooledReplica }
  | { ok: false; reason: "cap" }
  | { ok: false; reason: "worktree_error"; error: string }

/** Owns the lifecycle of per-thread agent instances: lazy spawn (worktree +
 *  process) on first message, reuse while live, cap enforcement per parent
 *  channel, idle suspend/resume, and dirty-guarded hard cleanup. */
export class ThreadAgentRegistry {
  private live = new Map<string, PooledReplica>()   // threadId → live replica
  // In-flight ensureInstance() calls, keyed by threadId. Two near-simultaneous
  // messages on a brand-new thread both see no live/prior state and would
  // otherwise race to `addWorktree` the identical path (the second `git
  // worktree add` fails with "already exists" and its message gets dropped).
  // Coalescing them onto the same promise makes the second caller await the
  // first's in-progress spawn instead of racing it.
  private inFlight = new Map<string, Promise<EnsureInstanceResult>>()

  constructor(private store: ThreadStateStore, private deps: ThreadAgentDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private liveCountForChannel(parentChannelId: string): number {
    let n = 0
    for (const [threadId, state] of Object.entries(this.store.all())) {
      if (state.parentChannelId === parentChannelId && this.live.has(threadId)) n++
    }
    return n
  }

  async ensureInstance(
    threadId: string, parentChannelId: string, agentName: string, agentCfg: AgentConfig, threadWorktreeRepo?: string,
  ): Promise<EnsureInstanceResult> {
    const pending = this.inFlight.get(threadId)
    if (pending) return pending
    const p = this.doEnsureInstance(threadId, parentChannelId, agentName, agentCfg, threadWorktreeRepo)
      .finally(() => this.inFlight.delete(threadId))
    this.inFlight.set(threadId, p)
    return p
  }

  private async doEnsureInstance(
    threadId: string, parentChannelId: string, agentName: string, agentCfg: AgentConfig, threadWorktreeRepo?: string,
  ): Promise<EnsureInstanceResult> {
    const prior = this.store.get(threadId)
    const existing = this.live.get(threadId)
    // Persisted `live: false` (set by sweepIdle, or a hard cleanup racing this
    // call) is authoritative over a stale in-memory entry: close it and fall
    // through to a fresh spawn rather than handing back a suspended replica.
    if (existing && prior?.live !== false) return { ok: true, replica: existing }
    if (existing) { await existing.close(); this.live.delete(threadId) }

    if (!prior && this.liveCountForChannel(parentChannelId) >= this.deps.maxConcurrentInstancesPerChannel) {
      return { ok: false, reason: "cap" }
    }

    // Deliberately not path.join: worktreeRoot/baseCwd are unix-style paths on
    // the (Linux) production host, and path.join would silently normalize to
    // OS-native separators, corrupting them under Windows dev sandboxes.
    const root = this.deps.worktreeRoot(agentName, threadWorktreeRepo)
    const worktreePath = `${root.endsWith("/") ? root.slice(0, -1) : root}/${threadId}`
    if (!prior) {
      const wt = await addWorktree(this.deps.git, this.deps.baseCwd(agentName, threadWorktreeRepo), worktreePath)
      if (!wt.ok) return { ok: false, reason: "worktree_error", error: wt.error ?? "unknown git error" }
    }

    const threadCfg: AgentConfig = { ...agentCfg, runtime: { ...agentCfg.runtime, cwd: worktreePath, resumable: true } }
    const replica = await this.deps.spawn(threadId, agentName, threadCfg)

    this.live.set(threadId, replica)
    this.store.set(threadId, { agentName, parentChannelId, worktreePath, lastActive: this.now(), live: true })
    return { ok: true, replica }
  }

  /** Kill (but don't delete) every thread instance idle past the configured
   *  timeout. State and worktree are retained so the next message resumes. */
  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.deps.idleTimeoutMinutes * 60_000
    for (const [threadId, replica] of this.live) {
      if (replica.lastActivityMs() > cutoff) continue
      await replica.close()
      this.live.delete(threadId)
      this.deps.despawn(threadId)
      const s = this.store.get(threadId)
      if (s) this.store.set(threadId, { ...s, live: false, lastActive: this.now() })
    }
  }

  /** Hard cleanup for a Discord-archived/deleted thread: kill the process if
   *  still live, remove the worktree, and drop stored state — unless
   *  removeWorktree fails for ANY reason (dirty worktree, permissions, or any
   *  other git error), in which case nothing is deleted (state stays so a
   *  future manual recovery can find it). No-op success for an unknown thread. */
  async hardCleanup(threadId: string): Promise<{ ok: true } | { ok: false; dirty: boolean; error?: string }> {
    const s = this.store.get(threadId)
    if (!s) return { ok: true }
    const replica = this.live.get(threadId)
    if (replica) { await replica.close(); this.live.delete(threadId); this.deps.despawn(threadId) }
    const r = await removeWorktree(this.deps.git, s.worktreePath)
    if (!r.ok) return { ok: false, dirty: !!r.dirty, error: r.error }
    this.store.delete(threadId)
    return { ok: true }
  }
}
