# Per-Thread Dev-Agent Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord thread under a channel pinned to an agent (e.g. `dev-agent`) gets its own dedicated `claude` process, git worktree, and resumable session — independent of the channel's own shared pinned-agent process and of every other thread.

**Architecture:** Extend `ChannelAgent` with a `threaded` flag and add a hub-level `threadAgents` toggle (mirrors the `trace`/`attachments` sub-object convention). A new pure resolver (`resolveThreadAgent`, alongside the existing `resolvePinnedAgent` in `channelPin.ts`) decides whether an inbound thread message should route to a per-thread instance. A new `ThreadAgentRegistry` (new file `hub/threadAgents.ts`) owns the lifecycle — lazily creating a git worktree + spawning a transport on first message, suspending (kill process, keep files) on idle, resuming on the next message, and hard-cleaning (remove worktree + session) on Discord thread archive/delete. It follows the exact spawn/cleanup shape already used by `spawnConsultClone`/`runSpawnTrigger` in `hub/index.ts` (build a cloned `AgentConfig`, call `makeTransport`, track by a synthetic key, clean up out-of-band) — it does not touch the main `Dispatcher`, which stays one-transport-per-agent-name for normal (non-threaded) routing.

Session resume needs no bookkeeping of its own: `makeTransport` already derives a transport's session file path from its `key` (`<stateDir>/<key>.session`) and `StreamJsonTransport` already reads/writes that file whenever `runtime.resumable` is true. Giving every spawn for the same thread the same key (`thread-<threadId>`) means suspend-then-resume "just works" through the existing mechanism — the registry only needs to track *whether* a live process exists, not *what session id* it had.

**Tech Stack:** TypeScript, Bun (runtime + `bun:test`), Discord.js v14, `git worktree`.

## Global Constraints

- Follow existing DI/testability conventions: every side-effecting dependency (spawn, git exec, clock) is injected, mirroring `ReplicaPoolDeps`, `BindingStore`, `StreamJsonOpts`.
- `threadAgents.enabled: false` (or the section absent) must leave behavior byte-identical to today, hub-wide, matching the `trace`/`attachments` fail-closed pattern.
- Never destroy work silently: a dirty worktree at hard-cleanup time is left in place with a warning, not force-removed.
- DRY, YAGNI, TDD, commit per task.

---

### Task 1: Config schema + thread detection

**Files:**
- Modify: `hub/types.ts`
- Modify: `hub/gateway.ts`
- Test: `hub/gateway.test.ts` (create if it doesn't already exist — check first with `ls hub/gateway.test.ts`; if it exists, add to it following its existing mocking style)

**Interfaces:**
- Produces (consumed by Task 2+): `ChannelAgent.threaded?: boolean`, `ThreadAgentsConfig { enabled: boolean; idleTimeoutMinutes: number; maxConcurrentInstancesPerChannel: number }`, `HubConfig.threadAgents?: ThreadAgentsConfig`, `InboundMessage.threadParentId?: string`.

- [ ] **Step 1: Add the config types**

In `hub/types.ts`, extend `ChannelAgent` (around line 216-220):

```ts
export interface ChannelAgent {
  channelId: string;
  agent: string;
  clearReaction?: string;
  threaded?: boolean; // threads under this channel get their own agent instance (requires hub.threadAgents.enabled)
  threadWorktreeRepo?: string; // when the agent's runtime.cwd holds multiple repo checkouts (not a repo itself), name the subdirectory each thread's isolated worktree branches from. Absent ⇒ runtime.cwd itself is the base repo.
}
```

**Why `threadWorktreeRepo` exists:** some agents' `runtime.cwd` isn't a single git repo — `dev-agent`'s is `/srv/dev-agent`, a directory holding four separate repo checkouts (`readyapp`, `switchboard`, `ready-switchboard`, `readyfleet`). `git worktree add` needs an actual repo to branch from, so for those agents the pin must say which one (e.g. `threadWorktreeRepo: "readyapp"`). **Known limitation:** a threaded instance's cwd becomes exactly that one isolated repo checkout — it does not also get the agent's other repos alongside it the way the always-on channel agent does. If a thread's task needs a second repo, that's out of scope for this design (a future enhancement, not required here).

Add a new interface near the other `*Config` interfaces (e.g. after `ReceiptsConfig`, around line 317):

```ts
/** Per-thread dev-agent instances. Absent/disabled ⇒ threads under a pinned
 *  channel fall through to the default agent exactly as before (byte-identical).
 *  When enabled, a `channelAgents` entry with `threaded: true` spawns a
 *  dedicated, worktree-isolated instance per Discord thread. */
export interface ThreadAgentsConfig {
  enabled: boolean;
  idleTimeoutMinutes: number;             // default 60 — suspend (not destroy) after this much inactivity
  maxConcurrentInstancesPerChannel: number; // default 5 — cap live processes per parent channel
}
```

Add the field to `HubConfig` (near `channelAgents`, line 279):

```ts
  channelAgents?: ChannelAgent[];  // channels pinned to a specific agent
  threadAgents?: ThreadAgentsConfig; // per-thread dedicated agent instances (default off)
```

And extend `InboundMessage` (top of the file, line 1-13):

```ts
export interface InboundMessage {
  chatId: string        // Discord channel id (DM channel or guild channel)
  messageId: string
  userId: string        // author snowflake
  user: string          // author username
  content: string
  ts: string            // ISO timestamp
  isDM: boolean
  threadParentId?: string  // set when chatId is a Discord thread: the parent channel's id
  attachments?: { name: string; type: string; size: number; url?: string }[]
  quote?: { user: string; content: string }   // the message this one quote-replies to
  forwards?: { content: string }[]             // forwarded message snapshot text (Discord forward feature; no author)
}
```

- [ ] **Step 2: Write the failing test for thread detection in gateway.ts**

Read `hub/gateway.test.ts` first if it exists to match its exact mock style (fake Discord client). If no such file exists yet, create it with a minimal harness that only exercises the `messageCreate` handler's payload construction — do not build a full Discord.js mock; instead extract the payload-building logic so it's unit-testable. Add this test:

```ts
// hub/gateway.test.ts
import { test, expect } from "bun:test"
import { buildInboundFromMessage } from "./gateway"
import { ChannelType } from "discord.js"

test("buildInboundFromMessage sets threadParentId for a thread message", () => {
  const msg = {
    channelId: "thread123", id: "m1",
    author: { id: "u1", username: "alice", bot: false },
    content: "hi", createdAt: new Date("2026-07-02T00:00:00Z"),
    channel: { type: ChannelType.PublicThread, isThread: () => true, parentId: "chan456" },
    attachments: new Map(), reference: null,
  } as any
  const inbound = buildInboundFromMessage(msg, [])
  expect(inbound.chatId).toBe("thread123")
  expect(inbound.threadParentId).toBe("chan456")
})

test("buildInboundFromMessage omits threadParentId for a non-thread message", () => {
  const msg = {
    channelId: "chan456", id: "m2",
    author: { id: "u1", username: "alice", bot: false },
    content: "hi", createdAt: new Date("2026-07-02T00:00:00Z"),
    channel: { type: ChannelType.GuildText, isThread: () => false },
    attachments: new Map(), reference: null,
  } as any
  const inbound = buildInboundFromMessage(msg, [])
  expect(inbound.threadParentId).toBeUndefined()
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test hub/gateway.test.ts`
Expected: FAIL — `buildInboundFromMessage` is not exported from `hub/gateway.ts` (it doesn't exist yet as a standalone function; today the equivalent logic is inlined in the `messageCreate` handler).

- [ ] **Step 4: Extract and export `buildInboundFromMessage`, populate `threadParentId`**

In `hub/gateway.ts`, factor the `messageCreate` handler's payload construction (lines ~242-253) into a standalone exported function, and call it from the handler:

```ts
/** Build the normalised InboundMessage from a raw discord.js Message, given its
 *  already-resolved quote/forwards. Exported for unit testing (see gateway.test.ts). */
export function buildInboundFromMessage(
  msg: Message,
  forwards: { content: string; attachments: { name: string; type: string; size: number; url?: string }[] }[],
  quote?: { user: string; content: string },
): InboundMessage {
  return {
    chatId: msg.channelId, messageId: msg.id, userId: msg.author.id,
    user: msg.author.username, content: msg.content,
    ts: msg.createdAt.toISOString(), isDM: msg.channel.type === ChannelType.DM,
    threadParentId: "isThread" in msg.channel && msg.channel.isThread() ? (msg.channel.parentId ?? undefined) : undefined,
    attachments: [
      ...[...msg.attachments.values()].map(a => ({
        name: a.name ?? a.id, type: a.contentType ?? "unknown", size: a.size, url: a.url })),
      ...forwards.flatMap(f => f.attachments),
    ],
    quote,
    forwards: forwards.length ? forwards.map(f => ({ content: f.content })) : undefined,
  }
}
```

Then replace the body of the `messageCreate` handler's `this.onMessage({...})` call with:

```ts
        this.onMessage(buildInboundFromMessage(msg, forwards, quote))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test hub/gateway.test.ts`
Expected: PASS (both cases).
Also run: `bunx tsc --noEmit` — 0 new errors (the pre-existing 2 tsc errors from `index.ts` `writeFileSync` are unrelated and expected, per the known-green baseline).

- [ ] **Step 6: Commit**

```bash
git add hub/types.ts hub/gateway.ts hub/gateway.test.ts
git commit -m "feat(threads): thread-parent config types + threadParentId on InboundMessage"
```

---

### Task 2: Pure thread-routing resolver

**Files:**
- Modify: `hub/channelPin.ts`
- Modify: `hub/channelPin.test.ts`

**Interfaces:**
- Consumes: `ChannelAgent`, `ThreadAgentsConfig` (Task 1).
- Produces (consumed by Task 7): `ThreadRoute { agent: string; threadWorktreeRepo?: string }`, `resolveThreadAgent(threadParentId: string | undefined, pins: ChannelAgent[], threadCfg: ThreadAgentsConfig | undefined): ThreadRoute | null`.

- [ ] **Step 1: Write the failing test**

Append to `hub/channelPin.test.ts`:

```ts
import { resolveThreadAgent } from "./channelPin"
import type { ThreadAgentsConfig } from "./types"

const threadedPins: ChannelAgent[] = [
  { channelId: "chanA", agent: "dev-agent", threaded: true, threadWorktreeRepo: "readyapp" },
  { channelId: "chanB", agent: "other" }, // not threaded
]
const cfgOn: ThreadAgentsConfig = { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 }
const cfgOff: ThreadAgentsConfig = { ...cfgOn, enabled: false }

test("resolveThreadAgent returns the agent + threadWorktreeRepo when the parent channel is pinned+threaded and the feature is on", () => {
  expect(resolveThreadAgent("chanA", threadedPins, cfgOn)).toEqual({ agent: "dev-agent", threadWorktreeRepo: "readyapp" })
})
test("resolveThreadAgent returns null when the parent channel isn't threaded", () => {
  expect(resolveThreadAgent("chanB", threadedPins, cfgOn)).toBeNull()
})
test("resolveThreadAgent returns null when hub-wide threadAgents is off, even if the pin is threaded", () => {
  expect(resolveThreadAgent("chanA", threadedPins, cfgOff)).toBeNull()
})
test("resolveThreadAgent returns null when threadCfg is absent", () => {
  expect(resolveThreadAgent("chanA", threadedPins, undefined)).toBeNull()
})
test("resolveThreadAgent returns null when threadParentId is undefined (not a thread message)", () => {
  expect(resolveThreadAgent(undefined, threadedPins, cfgOn)).toBeNull()
})
test("resolveThreadAgent omits threadWorktreeRepo when the pin doesn't set one", () => {
  const pins: ChannelAgent[] = [{ channelId: "chanC", agent: "solo-agent", threaded: true }]
  expect(resolveThreadAgent("chanC", pins, cfgOn)).toEqual({ agent: "solo-agent", threadWorktreeRepo: undefined })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/channelPin.test.ts`
Expected: FAIL — `resolveThreadAgent` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `hub/channelPin.ts`:

```ts
import type { ThreadAgentsConfig } from "./types"

export interface ThreadRoute { agent: string; threadWorktreeRepo?: string }

/** The agent (and, if the pin names one, which repo subdirectory of its cwd)
 *  a Discord thread should route to as its own dedicated instance, or null
 *  when threading isn't in play (not a thread, parent not pinned, parent not
 *  opted in, or the hub-wide feature is off). */
export function resolveThreadAgent(
  threadParentId: string | undefined,
  pins: ChannelAgent[],
  threadCfg: ThreadAgentsConfig | undefined,
): ThreadRoute | null {
  if (!threadParentId || !threadCfg?.enabled) return null
  const pin = pins.find((p) => p.channelId === threadParentId)
  return pin?.threaded ? { agent: pin.agent, threadWorktreeRepo: pin.threadWorktreeRepo } : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/channelPin.test.ts`
Expected: PASS (all cases, including the 3 pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add hub/channelPin.ts hub/channelPin.test.ts
git commit -m "feat(threads): pure resolver for thread-to-agent routing"
```

---

### Task 3: Persisted per-thread state store

**Files:**
- Create: `hub/threadState.ts`
- Test: `hub/threadState.test.ts`

**Interfaces:**
- Produces (consumed by Task 4): `ThreadState { agentName: string; parentChannelId: string; worktreePath: string; lastActive: number; live: boolean }`, `ThreadStateStore` with `get(threadId)`, `set(threadId, state)`, `delete(threadId)`, `all(): Record<string, ThreadState>`.

Note: no session id is stored here. `makeTransport` already derives a transport's session file from its `key`, and giving every spawn for a thread the same key makes resume automatic (see Task 5) — tracking a session id here would just be a second, redundant source of truth.

- [ ] **Step 1: Write the failing test**

```ts
// hub/threadState.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ThreadStateStore } from "./threadState"

function tmpStore(): ThreadStateStore {
  const dir = mkdtempSync(join(tmpdir(), "threadstate-"))
  return new ThreadStateStore(join(dir, "thread-agents.json"))
}

test("set/get round-trips a thread state", () => {
  const store = tmpStore()
  store.set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  expect(store.get("t1")?.worktreePath).toBe("/tmp/wt1")
})

test("get returns undefined for an unknown thread", () => {
  const store = tmpStore()
  expect(store.get("nope")).toBeUndefined()
})

test("delete removes the entry", () => {
  const store = tmpStore()
  store.set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  store.delete("t1")
  expect(store.get("t1")).toBeUndefined()
})

test("all returns every stored thread keyed by threadId", () => {
  const store = tmpStore()
  store.set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  store.set("t2", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt2", lastActive: 2000, live: false })
  expect(Object.keys(store.all()).sort()).toEqual(["t1", "t2"])
})

test("persists across instances via the same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "threadstate-"))
  const path = join(dir, "thread-agents.json")
  new ThreadStateStore(path).set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  const reopened = new ThreadStateStore(path)
  expect(reopened.get("t1")?.parentChannelId).toBe("chanA")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/threadState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// hub/threadState.ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

export interface ThreadState {
  agentName: string
  parentChannelId: string
  worktreePath: string
  lastActive: number
  live: boolean
}

/** Persisted threadId → ThreadState store. Mirrors BindingStore (hub/bindings.ts). */
export class ThreadStateStore {
  private map: Record<string, ThreadState> = {}
  constructor(private path: string) {
    try { this.map = JSON.parse(readFileSync(path, "utf8")) } catch { this.map = {} }
  }
  get(threadId: string): ThreadState | undefined { return this.map[threadId] }
  set(threadId: string, s: ThreadState): void { this.map[threadId] = s; this.save() }
  delete(threadId: string): void { delete this.map[threadId]; this.save() }
  all(): Record<string, ThreadState> { return this.map }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/threadState.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/threadState.ts hub/threadState.test.ts
git commit -m "feat(threads): persisted per-thread state store"
```

---

### Task 4: Injectable git worktree operations

**Files:**
- Create: `hub/threadGit.ts`
- Test: `hub/threadGit.test.ts`

**Interfaces:**
- Produces (consumed by Task 5): `GitExec = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>`, `bunGitExec: GitExec`, `addWorktree(exec: GitExec, baseCwd: string, worktreePath: string): Promise<{ ok: boolean; error?: string }>`, `removeWorktree(exec: GitExec, worktreePath: string): Promise<{ ok: boolean; dirty?: boolean; error?: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// hub/threadGit.test.ts
import { test, expect } from "bun:test"
import { addWorktree, removeWorktree, type GitExec } from "./threadGit"

function fakeExec(responses: Record<string, { code: number; stdout: string; stderr: string }>): GitExec {
  return async (argv) => {
    const key = argv.join(" ")
    return responses[key] ?? { code: 1, stdout: "", stderr: `unexpected: ${key}` }
  }
}

test("addWorktree succeeds when git exits 0", async () => {
  const exec = fakeExec({ "worktree add --detach /wt/t1 HEAD": { code: 0, stdout: "", stderr: "" } })
  const r = await addWorktree(exec, "/repo", "/wt/t1")
  expect(r.ok).toBe(true)
})

test("addWorktree surfaces the error when git fails", async () => {
  const exec = fakeExec({ "worktree add --detach /wt/t1 HEAD": { code: 128, stdout: "", stderr: "fatal: already exists" } })
  const r = await addWorktree(exec, "/repo", "/wt/t1")
  expect(r.ok).toBe(false)
  expect(r.error).toContain("already exists")
})

test("removeWorktree is a no-op success path when the worktree is clean", async () => {
  const exec = fakeExec({
    "status --porcelain": { code: 0, stdout: "", stderr: "" },
    "worktree remove /wt/t1": { code: 0, stdout: "", stderr: "" },
  })
  const r = await removeWorktree(exec, "/wt/t1")
  expect(r.ok).toBe(true)
})

test("removeWorktree refuses when the worktree has uncommitted changes", async () => {
  const exec = fakeExec({ "status --porcelain": { code: 0, stdout: " M some/file.ts\n", stderr: "" } })
  const r = await removeWorktree(exec, "/wt/t1")
  expect(r.ok).toBe(false)
  expect(r.dirty).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/threadGit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// hub/threadGit.ts
export type GitExec = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

/** Real git executor: Bun.spawn against `git`, cwd = the base repo (for add) or
 *  the worktree itself (for status/remove). */
export const bunGitExec: GitExec = async (argv, cwd) => {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code: code ?? 0, stdout, stderr }
}

/** Create a detached-HEAD worktree at `worktreePath` from `baseCwd`'s current
 *  commit. Detached (not a new branch) so concurrent threads never collide on
 *  branch names or mutate the base repo's branch state. */
export async function addWorktree(
  exec: GitExec, baseCwd: string, worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await exec(["worktree", "add", "--detach", worktreePath, "HEAD"], baseCwd)
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || r.stdout.trim() }
}

/** Remove a worktree, but only if it's clean. A dirty worktree is left in place
 *  (dirty: true) rather than force-removed, so in-progress work is never
 *  silently discarded. */
export async function removeWorktree(
  exec: GitExec, worktreePath: string,
): Promise<{ ok: boolean; dirty?: boolean; error?: string }> {
  const status = await exec(["status", "--porcelain"], worktreePath)
  if (status.code !== 0) return { ok: false, error: status.stderr.trim() || "git status failed" }
  if (status.stdout.trim().length > 0) return { ok: false, dirty: true }
  const rm = await exec(["worktree", "remove", worktreePath], worktreePath)
  return rm.code === 0 ? { ok: true } : { ok: false, error: rm.stderr.trim() || rm.stdout.trim() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/threadGit.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/threadGit.ts hub/threadGit.test.ts
git commit -m "feat(threads): injectable git worktree add/remove with dirty guard"
```

---

### Task 5: `ThreadAgentRegistry` — spawn, suspend, resume, cap

**Files:**
- Create: `hub/threadAgents.ts`
- Test: `hub/threadAgents.test.ts`

**Interfaces:**
- Consumes: `ThreadState`, `ThreadStateStore` (Task 3); `GitExec`, `addWorktree`, `removeWorktree` (Task 4); `PooledReplica` (existing, `hub/agentPool.ts`); `AgentConfig` (existing, `hub/types.ts`).
- Produces (consumed by Task 6 and Task 7):

```ts
export interface ThreadAgentDeps {
  spawn: (threadId: string, agentName: string, cfg: AgentConfig) => Promise<PooledReplica>
  git: GitExec
  baseCwd: (agentName: string, threadWorktreeRepo?: string) => string   // repo to branch a thread's worktree from
  worktreeRoot: (agentName: string, threadWorktreeRepo?: string) => string // e.g. `${baseCwd}/.threads`
  idleTimeoutMinutes: number
  maxConcurrentInstancesPerChannel: number
  now?: () => number
}
export type EnsureInstanceResult =
  | { ok: true; replica: PooledReplica }
  | { ok: false; reason: "cap" }
  | { ok: false; reason: "worktree_error"; error: string }
export class ThreadAgentRegistry {
  constructor(store: ThreadStateStore, deps: ThreadAgentDeps)
  async ensureInstance(
    threadId: string, parentChannelId: string, agentName: string, agentCfg: AgentConfig, threadWorktreeRepo?: string,
  ): Promise<EnsureInstanceResult>
  async sweepIdle(): Promise<void>       // Task 6
  async hardCleanup(threadId: string): Promise<{ ok: true } | { ok: false; dirty: true }>   // Task 6
}
```

Note the `key` every spawn uses for a given thread is always `thread-<threadId>` regardless of how many times it's spawned/suspended/resumed — that stability is what makes `StreamJsonTransport`'s existing session-file resume mechanism work without the registry tracking a session id itself.

`baseCwd`/`worktreeRoot` take an optional `threadWorktreeRepo` (from the `ChannelAgent` pin, Task 1) so an agent whose `runtime.cwd` holds multiple repo checkouts (like `dev-agent`'s `/srv/dev-agent`) branches each thread's worktree from the *named* repo subdirectory instead of `runtime.cwd` itself; an agent with no `threadWorktreeRepo` set (single-repo `cwd`) is unaffected.

- [ ] **Step 1: Write the failing test**

```ts
// hub/threadAgents.test.ts
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
  if (!r.ok) { expect(r.reason).toBe("worktree_error"); expect(r.error).toContain("disk full") }
  expect(spawn).not.toHaveBeenCalled()
  expect(store.get("t1")).toBeUndefined() // no partial state left behind
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/threadAgents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// hub/threadAgents.ts
import { join } from "path"
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

    const worktreePath = join(this.deps.worktreeRoot(agentName, threadWorktreeRepo), threadId)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/threadAgents.test.ts`
Expected: PASS (all 8 tests).
Also run: `bunx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add hub/threadAgents.ts hub/threadAgents.test.ts
git commit -m "feat(threads): ThreadAgentRegistry spawn/reuse/cap"
```

---

### Task 6: Idle suspend, resume reuse, hard cleanup

**Files:**
- Modify: `hub/threadAgents.ts`
- Modify: `hub/threadAgents.test.ts`

**Interfaces:**
- Consumes: `removeWorktree` (Task 4).
- Produces (consumed by Task 7): `ThreadAgentRegistry.sweepIdle(): Promise<void>`, `ThreadAgentRegistry.hardCleanup(threadId: string): Promise<{ ok: true } | { ok: false; dirty: true }>`.

- [ ] **Step 1: Write the failing tests**

Append to `hub/threadAgents.test.ts`:

```ts
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

test("hardCleanup on an unknown thread is a no-op success", async () => {
  const { registry } = makeRegistry()
  const r = await registry.hardCleanup("nope")
  expect(r.ok).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/threadAgents.test.ts`
Expected: FAIL — `sweepIdle` and `hardCleanup` don't exist yet.

- [ ] **Step 3: Extend the implementation**

Change the import line in `hub/threadAgents.ts`:

```ts
import { addWorktree, removeWorktree } from "./threadGit"
```

Add methods to `ThreadAgentRegistry`:

```ts
  /** Kill (but don't delete) every thread instance idle past the configured
   *  timeout. State and worktree are retained so the next message resumes. */
  async sweepIdle(): Promise<void> {
    const cutoff = this.now() - this.deps.idleTimeoutMinutes * 60_000
    for (const [threadId, replica] of this.live) {
      if (replica.lastActivityMs() > cutoff) continue
      await replica.close()
      this.live.delete(threadId)
      const s = this.store.get(threadId)
      if (s) this.store.set(threadId, { ...s, live: false, lastActive: this.now() })
    }
  }

  /** Hard cleanup for a Discord-archived/deleted thread: kill the process if
   *  still live, remove the worktree, and drop stored state — unless the
   *  worktree is dirty, in which case nothing is deleted (state stays so a
   *  future manual recovery can find it). No-op success for an unknown thread. */
  async hardCleanup(threadId: string): Promise<{ ok: true } | { ok: false; dirty: true }> {
    const s = this.store.get(threadId)
    if (!s) return { ok: true }
    const replica = this.live.get(threadId)
    if (replica) { await replica.close(); this.live.delete(threadId) }
    const r = await removeWorktree(this.deps.git, s.worktreePath)
    if (!r.ok && r.dirty) return { ok: false, dirty: true }
    this.store.delete(threadId)
    return { ok: true }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/threadAgents.test.ts`
Expected: PASS (all 13 tests: 8 from Task 5 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add hub/threadAgents.ts hub/threadAgents.test.ts
git commit -m "feat(threads): idle suspend/resume + dirty-guarded hard cleanup"
```

---

### Task 7: Wire into Orchestrator, gateway thread events, and boot

**Files:**
- Modify: `hub/orchestrator.ts`
- Modify: `hub/orchestrator.test.ts`
- Modify: `hub/gateway.ts`
- Modify: `hub/index.ts`

**Interfaces:**
- Consumes: `resolveThreadAgent` (Task 2), `ThreadAgentRegistry` (Tasks 5-6), `makeTransport` (existing, `hub/index.ts`), `onAgentReply` (existing, `hub/index.ts`).
- Produces: end-to-end behavior — a message in a threaded channel's thread reaches its own instance; `threadUpdate`/`threadDelete` Discord events trigger `hardCleanup`; a periodic timer calls `sweepIdle`.

- [ ] **Step 1: Write the failing Orchestrator test**

First read `hub/orchestrator.test.ts`'s existing structure (it already builds a fake `OrchestratorDeps` fixture, e.g. `baseDeps`/`baseHub`/similar) and match its exact naming. Add two tests using those same fixtures, extended:

```ts
test("a thread message under a threaded+pinned channel dispatches via dispatchThread, not dispatch", async () => {
  const hub = { ...baseHub, channelAgents: [{ channelId: "chanA", agent: "dev-agent", threaded: true }], threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 } }
  const dispatchThread = mock(async () => ({ ok: true as const }))
  const dispatch = mock(() => true)
  const orch = new Orchestrator(hub, { "dev-agent": baseAgentCfg }, { ...baseDeps, dispatch, dispatchThread, isAvailable: () => true })
  await orch.handleMessage({ chatId: "thread123", threadParentId: "chanA", messageId: "m1", userId: "u1", user: "alice", content: "hi", ts: new Date().toISOString(), isDM: false })
  expect(dispatchThread).toHaveBeenCalledWith("dev-agent", "chanA", expect.objectContaining({ chatId: "thread123" }), undefined)
  expect(dispatch).not.toHaveBeenCalled()
})

test("a thread message under a non-threaded pinned channel falls through to normal dispatch (unchanged)", async () => {
  const hub = { ...baseHub, channelAgents: [{ channelId: "chanA", agent: "dev-agent" }], threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 } }
  const dispatchThread = mock(async () => ({ ok: true as const }))
  const dispatch = mock(() => true)
  const orch = new Orchestrator(hub, { "dev-agent": baseAgentCfg }, { ...baseDeps, dispatch, dispatchThread, isAvailable: () => true })
  await orch.handleMessage({ chatId: "thread123", threadParentId: "chanA", messageId: "m1", userId: "u1", user: "alice", content: "hi", ts: new Date().toISOString(), isDM: false })
  expect(dispatchThread).not.toHaveBeenCalled()
  expect(dispatch).toHaveBeenCalled()
})

test("dispatchThread reporting a cap rejection sends the 'too many active threads' notice", async () => {
  const hub = { ...baseHub, channelAgents: [{ channelId: "chanA", agent: "dev-agent", threaded: true }], threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 1 } }
  const dispatchThread = mock(async () => ({ ok: false as const, reason: "cap" as const }))
  const sendPlain = mock(async () => {})
  const orch = new Orchestrator(hub, { "dev-agent": baseAgentCfg }, { ...baseDeps, dispatchThread, sendPlain, isAvailable: () => true })
  await orch.handleMessage({ chatId: "thread123", threadParentId: "chanA", messageId: "m1", userId: "u1", user: "alice", content: "hi", ts: new Date().toISOString(), isDM: false })
  expect(sendPlain).toHaveBeenCalledWith("thread123", expect.stringContaining("Too many active"))
})

test("dispatchThread reporting a worktree_error sends the specific git error, not the cap message", async () => {
  const hub = { ...baseHub, channelAgents: [{ channelId: "chanA", agent: "dev-agent", threaded: true }], threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 } }
  const dispatchThread = mock(async () => ({ ok: false as const, reason: "worktree_error" as const, error: "fatal: disk full" }))
  const sendPlain = mock(async () => {})
  const orch = new Orchestrator(hub, { "dev-agent": baseAgentCfg }, { ...baseDeps, dispatchThread, sendPlain, isAvailable: () => true })
  await orch.handleMessage({ chatId: "thread123", threadParentId: "chanA", messageId: "m1", userId: "u1", user: "alice", content: "hi", ts: new Date().toISOString(), isDM: false })
  expect(sendPlain).toHaveBeenCalledWith("thread123", expect.stringContaining("fatal: disk full"))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/orchestrator.test.ts`
Expected: FAIL — `OrchestratorDeps` has no `dispatchThread`, and `handleMessage` never calls it.

- [ ] **Step 3: Add the `dispatchThread` dep and routing branch**

In `hub/orchestrator.ts`, change the import (line 7):

```ts
import { resolvePinnedAgent, resolveThreadAgent } from "./channelPin"
```

Extend `OrchestratorDeps` (after `dispatch`, line 19):

```ts
  dispatch: (agent: string, chatKey: string, inbound: InboundMessage) => boolean
  /** Route to a per-thread dedicated instance instead of the normal dispatcher.
   *  `ok: true` means delivered (instance existed or was freshly spawned);
   *  `ok: false` carries a reason the caller turns into a user-facing notice. */
  dispatchThread: (agent: string, parentChannelId: string, inbound: InboundMessage, threadWorktreeRepo: string | undefined) =>
    Promise<{ ok: true } | { ok: false; reason: "cap" } | { ok: false; reason: "worktree_error"; error: string }>
```

Insert a new block in `handleMessage`, right before the existing channel-pin block (i.e. immediately after the `control` handling at line 57, before line 60's `const pinned = resolvePinnedAgent(...)`):

```ts
    // Per-thread instance: a message inside a Discord thread whose parent is
    // pinned with `threaded: true` gets its own dedicated agent instance,
    // bypassing both the normal channel pin and the router entirely.
    const threadRoute = resolveThreadAgent(inbound.threadParentId, this.hub.channelAgents ?? [], this.hub.threadAgents)
    if (threadRoute && this.reg[threadRoute.agent] && permitted.includes(threadRoute.agent)) {
      const r = await this.deps.dispatchThread(threadRoute.agent, inbound.threadParentId!, inbound, threadRoute.threadWorktreeRepo)
      if (!r.ok) {
        const msg = r.reason === "cap"
          ? `Too many active ${threadRoute.agent} threads on this channel right now — close one first.`
          : `Couldn't start a ${threadRoute.agent} instance for this thread: ${r.error}`
        await this.deps.sendPlain(inbound.chatId, `${this.reg[threadRoute.agent].emoji} ${msg}`)
      }
      return
    }

    // Channel pin: a pinned channel goes straight to its agent, bypassing the router.
    const pinned = resolvePinnedAgent(inbound.chatId, this.hub.channelAgents ?? [])
```

Note this reuses the `permitted` array already computed above (line 52, `const permitted = permittedAgents(...)`) rather than re-resolving roles — no extra `resolveRoles` call needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/orchestrator.test.ts`
Expected: PASS (all pre-existing tests + the 4 new ones).

- [ ] **Step 5: Wire `dispatchThread` and the registry in `hub/index.ts`**

Add imports near the top of `hub/index.ts`:

```ts
import { ThreadAgentRegistry } from "./threadAgents"
import { ThreadStateStore } from "./threadState"
import { bunGitExec } from "./threadGit"
```

Near where `dispatcher`/`orchestrator` are constructed (find `new Orchestrator(` in `hub/index.ts`), construct the registry before it:

```ts
const threadStateStore = new ThreadStateStore(join(hub.stateDir, "thread-agents.json"))
const threadBaseCwd = (agentName: string, repo?: string) =>
  repo ? join(agents[agentName]!.runtime.cwd, repo) : agents[agentName]!.runtime.cwd
const threadRegistry = new ThreadAgentRegistry(threadStateStore, {
  git: bunGitExec,
  baseCwd: threadBaseCwd,
  worktreeRoot: (agentName, repo) => join(threadBaseCwd(agentName, repo), ".threads"),
  idleTimeoutMinutes: hub.threadAgents?.idleTimeoutMinutes ?? 60,
  maxConcurrentInstancesPerChannel: hub.threadAgents?.maxConcurrentInstancesPerChannel ?? 5,
  spawn: async (threadId, agentName, cfg) => {
    const key = `thread-${threadId}`
    const t = makeTransport(agentName, key, cfg)
    t.onReply((reply) => onAgentReply(reply, key))
    await t.start()
    return t
  },
})
setInterval(() => { void threadRegistry.sweepIdle() }, 60_000).unref()
```

Then add `dispatchThread` to the existing `new Orchestrator(hub, agents, { ... })` deps object:

```ts
    dispatchThread: async (agentName, parentChannelId, inbound, threadWorktreeRepo) => {
      const r = await threadRegistry.ensureInstance(inbound.chatId, parentChannelId, agentName, agents[agentName]!, threadWorktreeRepo)
      if (!r.ok) return r
      r.replica.deliver(inbound.chatId, inbound)
      return { ok: true }
    },
```

- [ ] **Step 6: Discord thread archive/delete → hard cleanup**

Read the top of `hub/gateway.ts` to find the exact exported class name (referred to here as `Gateway`) and its constructor's callback-injection pattern (matching how `onMessage` is already wired). In `hub/gateway.ts`, add a constructor-injected `onThreadArchived: (threadId: string) => void` callback alongside the existing ones, and register two new listeners in `start()` next to `messageCreate`:

```ts
    this.client.on("threadUpdate", (oldThread, newThread) => {
      if (!oldThread.archived && newThread.archived) this.onThreadArchived(newThread.id)
    })
    this.client.on("threadDelete", (thread) => { this.onThreadArchived(thread.id) })
```

In `hub/index.ts`, where the gateway is constructed, pass:

```ts
onThreadArchived: (threadId) => { void threadRegistry.hardCleanup(threadId).then((r) => {
  if (!r.ok) process.stderr.write(`thread-agents: cleanup for ${threadId} skipped — worktree is dirty\n`)
}) },
```

- [ ] **Step 7: Full-suite verification**

Run: `bun test`
Expected: every existing suite still green, plus the new ones from Tasks 1-7.
Run: `bunx tsc --noEmit`
Expected: no new errors versus the known-green baseline (1 pre-existing `config.test.ts` fail + 2 pre-existing tsc errors in `index.ts`, per project memory — confirm these are the *only* diffs from a clean `bun test`/`tsc` run on `master` before this branch).

- [ ] **Step 8: Commit**

```bash
git add hub/orchestrator.ts hub/orchestrator.test.ts hub/gateway.ts hub/index.ts hub/threadAgents.ts hub/threadState.ts
git commit -m "feat(threads): wire per-thread dispatch, archive/delete cleanup, idle sweep"
```

---

### Task 8: Manual end-to-end verification

**Files:** none (manual, against a real or staging Discord guild + agent config).

- [ ] **Step 1: Enable the feature in a test config**

In a non-production `hub.config.json` (or a copy), set:
```json
"threadAgents": { "enabled": true, "idleTimeoutMinutes": 1, "maxConcurrentInstancesPerChannel": 2 },
"channelAgents": [{ "channelId": "<test-channel-id>", "agent": "dev-agent", "threaded": true, "threadWorktreeRepo": "readyapp" }]
```
`dev-agent`'s real `runtime.cwd` (`/srv/dev-agent`) holds multiple repo checkouts, so `threadWorktreeRepo` is required for it — omitting it would make `git worktree add` fail against a non-repo directory (see Task 1's note on `ChannelAgent.threadWorktreeRepo`). Confirm in this step that each spawned thread's worktree lands under `/srv/dev-agent/readyapp/.threads/<threadId>`, not `/srv/dev-agent/.threads/<threadId>`.

- [ ] **Step 2: Verify isolated spawn**

Create two Discord threads under the test channel. Send a distinct message in each (e.g. ask each to report its working directory). Confirm each reports a different `.threads/<threadId>` path, and both replies arrive in their own thread only.

- [ ] **Step 3: Verify idle suspend + resume**

Wait past `idleTimeoutMinutes` (1 min in the test config) with no messages in one thread. Confirm (via hub logs or `!status`, whatever the existing observability surface is) the process is no longer live. Send a new message in that thread; confirm it replies with continuity (ask it to recall something from the first message) — proves the resume worked.

- [ ] **Step 4: Verify concurrency cap**

With `maxConcurrentInstancesPerChannel: 2` and 2 threads already live, create a 3rd thread and send a message. Confirm the rejection reply appears instead of a 3rd instance spawning.

- [ ] **Step 5: Verify archive cleanup**

Archive one of the test threads via Discord's UI. Confirm (via `ls <repo>/.threads/`) its worktree directory is gone and its entry is gone from `<stateDir>/thread-agents.json`.

- [ ] **Step 6: Verify dirty-worktree guard**

In a thread's instance, have the agent make an uncommitted file change and stop short of committing. Archive that thread. Confirm the worktree is *not* removed (still present in `.threads/`) and a warning is logged.
