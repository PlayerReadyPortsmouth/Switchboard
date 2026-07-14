# Codex Agent Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, long-lived Codex app-server transport for configured Switchboard agents while preserving Claude as the default and as the provider for all hub-internal model calls.

**Architecture:** A new `CodexAppServerTransport` implements the same operational surface as `StreamJsonTransport`, but speaks app-server JSON-RPC over stdio and persists one Codex thread id per agent or replica. `hub/index.ts` selects the transport from `runtime.provider`; both providers reuse the existing shim socket and all downstream dispatcher, queue, card, pooling, and observability code.

**Tech Stack:** Bun, TypeScript ESM, `@openai/codex` 0.144.4, Codex app-server JSONL/JSON-RPC, MCP STDIO, `bun:test`.

## Global Constraints

- Existing configurations with no `runtime.provider` continue to use Claude with unchanged behavior.
- Codex is selectable only for configured agent sessions; router, librarian, distiller, and overseer remain Claude-backed.
- Codex defaults to `danger-full-access` and approval policy `never`; `codexSandbox` may select `read-only`, `workspace-write`, or `danger-full-access`.
- Claude and Codex session identifiers use different files.
- Pin `@openai/codex` exactly to `0.144.4` so the protocol cannot drift on install.
- New production behavior must be introduced through a failing test first.
- Unit tests never require Discord, network access, or a real model call.
- Preserve unrelated untracked and modified user files.

---

### Task 1: Runtime provider configuration and reload behavior

**Files:**
- Modify: `hub/types.ts:128`
- Modify: `hub/config.ts:44`
- Modify: `hub/configReload.ts:19`
- Modify: `hub/agentConfigDraft.ts:30`
- Modify: `config/agents.example.json`
- Modify: `docs/config-reference.md`
- Test: `tests/config.test.ts`
- Test: `tests/configReload.test.ts`
- Test: `hub/agentConfigDraft.test.ts`

**Interfaces:**
- Produces: `AgentProvider`, `CodexSandbox`, and the new `AgentRuntime` fields `provider`, `codexSandbox`, and `codexArgs`.
- Produces: validated/defaulted runtime configuration where an omitted provider is equivalent to `claude`.
- Consumed by: transport selection and Codex argv/thread construction in later tasks.

- [ ] **Step 1: Write failing config and reload tests**

Add tests proving:

```ts
test("provider defaults to claude", () => {
  const { agents } = loadFixture({ runtime: { cwd: "." } })
  expect(agents.qa.runtime.provider).toBe("claude")
})

test("accepts a codex provider and sandbox", () => {
  const { agents } = loadFixture({
    runtime: { cwd: ".", provider: "codex", codexSandbox: "workspace-write" },
  })
  expect(agents.qa.runtime.provider).toBe("codex")
})

test("rejects an unknown provider", () => {
  expect(() => loadFixture({ runtime: { cwd: ".", provider: "other" } as any }))
    .toThrow(/provider/)
})

test("rejects an unknown codex sandbox", () => {
  expect(() => loadFixture({ runtime: { cwd: ".", provider: "codex", codexSandbox: "root" } as any }))
    .toThrow(/codexSandbox/)
})
```

Extend `agentSpawnSignature` tests so changing `provider`, `codexSandbox`, or
`codexArgs` changes the signature. Extend agent-config preview tests so these
fields are classified as hard-reload changes for non-pooled persistent agents.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
bun test tests/config.test.ts tests/configReload.test.ts hub/agentConfigDraft.test.ts
```

Expected: FAIL because provider defaults/validation and spawn signatures do not exist.

- [ ] **Step 3: Add the minimal runtime types and boundary parsing**

Add:

```ts
export type AgentProvider = "claude" | "codex"
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access"

export interface AgentRuntime {
  cwd: string
  provider?: AgentProvider
  model?: string
  allowedTools?: string[]
  claudeArgs?: string[]
  codexArgs?: string[]
  codexSandbox?: CodexSandbox
}
```

Retain every current field following `appendSystemPrompt` without renaming or
changing its type.

At the config boundary, reject invalid values and assign
`a.runtime.provider ??= "claude"`. Do not assign a stored Codex sandbox default;
the transport applies `danger-full-access` when it is absent so legacy serialized
config remains minimal.

Include the new fields in `agentSpawnSignature` and the web editor's unapplied
field accounting only where the existing classification requires it.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused test command. Expected: PASS.

- [ ] **Step 5: Update example and reference documentation**

Add one Codex agent example showing:

```json
"runtime": {
  "provider": "codex",
  "cwd": "~/work",
  "model": "gpt-5.6",
  "codexSandbox": "danger-full-access"
}
```

Document defaults, allowed values, provider-specific args, and hard-reload
classification.

- [ ] **Step 6: Commit**

```powershell
git add hub/types.ts hub/config.ts hub/configReload.ts hub/agentConfigDraft.ts tests/config.test.ts tests/configReload.test.ts hub/agentConfigDraft.test.ts config/agents.example.json docs/config-reference.md
git commit -m "feat(config): add codex agent provider settings"
```

---

### Task 2: Codex app-server framing and process configuration

**Files:**
- Create: `hub/transports/codexAppServerFraming.ts`
- Create: `hub/transports/codexAppServerFraming.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `buildCodexAppServerArgv(opts): string[]`.
- Produces: `rpcRequest(id, method, params): string` and `rpcNotification(method, params): string`.
- Produces: `parseCodexMessage(line): CodexMessage | null` and `codexUsage(value): TurnUsage | undefined`.
- Consumes: `INTERACTION_GUIDANCE` from `streamJsonFraming.ts` so both providers share the same Discord interaction rules.

- [ ] **Step 1: Pin the Codex package**

Run:

```powershell
bun add --exact @openai/codex@0.144.4
```

Expected: `package.json` contains `"@openai/codex": "0.144.4"` and the lockfile contains the matching Windows/Linux optional packages.

- [ ] **Step 2: Write failing framing tests**

Cover exact request/notification framing, invalid JSON, response/error messages,
agent-message deltas, completed agent messages, turn completion, MCP/command tool
items, token usage, and TOML-safe argv construction. The desired argv must include:

```ts
[
  "-c", 'mcp_servers.switchboard-shim.command="bun"',
  "-c", `mcp_servers.switchboard-shim.args=["run","/shim.ts"]`,
  "-c", 'mcp_servers.switchboard-shim.required=true',
  "-c", 'mcp_servers.switchboard-shim.env.HUB_SOCKET="/run/worker.sock"',
  "-c", 'mcp_servers.switchboard-shim.env.AGENT_NAME="worker"',
  "-c", `developer_instructions="${escapedGuidance}"`,
  "app-server", "--listen", "stdio://",
]
```

Feature gates are included only when enabled. `codexArgs` are inserted before
`app-server`. Windows paths, quotes, backslashes, and newlines must be encoded as
valid TOML string literals.

- [ ] **Step 3: Run framing tests and verify RED**

```powershell
bun test hub/transports/codexAppServerFraming.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement the pure framing module**

Define a narrow protocol union rather than importing generated app-server
schemas:

```ts
export type CodexMessage =
  | { kind: "response"; id: number; result?: unknown; error?: { code?: number; message: string } }
  | { kind: "request"; id: number; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
```

Use `JSON.stringify` for TOML basic strings and arrays because the required
string/boolean/array subset is compatible. Build each MCP environment entry as
a separate dotted `-c` override; never serialize a JSON object as a TOML inline
table.

Map Codex cumulative/current token fields defensively into `TurnUsage`:

```ts
return {
  inputTokens: number(inputTokens),
  cacheReadTokens: number(cachedInputTokens),
  cacheCreationTokens: 0,
  outputTokens: number(outputTokens),
}
```

- [ ] **Step 5: Run framing tests and verify GREEN**

```powershell
bun test hub/transports/codexAppServerFraming.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add package.json bun.lock hub/transports/codexAppServerFraming.ts hub/transports/codexAppServerFraming.test.ts
git commit -m "feat(codex): add app-server protocol framing"
```

---

### Task 3: Codex app-server transport lifecycle

**Files:**
- Create: `hub/transports/codexAppServer.ts`
- Create: `hub/transports/codexAppServer.test.ts`
- Reuse: `hub/turnGate.ts`
- Reuse: `hub/transports/streamJson.ts` process/socket interfaces and card normalization

**Interfaces:**
- Produces: `CodexAppServerTransport implements AgentTransport` plus the pooled-replica methods used by `ReplicaPool`.
- Constructor: `new CodexAppServerTransport(name, cfg, opts)`.
- `opts` contains injected `spawner`, `socket`, shim/socket/session paths, feature gates, session seams, overflow/error callbacks, and request timeout.
- Consumes: framing helpers from Task 2.

- [ ] **Step 1: Write failing lifecycle tests with fake process/socket seams**

The fake process records stdin lines and can emit stdout/exit. Tests must observe:

```ts
await transport.start()
expect(firstWrite()).toMatchObject({ method: "initialize", id: 1 })

emit({ id: 1, result: { userAgent: "codex" } })
expect(nextWrite()).toEqual({ method: "initialized", params: {} })
expect(nextRequest()).toMatchObject({ method: "thread/start" })

emit({ id: 2, result: { thread: { id: "thr-1" } } })
expect(savedThread).toBe("thr-1")
expect(transport.isAvailable()).toBe(true)
```

Add separate tests for resume, stale-resume fallback once, initialization error,
process exit, pending-request rejection, and idempotent close.

- [ ] **Step 2: Run lifecycle tests and verify RED**

```powershell
bun test hub/transports/codexAppServer.test.ts
```

Expected: FAIL because the transport does not exist.

- [ ] **Step 3: Implement request correlation and startup**

Maintain an incrementing request id and:

```ts
private request(method: string, params: unknown): Promise<unknown> {
  const id = this.nextId++
  return new Promise((resolve, reject) => {
    this.pending.set(id, { resolve, reject })
    this.proc?.writeStdin(rpcRequest(id, method, params))
  })
}
```

Add a bounded timeout for each pending request. Resolve/reject on parsed response,
and clear pending entries on response, timeout, close, or process exit. Startup
must not mark the transport available before thread start/resume succeeds.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**

```powershell
bun test hub/transports/codexAppServer.test.ts
```

Expected: lifecycle subset PASS.

- [ ] **Step 5: Add failing turn-flow tests**

Test queued `turn/start` requests, agent-message delta accumulation,
`item/completed` fallback text, terminal status mapping, exact inbound chat/message
IDs, overflow, card suppression, callback failure, usage state, tool callbacks,
interaction fields, malformed lines, unexpected server approval requests, and
process exit terminalizing active/queued turns once.

- [ ] **Step 6: Run turn-flow tests and verify RED**

Expected: failures show unimplemented delivery/event behavior rather than test
setup errors.

- [ ] **Step 7: Implement the minimal turn and shim behavior**

Use `TurnGate` with `send` calling:

```ts
void this.startTurn(inbound).catch(error => this.failActive(error))
```

Accumulate `item/agentMessage/delta` text, but prefer the authoritative completed
`agentMessage.text` when present. On terminal completion, await card/reply callback
settlement before emitting the outcome and draining the next turn, matching the
Claude transport's ordering.

Map command/MCP item starts to `{ id, name }` tool-use callbacks and terminal
statuses to `{ id, isError }` tool-result callbacks. Decline unexpected requests
with a JSON-RPC result using the decision appropriate to the method.

Expose `isBusy`, `queueDepth`, `lastUsageInfo`, `contextTokens`, `fillPct`,
`lastActivityMs`, `sendInteraction`, and `close` with the same semantics as
`StreamJsonTransport`.

- [ ] **Step 8: Run transport and framing tests and verify GREEN**

```powershell
bun test hub/transports/codexAppServer.test.ts hub/transports/codexAppServerFraming.test.ts
```

Expected: PASS with no unhandled rejection warnings.

- [ ] **Step 9: Commit**

```powershell
git add hub/transports/codexAppServer.ts hub/transports/codexAppServer.test.ts
git commit -m "feat(codex): add app-server agent transport"
```

---

### Task 4: Provider wiring and provider-specific sessions

**Files:**
- Modify: `hub/index.ts:17,189,483-640`
- Modify: `hub/configReload.ts`
- Create: `hub/transports/provider.ts`
- Create: `hub/transports/provider.test.ts`
- Modify: `tests/phase2CompositionSmoke.test.ts`

**Interfaces:**
- Produces: `agentProvider(runtime): "claude" | "codex"`.
- Produces: `sessionPathFor(stateDir, key, provider): string` returning the existing Claude path for Claude and a `.codex-thread` path for Codex.
- `makeTransport` returns `StreamJsonTransport | CodexAppServerTransport` and selects from the normalized provider.

- [ ] **Step 1: Write failing provider-selection tests**

```ts
expect(agentProvider({ cwd: "/w" })).toBe("claude")
expect(agentProvider({ cwd: "/w", provider: "codex" })).toBe("codex")
expect(sessionPathFor("/state", "dev", "claude")).toBe(join("/state", "dev.session"))
expect(sessionPathFor("/state", "dev", "codex")).toBe(join("/state", "dev.codex-thread"))
```

Add a composition assertion that no Codex transport is constructed for legacy
config, and that `provider: codex` selects only the new transport.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
bun test hub/transports/provider.test.ts tests/phase2CompositionSmoke.test.ts
```

Expected: FAIL because provider helpers and wiring do not exist.

- [ ] **Step 3: Implement provider helpers and index wiring**

Create the shared shim socket exactly once and leave all current socket callback
bodies unchanged. Extract the option values shared by both transports, then
branch only at final construction:

```ts
const provider = agentProvider(cfg.runtime)
const common = {
  socket,
  shimPath: SHIM_PATH,
  socketPath,
  resumable: cfg.runtime.resumable === true,
  consultEnabled: !!hub.consult?.enabled,
  attachEnabled: !!hub.outboundAttachments?.enabled,
  publishEnabled: shareLinksOn,
  peeringEnabled: peeringOn,
  receiptsEnabled: !!hub.receipts?.enabled,
  onOverflow,
  reportError,
}
const t = provider === "codex"
  ? new CodexAppServerTransport(name, cfg, {
      ...common,
      spawner: makeBunProcessSpawner("codex"),
      sessionPath: sessionPathFor(hub.stateDir, key, provider),
    })
  : new StreamJsonTransport(name, cfg, {
      ...common,
      spawner,
      mcpConfigPath: join(hub.stateDir, `${key}.mcp.json`),
      sessionPath: sessionPathFor(hub.stateDir, key, provider),
    })
```

Do not change any `makeRouterRunner()` call. Provider switching remains a hard
reload via the Task 1 spawn signature.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run provider, composition, config, reload, Claude stream-json, and agent-pool
tests. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add hub/index.ts hub/configReload.ts hub/transports/provider.ts hub/transports/provider.test.ts tests/phase2CompositionSmoke.test.ts
git commit -m "feat(codex): wire opt-in agent provider"
```

---

### Task 5: Real-CLI smoke harness and operational documentation

**Files:**
- Create: `scripts/smoke-codex-app-server.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/config-reference.md`

**Interfaces:**
- Produces: `bun run scripts/smoke-codex-app-server.ts`, a manually invoked authenticated smoke test.

- [ ] **Step 1: Implement the smoke harness**

The script must use the same framing helpers and process-spawn path as production,
perform initialize/initialized, start a temporary thread in the repository,
send a prompt requesting the exact text `SWITCHBOARD_CODEX_OK`, wait for
`turn/completed`, then start a second turn on the same thread and verify resume
continuity. It must enforce a timeout, kill app-server in `finally`, avoid printing
auth/config values, and exit non-zero on any protocol or model failure.

- [ ] **Step 2: Document installation, configuration, smoke test, and rollback**

README must explain that Codex is opt-in per agent, uses project-pinned CLI
0.144.4, reuses local Codex authentication, and leaves internal hub calls on
Claude. Include the canary configuration and `!reload hard` instruction.

CLAUDE.md must list the smoke command and identify the new transport files.

- [ ] **Step 3: Run static verification**

```powershell
bun run typecheck
bun test
```

Expected Windows baseline: all tests pass except the pre-existing
`expandHome resolves a leading ~` test documented in `CLAUDE.md`; no new failure.

- [ ] **Step 4: Run the real Codex smoke test**

```powershell
bun run scripts/smoke-codex-app-server.ts
```

Expected: prints one concise success line containing the created thread id and
confirmation that the resumed second turn completed. If authentication or
network access blocks it, capture the exact failure and do not describe the smoke
test as passed.

- [ ] **Step 5: Verify flag-off compatibility**

Run the existing Claude transport/config/composition tests and inspect the diff
to confirm a missing provider still selects Claude and retains the existing
`.session` path.

- [ ] **Step 6: Commit**

```powershell
git add scripts/smoke-codex-app-server.ts README.md CLAUDE.md docs/config-reference.md
git commit -m "docs(codex): add smoke and rollout guidance"
```

---

### Task 6: Final verification and review

**Files:**
- Review all files changed by Tasks 1-5.

**Interfaces:**
- Consumes: the complete Codex provider implementation.
- Produces: evidence that the implementation and legacy paths satisfy the approved design.

- [ ] **Step 1: Inspect repository state and diff**

```powershell
git status --short
git diff HEAD~5 --stat
git diff HEAD~5 --check
```

Confirm unrelated user files remain untouched and no generated secrets, session
files, or temporary MCP configuration were added.

- [ ] **Step 2: Run the complete verification suite again**

```powershell
bun run typecheck
bun test
```

Record exact pass/fail counts and distinguish the documented Windows baseline
failure from any regression.

- [ ] **Step 3: Run focused Codex and legacy transport tests**

```powershell
bun test hub/transports/codexAppServerFraming.test.ts hub/transports/codexAppServer.test.ts hub/transports/provider.test.ts tests/streamJson.test.ts tests/streamJsonFraming.test.ts tests/configReload.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the smoke harness once more when credentials permit**

```powershell
bun run scripts/smoke-codex-app-server.ts
```

Expected: PASS, or an explicitly reported external authentication/network
blocker with all offline verification still green.

- [ ] **Step 5: Review against the design spec**

Check every requirement in
`docs/superpowers/specs/2026-07-14-codex-agent-provider-design.md` against code or
tests. Fix any uncovered requirement through a new failing test before changing
production code.

- [ ] **Step 6: Prepare the completion report**

Report outcome first, list verification evidence, identify the exact canary
configuration, and state whether live Discord/shim verification remains for the
Linux deployment environment.
