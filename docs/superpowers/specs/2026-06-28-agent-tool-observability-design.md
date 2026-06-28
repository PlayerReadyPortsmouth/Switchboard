# Agent Tool Observability — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending spec review → implementation plan

## Problem

Operators can see *that* a Switchboard agent is busy (the status board shows
`● busy`, context %, cost, queue depth) but not *what it is doing* — which tool
it is running right now — nor *what tools each agent leans on over time*, nor
whether tools are **failing**. A failing tool is often the single most useful
operational signal (an agent stuck in a retry loop, a broken integration), and
it is currently invisible.

The data already arrives and is thrown away: the transport parses `assistant`
stream-json frames (`parseStreamEvent`, `hub/transports/streamJsonFraming.ts`)
but returns a bare `{ kind: "assistant" }`, discarding the `tool_use` content
blocks. Tool *outcomes* (`is_error`) arrive in `tool_result` blocks on `user`
frames, which the parser ignores entirely.

## Goal

One capture of tool-use/tool-result events, surfaced three ways:

1. **Live** — the existing status board shows each agent's current/last tool
   (and flags a failure).
2. **Breakdown** — a new dedicated auto-refreshing embed with per-agent tool
   tallies (`Read ×12 · Bash ×7 (1✗) · attach_file ×1`).
3. **On demand** — a `!tools [agent]` command prints the full, untruncated
   breakdown.

Non-goals: capturing tool *inputs* (the actual Bash command, file paths) —
privacy/size/noise, deferred; persisting tool-use history to disk (tallies are
in-memory, cumulative since restart — the audit ledger can provide true history
in a later pass); cross-restart analytics.

## Global constraints

- **Feature flag, default off.** `hub.toolObservability.enabled`. When off:
  `parseStreamEvent` behaves exactly as today (returns `{ kind: "assistant" }`,
  ignores `user`/`tool_result` frames), no new registry, no new board, no `!tools`
  command — byte-identical behaviour. (Per the project feature-flag rule.)
- **Pure renderers + reducers.** Board rendering and registry state follow the
  existing `statusBoard.ts` (pure render) / `StatusRegistry` (pure reducers)
  pattern, so they are unit-testable without Discord.
- Discord embed limits: ≤25 fields, ≤1024 chars/field, ≤6000 total — the new
  board truncates per-agent tool lists; `!tools` (plain message, chunked) does not.

## Architecture

```
claude -p stdout (stream-json)
  → parseStreamEvent  [streamJsonFraming.ts]
      ├ assistant frame w/ tool_use blocks → { kind:"tool_use", tools:[{id,name}] }
      ├ user frame w/ tool_result blocks   → { kind:"tool_result", results:[{id,isError}] }
      └ result frame (unchanged)           → clears "current tool"
  → StreamJsonTransport  [streamJson.ts]
      ├ onToolUse(agent, tools)
      └ onToolResult(results)
  → hub/index.ts wiring (flag-gated)
      ├ ToolUsageRegistry   — tallies + id→{agent,name} pending map  [toolUsageRegistry.ts, new]
      └ StatusRegistry      — agent.currentTool / lastTool (live)    [statusRegistry.ts, extended]
  → surfaces
      ├ statusBoard.ts  — live tool in the agent line
      ├ toolBoard.ts    — tallies embed (new pure renderer)
      └ !tools [agent]  — direct command (full breakdown)
```

## Components

### 1. Frame parsing — `hub/transports/streamJsonFraming.ts` (modify)

Extend `StreamEvent` and `parseStreamEvent`:

- `assistant` frames: inspect `ev.message.content` for blocks of
  `type === "tool_use"`; collect `{ id, name }` for each. Emit
  `{ kind: "tool_use", tools: { id: string; name: string }[] }`. If the frame
  has no tool_use blocks, fall back to the existing `{ kind: "assistant" }`.
- `user` frames: inspect `ev.message.content` for blocks of
  `type === "tool_result"`; collect `{ id: tool_use_id, isError: !!is_error }`.
  Emit `{ kind: "tool_result", results: { id: string; isError: boolean }[] }`.
  (Note: the hub's own stdin frames are also `type: "user"`, but those are
  outbound and never re-parsed from stdout, so there is no collision.)
- `result` and `init` unchanged.

Parsing is defensive: any missing/oddly-shaped field → skip that block; a frame
with nothing useful → `null` (noise), exactly as today.

### 2. Tally registry — `hub/toolUsageRegistry.ts` (new, pure)

```
interface ToolStat { count: number; errors: number }
interface AgentToolUsage { agent: string; tools: Record<string, ToolStat>; total: number }

class ToolUsageRegistry {
  recordToolUse(agent: string, tools: { id: string; name: string }[]): void
  recordToolResult(results: { id: string; isError: boolean }[]): void
  snapshot(): AgentToolUsage[]            // sorted by total desc; tools sorted by count desc
  forAgent(agent: string): AgentToolUsage | undefined
}
```

- `recordToolUse` increments `tools[name].count` for the agent and stores
  `id → { agent, name }` in a pending map so an outcome can be attributed later.
- `recordToolResult` looks up each `id`; on `isError` increments
  `tools[name].errors`; deletes the id from the pending map either way.
- **Pending-map hygiene:** cap the pending map (e.g. 1000 entries, evict oldest)
  so a stream that somehow drops `tool_result`s cannot leak memory. A
  never-matched id just means an unattributed outcome — acceptable.
- Pure state + reducers; no I/O. Unit-tested.

### 3. Live state — `hub/statusRegistry.ts` + `hub/statusBoard.ts` (modify)

- `AgentStatus` gains `currentTool?: string | null` and
  `lastTool?: { name: string; error: boolean }`.
- `StatusRegistry`: a `setCurrentTool(agent, name | null)` reducer. Set to the
  last tool name on `tool_use`; on the turn's `result` (already observed for
  replies), set `currentTool = null` and roll the value into `lastTool`.
  `lastTool.error` is updated when a matching `tool_result` errors.
- `statusBoard.ts` `agentLine`: when busy and `currentTool` is set, append
  `· ⚙ ${currentTool}`; if `lastTool?.error` and idle, append `· ⚠ ${name} failed`.
  Keeps the one-line format.

### 4. Tallies embed — `hub/toolBoard.ts` (new, pure)

`renderToolBoard(snapshot: AgentToolUsage[]): CardSpec` — one embed field per
agent, value = tools sorted by count: `Read ×12 · Bash ×7 (1✗) · attach_file ×1`.
Per-field truncation to ≤1024 chars with a `+N more` suffix; cap agents to ≤25
fields. Pure → unit-tested. Empty snapshot → a single `_no tool activity yet_`
field.

### 5. Command — `!tools [agent]` (modify `hub/index.ts` direct-command handling)

- `!tools` → full breakdown for all agents (chunked plain message, untruncated).
- `!tools <agent>` → that agent's breakdown, or `_no activity for <agent>_`.
- Registered alongside the existing direct commands; only when the flag is on.

### 6. Wiring + config — `hub/index.ts`, `hub/types.ts`, `hub/config.ts` (modify)

- `HubConfig.toolObservability?: { enabled?: boolean; channelId?: string }`
  (`channelId` defaults to `statusChannelId`).
- When enabled: construct `ToolUsageRegistry`; wire `transport.onToolUse` →
  `toolUsage.recordToolUse` + `statusRegistry.setCurrentTool`; wire
  `transport.onToolResult` → `toolUsage.recordToolResult` (+ status lastTool
  error); post the tool board card to `channelId` and refresh it on the same
  `statusRefreshMs` interval the status board uses; register `!tools`.
- The new `onToolUse`/`onToolResult` callbacks are added to the transport
  alongside `onReply` (no-op defaults, so when unwired they cost nothing).

## Error handling

- Malformed / partial stream-json line → `parseStreamEvent` returns `null`
  (unchanged behaviour).
- `tool_result` with an unknown `id` → counted as nothing; silently ignored.
- Pending map full → evict oldest (bounded memory).
- Tool board field over 1024 chars → truncate with `+N more`; >25 agents → cap
  with a trailing `+N agents` note.
- Discord post/edit failure for the new board → caught and logged exactly like
  the existing status board (fire-and-forget), never throws into the transport.

## Testing

- **`parseStreamEvent`**: an `assistant` frame with one and with multiple
  `tool_use` blocks → correct `{id,name}[]`; an `assistant` frame with no tools →
  `{ kind:"assistant" }`; a `user` frame with `tool_result` (error and success) →
  correct `{id,isError}[]`; junk → `null`.
- **`ToolUsageRegistry`**: use → count increments; matching error result →
  errors increments and pending id removed; unmatched result → no-op; pending-map
  eviction cap; `snapshot` ordering (agents by total, tools by count).
- **`toolBoard`**: render counts + error marker; per-field truncation; >25 agents
  cap; empty snapshot.
- **`statusBoard` `agentLine`**: `· ⚙ <tool>` when busy with currentTool;
  `· ⚠ <tool> failed` when idle with a failed lastTool; unchanged when neither.
- **`!tools` command**: all-agents and single-agent output; unknown agent.
- Full suite + typecheck: no new failures/errors vs the known-green baseline
  (1 pre-existing test fail, 2 pre-existing tsc errors).

## Rollout

1. Land behind `toolObservability.enabled: false`.
2. Enable on the live hub (config + restart); confirm the new board posts to the
   status channel, live tool shows in the status board, `!tools` works, and a
   deliberately-failing tool shows `(1✗)`.
3. Same shim/MCP caveat as outbound attachments does **not** apply here — this
   feature reads the agent's stdout stream in the hub, it does not add an agent
   tool, so no `buildShimMcpConfig` change is needed.
