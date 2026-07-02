import type { AgentConfig } from "./types"
import type { PooledReplica } from "./agentPool"
import type { GitExec } from "./threadGit"
import { addWorktree } from "./threadGit"
import { ThreadStateStore } from "./threadState"

export interface ThreadAgentDeps {
  spawn: (threadId: string, agentName: string, cfg: AgentConfig) => Promise<PooledReplica>
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
 *  channel. Suspend/resume + hard cleanup are added in Task 6. */
export class ThreadAgentRegistry {
  private live = new Map<string, PooledReplica>()   // threadId → live replica

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
    const existing = this.live.get(threadId)
    if (existing) return { ok: true, replica: existing }

    const prior = this.store.get(threadId)
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
}
