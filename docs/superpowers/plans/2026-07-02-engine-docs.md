# Switchboard Engine `/docs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/docs` directory in the `Switchboard` engine repo documenting its architecture, full config schema (including the `threadAgents`/`threaded`/`threadWorktreeRepo` fields from the per-thread-instances plan), sanitized example configs, the `!`-command reference, deployment, and the web dashboard.

**Architecture:** Each file is authored directly against the current source (`hub/types.ts` for config, the relevant module for behavior) — not generated, not inferred from memory — so it can't silently drift from what the code actually does. This is documentation-only work: no runtime code changes.

**Tech Stack:** Markdown.

## Global Constraints

- **Sequencing:** do not start until the per-thread-instances plan (`docs/superpowers/plans/2026-07-02-thread-agent-instances.md`) has merged — `configuration.md` needs to document the final config shape, not a moving target.
- Document the engine's **schema only**. Never copy real values from `ready-switchboard`'s deployed config (`config/agents.json`, `config/hub.config.json`) — this repo is public. Every example uses placeholder ids (`"123456789012345678"` style) and fictional agent names.
- Every field documented in `configuration.md` must be checked against the current `hub/types.ts` at authoring time — if a field there has changed or been removed, update the doc to match reality, not to match this plan's draft text.
- DRY, commit per task.

---

### Task 1: `docs/README.md` — index

**Files:**
- Create: `docs/README.md`

- [ ] **Step 1: Write the index**

```markdown
# Switchboard Documentation

Switchboard is a multi-agent Discord orchestration hub: it routes Discord
messages to Claude Code agent processes, manages their lifecycle, and exposes
operator tooling (Discord commands + a web dashboard) for observability and
control.

- [Architecture](architecture.md) — how a message flows from Discord to an
  agent process and back.
- [Configuration](configuration.md) — every `HubConfig`/`AgentConfig` field.
- [Examples](examples/) — complete, sanitized config pairs for common setups.
- [Discord commands](discord-commands.md) — the `!`-command reference.
- [Deployment](deployment.md) — env vars, state directory, running the hub.
- [Web dashboard](web-dashboard.md) — the operator web command panel.

This repo is the public engine. Real deployment config (channel/guild ids,
secrets, prompts) lives in a private companion repo — nothing here reflects
an actual production setup.
```

- [ ] **Step 2: Commit**

```bash
git add docs/README.md
git commit -m "docs: engine documentation index"
```

---

### Task 2: `docs/architecture.md`

**Files:**
- Create: `docs/architecture.md`

- [ ] **Step 1: Re-read the core flow before writing**

Read (don't rely on memory of an earlier pass) `hub/gateway.ts` (Discord ingress), `hub/orchestrator.ts` (routing decision), `hub/channelPin.ts` (pin/thread resolution), `hub/transports/index.ts` (`Dispatcher`), `hub/transports/streamJson.ts` (`StreamJsonTransport`), `hub/agentPool.ts` (`ReplicaPool`), `hub/threadAgents.ts` (per-thread instances, once Task 1 of the thread-agents plan has merged), `hub/bindings.ts` (`BindingStore`), and `hub/index.ts`'s top-level wiring (roughly the first 600 lines cover boot + message flow; the file is large — grep for `new Orchestrator(` and `new Dispatcher(` as anchors).

- [ ] **Step 2: Write the flow narrative**

Cover, in prose with short code-reference callouts (file:line, not full snippets):
1. Discord ingress: `Gateway.start()`'s `messageCreate` handler builds an `InboundMessage`.
2. `Orchestrator.handleMessage`: base gate (pairing/allowlist) → control commands → per-thread routing (`resolveThreadAgent`) → channel pin (`resolvePinnedAgent`) → router fallback (`decideAgent`) → dispatch.
3. Dispatch paths: `Dispatcher` (one transport per agent name, normal case), `ReplicaPool` (opt-in auto-scaling for a hot persistent agent), `ThreadAgentRegistry` (opt-in per-thread dedicated instances — worktree + dedicated process per Discord thread).
4. A transport (`StreamJsonTransport`): one long-lived `claude -p --input-format stream-json` process, stdin/stdout framing, session resume via a per-key session file.
5. Reply path: `onAgentReply` in `hub/index.ts` — governor/overseer/escalation interception, then `gateway.sendReply`.
6. Cross-cutting systems that hook into this flow: audit log, trace, approvals, memory (recall/remember), tool observability — one paragraph each, pointing at their config section in `configuration.md` rather than re-explaining the field list here.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: engine architecture overview"
```

---

### Task 3: `docs/configuration.md`

**Files:**
- Create: `docs/configuration.md`

- [ ] **Step 1: Re-read `hub/types.ts` in full immediately before writing**

Do not draft from memory of an earlier read of this file — re-open it fresh so the doc reflects its exact current state, field-for-field, including anything added by the per-thread-instances or write-access plans.

- [ ] **Step 2: Write one section per top-level config object**

Structure: `## HubConfig`, then one `###` subsection per nested `*Config` interface (`ThreadAgentsConfig`, `AttachmentConfig`, `ToolObservabilityConfig`, `MemoryBrowseConfig`, `OutboundAttachmentConfig`, `ShareLinksConfig`, `WorkflowConfig`, `ApprovalConfig`, `AuditConfig`, `EscalationConfig`, `ReloadConfig`, `TraceConfig`, `GardenerConfig`, `MemoryBackend`, `PeeringConfig`, `ConsultConfig`, `ReceiptsConfig`), then `## AgentConfig` with its own nested `OverseerPolicy`, `GovernorPolicy`, `PoolPolicy`, `AgentAccess`, `AgentRuntime` subsections. For each field: name, type, default (from the field's own comment in `types.ts` — every optional field already documents its default inline), one sentence on what it does. Use a table per section:

```markdown
### ThreadAgentsConfig

Per-thread dedicated agent instances. Absent/disabled ⇒ threads under a pinned channel fall through to the default agent, byte-identical to not having this feature.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `enabled` | `boolean` | — (required within the section) | Hub-wide kill switch for the whole feature. |
| `idleTimeoutMinutes` | `number` | `60` | How long a thread can go quiet before its process is suspended (not destroyed — state and worktree are kept for resume). |
| `maxConcurrentInstancesPerChannel` | `number` | `5` | Cap on simultaneously-live per-thread processes under one parent channel. |
```

Also document `ChannelAgent.threaded` and `ChannelAgent.threadWorktreeRepo` under the `channelAgents` entry, since they're per-pin fields, not a separate config object.

- [ ] **Step 3: Self-check for completeness**

Grep `hub/types.ts` for every `export interface` and every field within `HubConfig`/`AgentConfig`; confirm each has a corresponding row/section in the doc. Missing coverage here is the one failure mode worth specifically guarding against, since the whole point of this file is completeness.

- [ ] **Step 4: Commit**

```bash
git add docs/configuration.md
git commit -m "docs: full HubConfig/AgentConfig field reference"
```

---

### Task 4: `docs/examples/`

**Files:**
- Create: `docs/examples/single-persistent-agent.json` (+ matching `hub.config.json` fragment)
- Create: `docs/examples/ephemeral-agent.json`
- Create: `docs/examples/replica-pool.json`
- Create: `docs/examples/per-thread-dev-agent.json`
- Create: `docs/examples/README.md` (one-paragraph pointer per file)

- [ ] **Step 1: Single persistent agent**

A minimal `agents.json` + `hub.config.json channelAgents` pin pair for one always-on agent with no scaling/threading — the simplest possible working setup. Sanitized channel/guild ids (`"111111111111111111"` style).

- [ ] **Step 2: Ephemeral agent**

An agent with `mode: "ephemeral"`, showing the `access`/`allowedTools` shape typical of a one-shot task agent (no `resumable`, no `pool`).

- [ ] **Step 3: Replica pool**

A persistent agent with `runtime.pool` set (`min`, `max`, `scaleUpQueue`, etc.), demonstrating the auto-scaling shape.

- [ ] **Step 4: Per-thread dev-agent**

The `threadAgents` + `channelAgents[].threaded`/`threadWorktreeRepo` shape from the per-thread-instances plan, including the multi-repo-cwd case (`threadWorktreeRepo` set) with a comment explaining when it's needed vs. omittable.

- [ ] **Step 5: Write `docs/examples/README.md`** — one sentence per file pointing at which scenario it demonstrates.

- [ ] **Step 6: Verify every example is valid JSON and matches current field names**

```bash
for f in docs/examples/*.json; do echo "$f:"; bunx tsc --noEmit --allowJs -p /dev/null 2>/dev/null; jq . "$f" > /dev/null && echo "  valid JSON"; done
```
(The `jq` check is the meaningful one — confirms syntactic validity. Cross-check field names by eye against `configuration.md`'s tables from Task 3, since these are illustrative fragments, not full `HubConfig` objects that would typecheck against the real interface.)

- [ ] **Step 7: Commit**

```bash
git add docs/examples/
git commit -m "docs: sanitized example configs for common agent setups"
```

---

### Task 5: `docs/discord-commands.md`

**Files:**
- Create: `docs/discord-commands.md`

- [ ] **Step 1: Find every `!`-command handler**

```bash
grep -rn 'parseControlCommand\|"!reload"\|"!doctor"\|"!hard"\|"!memory"\|"!tools"\|"!audit"\|"!status"\|"!agents"\|"!run"' hub/*.ts
```
Read `hub/gateway.ts`'s `parseControlCommand` and `hub/index.ts`'s control-command switch to get the authoritative list — do not rely on the partial list in this plan's own header comments elsewhere, which may be stale.

- [ ] **Step 2: Write one entry per command**

For each: exact syntax, what config flag gates it (if any — several are inert unless their `*Config.enabled` is on), one-line example, and which permission/allowlist (if any) restricts it.

- [ ] **Step 3: Commit**

```bash
git add docs/discord-commands.md
git commit -m "docs: Discord bang-command reference"
```

---

### Task 6: `docs/deployment.md`

**Files:**
- Create: `docs/deployment.md`

- [ ] **Step 1: Gather env vars**

```bash
grep -rn 'process\.env\.' hub/*.ts | grep -oP 'process\.env\.\K[A-Z_]+' | sort -u
```
Cross-reference each against `hub/types.ts`'s `*Env` fields (`botTokenEnv`, `secretEnv`, etc. — these name *other* env vars indirectly, so trace them too) and any `.env.example`/README in the repo root if one exists.

- [ ] **Step 2: Write the doc**

Cover: required vs. optional env vars (one table), `stateDir` layout (what files/subdirs the hub creates there and what each holds — sessions, bindings, audit log, trace log, memory vault, thread state once Task 1's thread-agents plan lands), and the actual process invocation (how the hub binary/entrypoint is started — check `package.json`'s scripts or `hub/index.ts`'s shebang/bootstrap for the real command).

- [ ] **Step 3: Commit**

```bash
git add docs/deployment.md
git commit -m "docs: deployment guide — env vars and state directory layout"
```

---

### Task 7: `docs/web-dashboard.md`

**Files:**
- Create: `docs/web-dashboard.md`

- [ ] **Step 1: Re-read the web command panel modules**

`hub/web.ts`, `hub/webActions.ts`, `hub/hubConfigDraft.ts`, `hub/hubConfigPreview.ts`, `hub/agentConfigDraft.ts`, `hub/agentConfigPreview.ts`, and the phase design docs already in this repo (`docs/superpowers/specs/2026-07-01-web-command-panel-phase*-design.md`, `2026-06-29-*`) for the feature set as actually shipped.

- [ ] **Step 2: Write the doc**

Cover: what `webPort`/`webHost` expose, the approvals UI, live channel chat, the timeline/trace drill-down, the hub-config and agent-config JSON tree editors (preview→confirm→apply flow), and how a config change here interacts with `!reload` (which changes hot-swap vs. require a hard restart — per `configReload.ts`'s `classifyAgentChange`).

- [ ] **Step 3: Commit**

```bash
git add docs/web-dashboard.md
git commit -m "docs: web command panel reference"
```

---

### Task 8: Final cross-check

**Files:** none (review only).

- [ ] **Step 1: Link check**

Confirm every relative link in `docs/README.md` resolves to a file that exists.

- [ ] **Step 2: Completeness pass**

Re-diff `docs/configuration.md`'s field list against a fresh read of `hub/types.ts` one more time — config is the piece most likely to have drifted if other tasks in this plan took a while to complete.

- [ ] **Step 3: Commit if anything changed**

```bash
git add docs/
git commit -m "docs: fix cross-references and close completeness gaps"
```
