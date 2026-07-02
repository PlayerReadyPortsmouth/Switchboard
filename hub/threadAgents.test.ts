import { test, expect, mock } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ThreadAgentRegistry, type ThreadAgentDeps } from "./threadAgents"
import { ThreadStateStore } from "./threadState"
import type { AgentConfig } from "./types"

function fakeReplica(name: string) {
  let alive = true
  return {
    name, isAvailable: () => alive, isBusy: () => false, queueDepth: () => 0,
    fillPct: () => 0, lastUsageInfo: () => null, lastActivityMs: () => Date.now(),
    deliver: () => {}, onReply: () => {}, sendInteraction: () => {},
    close: async () => { alive = false },
  }
}

const cfg: AgentConfig = {
  emoji: "🤖", description: "dev", mode: "persistent",
  access: { roles: ["*"] }, runtime: { cwd: "/repo" },
}

function makeRegistry(overrides: Partial<ThreadAgentDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "threadagents-"))
  const store = new ThreadStateStore(join(dir, "thread-agents.json"))
  const spawn = mock(async (threadId: string, agentName: string) => fakeReplica(`${agentName}#${threadId}`))
  const git = mock(async () => ({ code: 0, stdout: "", stderr: "" }))
  const deps: ThreadAgentDeps = {
    spawn, git, baseCwd: () => "/repo", worktreeRoot: () => "/repo/.threads",
    idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 2, ...overrides,
  }
  return { registry: new ThreadAgentRegistry(store, deps), store, spawn, git }
}

test("ensureInstance spawns a fresh instance on first call for a thread", async () => {
  const { registry, spawn } = makeRegistry()
  const r = await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  expect(r.ok).toBe(true)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledWith("t1", "dev-agent", expect.objectContaining({ runtime: expect.objectContaining({ cwd: "/repo/.threads/t1", resumable: true }) }))
})

test("ensureInstance reuses the live instance on a second call for the same thread", async () => {
  const { registry, spawn } = makeRegistry()
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  expect(spawn).toHaveBeenCalledTimes(1)
})

test("ensureInstance creates a worktree via git before spawning", async () => {
  const { registry, git } = makeRegistry()
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  expect(git).toHaveBeenCalledWith(["worktree", "add", "--detach", "/repo/.threads/t1", "HEAD"], "/repo")
})

test("ensureInstance branches the worktree from threadWorktreeRepo when the agent's cwd holds multiple repos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadagents-"))
  const store = new ThreadStateStore(join(dir, "thread-agents.json"))
  const spawn = mock(async (threadId: string, agentName: string) => fakeReplica(`${agentName}#${threadId}`))
  const git = mock(async () => ({ code: 0, stdout: "", stderr: "" }))
  const multiRepoCfg: AgentConfig = { ...cfg, runtime: { ...cfg.runtime, cwd: "/srv/dev-agent" } }
  const registry = new ThreadAgentRegistry(store, {
    spawn, git,
    baseCwd: (agentName, repo) => repo ? `/srv/dev-agent/${repo}` : "/srv/dev-agent",
    worktreeRoot: (agentName, repo) => `${repo ? `/srv/dev-agent/${repo}` : "/srv/dev-agent"}/.threads`,
    idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5,
  })
  await registry.ensureInstance("t1", "chanA", "dev-agent", multiRepoCfg, "readyapp")
  expect(git).toHaveBeenCalledWith(["worktree", "add", "--detach", "/srv/dev-agent/readyapp/.threads/t1", "HEAD"], "/srv/dev-agent/readyapp")
  expect(spawn).toHaveBeenCalledWith("t1", "dev-agent", expect.objectContaining({ runtime: expect.objectContaining({ cwd: "/srv/dev-agent/readyapp/.threads/t1" }) }))
})

test("ensureInstance rejects a new thread once the per-channel cap is reached", async () => {
  const { registry } = makeRegistry({ maxConcurrentInstancesPerChannel: 1 })
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  const r = await registry.ensureInstance("t2", "chanA", "dev-agent", cfg)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toBe("cap")
})

test("ensureInstance for a different parent channel is unaffected by another channel's cap", async () => {
  const { registry } = makeRegistry({ maxConcurrentInstancesPerChannel: 1 })
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  const r = await registry.ensureInstance("t2", "chanB", "dev-agent", cfg)
  expect(r.ok).toBe(true)
})

test("ensureInstance reports worktree_error and never spawns when git worktree add fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadagents-"))
  const store = new ThreadStateStore(join(dir, "thread-agents.json"))
  const spawn = mock(async (threadId: string, agentName: string) => fakeReplica(`${agentName}#${threadId}`))
  const git = mock(async () => ({ code: 128, stdout: "", stderr: "fatal: disk full" }))
  const registry = new ThreadAgentRegistry(store, {
    spawn, git, baseCwd: () => "/repo", worktreeRoot: () => "/repo/.threads",
    idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5,
  })
  const r = await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  expect(r.ok).toBe(false)
  if (!r.ok && r.reason === "worktree_error") { expect(r.error).toContain("disk full") } else { expect.unreachable() }
  expect(spawn).not.toHaveBeenCalled()
  expect(store.get("t1")).toBeUndefined() // no partial state left behind
})

test("sweepIdle suspends (closes) a replica idle past idleTimeoutMinutes, keeps its state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadagents-"))
  const store = new ThreadStateStore(join(dir, "thread-agents.json"))
  let closed = false
  const spawn = mock(async (threadId: string, agentName: string) => ({
    ...fakeReplica(`${agentName}#${threadId}`),
    lastActivityMs: () => 0, // "a long time ago" relative to now()
    close: async () => { closed = true },
  }))
  const git = mock(async () => ({ code: 0, stdout: "", stderr: "" }))
  const registry = new ThreadAgentRegistry(store, {
    spawn, git, baseCwd: () => "/repo", worktreeRoot: () => "/repo/.threads",
    idleTimeoutMinutes: 1, maxConcurrentInstancesPerChannel: 5, now: () => 10 * 60_000, // 10 min in
  })
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  await registry.sweepIdle()
  expect(closed).toBe(true)
  expect(store.get("t1")?.live).toBe(false)
  expect(store.get("t1")?.worktreePath).toBe("/repo/.threads/t1") // state retained
})

test("ensureInstance after a suspend reuses the same worktree and spawns again with the same key inputs", async () => {
  const { registry, spawn, git, store } = makeRegistry()
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  store.set("t1", { ...store.get("t1")!, live: false }) // simulate sweepIdle having run
  git.mockClear(); spawn.mockClear()
  const r = await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  expect(r.ok).toBe(true)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledWith("t1", "dev-agent", expect.objectContaining({ runtime: expect.objectContaining({ cwd: "/repo/.threads/t1" }) }))
  expect(git).not.toHaveBeenCalled() // no second worktree add — resume reuses the existing checkout
})

test("hardCleanup removes the worktree and deletes state when clean", async () => {
  const { registry, store } = makeRegistry()
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  const r = await registry.hardCleanup("t1")
  expect(r.ok).toBe(true)
  expect(store.get("t1")).toBeUndefined()
})

test("hardCleanup leaves state intact and reports dirty when the worktree has uncommitted changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadagents-"))
  const store = new ThreadStateStore(join(dir, "thread-agents.json"))
  const spawn = mock(async (threadId: string, agentName: string) => fakeReplica(`${agentName}#${threadId}`))
  const git = mock(async (argv: string[]) =>
    argv[0] === "status" ? { code: 0, stdout: " M dirty.ts\n", stderr: "" } : { code: 0, stdout: "", stderr: "" })
  const registry = new ThreadAgentRegistry(store, {
    spawn, git, baseCwd: () => "/repo", worktreeRoot: () => "/repo/.threads",
    idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5,
  })
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  const r = await registry.hardCleanup("t1")
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.dirty).toBe(true)
  expect(store.get("t1")).toBeDefined() // not deleted
})

test("hardCleanup leaves state intact and reports the error when worktree remove fails for a non-dirty reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadagents-"))
  const store = new ThreadStateStore(join(dir, "thread-agents.json"))
  const spawn = mock(async (threadId: string, agentName: string) => fakeReplica(`${agentName}#${threadId}`))
  const git = mock(async (argv: string[]) =>
    argv[0] === "worktree" && argv[1] === "remove"
      ? { code: 128, stdout: "", stderr: "fatal: permission denied" }
      : { code: 0, stdout: "", stderr: "" })
  const registry = new ThreadAgentRegistry(store, {
    spawn, git, baseCwd: () => "/repo", worktreeRoot: () => "/repo/.threads",
    idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5,
  })
  await registry.ensureInstance("t1", "chanA", "dev-agent", cfg)
  const r = await registry.hardCleanup("t1")
  expect(r.ok).toBe(false)
  if (!r.ok) { expect(r.dirty).toBe(false); expect(r.error).toContain("permission denied") }
  expect(store.get("t1")).toBeDefined() // not deleted
})

test("hardCleanup on an unknown thread is a no-op success", async () => {
  const { registry } = makeRegistry()
  const r = await registry.hardCleanup("nope")
  expect(r.ok).toBe(true)
})
