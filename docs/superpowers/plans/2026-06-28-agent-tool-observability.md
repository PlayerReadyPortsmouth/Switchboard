# Agent Tool Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the tool-use/tool-result events already in the agent stream and surface them three ways — live tool in the status board, a per-agent breakdown embed, and a `!tools` command.

**Architecture:** `parseStreamEvent` (which already emits `assistant` frames with usage after the governor fix) is extended to also carry `tool_use` blocks and to parse `tool_result` blocks off `user` frames. The transport forwards these via new `onToolUse`/`onToolResult` callbacks to a pure `ToolUsageRegistry` (tallies + per-agent live current/last tool). The status board's row builder merges live tool state onto each row; a new `toolBoard` renders the tallies embed; a `!tools` command prints the full breakdown. All behind a feature flag.

**Tech Stack:** TypeScript, Bun (`bun:test`), discord.js v14.

## Global Constraints

- **Feature flag, default off:** `hub.toolObservability.enabled`. When off: `parseStreamEvent` still emits `tool_use`/`tool_result` (pure, harmless), but NOTHING is wired — no registry, no extra board, no `!tools`, no row changes. Behaviour byte-identical. (Per project feature-flag rule.)
- **Pure renderers + reducers** (mirror `statusBoard.ts` / `StatusRegistry`): unit-testable without Discord.
- **Live tool state lives in `ToolUsageRegistry`, not on the rebuilt rows.** `buildAgentRows()` rebuilds `AgentStatus[]` wholesale every refresh, so `currentTool`/`lastTool` are read from the registry at build time, never stored only on a row.
- Discord embed limits: ≤25 fields, ≤1024 chars/field → the tool board truncates per-agent tool lists.
- **Per task:** run `bun test <file>` for the task AND `bunx tsc --noEmit`. Known-green baseline: `bun test` has exactly **1 pre-existing failure** (`tests/config.test.ts:8`, expandHome `~`); `bunx tsc --noEmit` has exactly **2 pre-existing errors** (`hub/index.ts`, `writeFileSync` undefined). Do not add to either. New tests must pass. Windows cannot create symlinks (irrelevant here).

---

### Task 1: Parse tool_use / tool_result frames (`hub/transports/streamJsonFraming.ts`)

**Files:**
- Modify: `hub/transports/streamJsonFraming.ts` (the `StreamEvent` type + `parseStreamEvent`)
- Test: `hub/transports/streamJsonFraming.test.ts` (existing — add tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `StreamEvent` gains `tools?: { id: string; name: string }[]` on the `assistant` variant and a new `{ kind: "tool_result"; results: { id: string; isError: boolean }[] }` variant.

- [ ] **Step 1: Write the failing tests** (add to `hub/transports/streamJsonFraming.test.ts`)

```typescript
test("parseStreamEvent extracts tool_use blocks from an assistant frame", () => {
  const line = JSON.stringify({ type: "assistant", message: {
    content: [
      { type: "text", text: "running it" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "t2", name: "Read", input: { path: "x" } },
    ],
    usage: { input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 2 },
  } })
  expect(parseStreamEvent(line)).toEqual({
    kind: "assistant",
    usage: { inputTokens: 5, cacheReadTokens: 50, cacheCreationTokens: 0, outputTokens: 2 },
    tools: [{ id: "t1", name: "Bash" }, { id: "t2", name: "Read" }],
  })
})

test("parseStreamEvent: assistant frame with no tool_use → no tools field", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })
  expect(parseStreamEvent(line)).toEqual({ kind: "assistant" })
})

test("parseStreamEvent parses tool_result blocks off a user frame", () => {
  const line = JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
    { type: "tool_result", tool_use_id: "t2", content: "ok" },
  ] } })
  expect(parseStreamEvent(line)).toEqual({
    kind: "tool_result",
    results: [{ id: "t1", isError: true }, { id: "t2", isError: false }],
  })
})

test("parseStreamEvent: a user frame with no tool_result → null (noise)", () => {
  expect(parseStreamEvent(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }))).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test hub/transports/streamJsonFraming.test.ts`
Expected: FAIL — the assistant result lacks `tools`; the `user` frame returns `null` instead of a `tool_result` event.

- [ ] **Step 3: Implement**

In `hub/transports/streamJsonFraming.ts`, extend the `StreamEvent` union:

```typescript
export type StreamEvent =
  | { kind: "result"; text: string; usage?: TurnUsage }
  | { kind: "assistant"; usage?: TurnUsage; tools?: { id: string; name: string }[] }
  | { kind: "tool_result"; results: { id: string; isError: boolean }[] }
  | { kind: "init"; sessionId: string }
```

Replace the `assistant` branch and add a `user` branch in `parseStreamEvent` (the assistant branch currently reads usage only):

```typescript
  if (ev.type === "assistant") {
    const usage = parseUsageObj(ev.message?.usage)
    const content = Array.isArray(ev.message?.content) ? ev.message.content : []
    const tools = content
      .filter((b: any) => b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
      .map((b: any) => ({ id: b.id as string, name: b.name as string }))
    const out: Extract<StreamEvent, { kind: "assistant" }> = { kind: "assistant" }
    if (usage) out.usage = usage
    if (tools.length) out.tools = tools
    return out
  }
  if (ev.type === "user") {
    const content = Array.isArray(ev.message?.content) ? ev.message.content : []
    const results = content
      .filter((b: any) => b?.type === "tool_result" && typeof b.tool_use_id === "string")
      .map((b: any) => ({ id: b.tool_use_id as string, isError: !!b.is_error }))
    return results.length ? { kind: "tool_result", results } : null
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test hub/transports/streamJsonFraming.test.ts`
Expected: PASS (existing buildShimMcpConfig + assistant-usage tests still green, plus the 4 new ones).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors (still exactly the 2 pre-existing).

- [ ] **Step 6: Commit**

```bash
git add hub/transports/streamJsonFraming.ts hub/transports/streamJsonFraming.test.ts
git commit -m "feat(tool-obs): parse tool_use/tool_result from the agent stream"
```

---

### Task 2: Tool usage registry (`hub/toolUsageRegistry.ts`)

**Files:**
- Create: `hub/toolUsageRegistry.ts`
- Test: `hub/toolUsageRegistry.test.ts`

**Interfaces:**
- Consumes: the `{ id, name }` / `{ id, isError }` shapes from Task 1.
- Produces:
  - `interface ToolStat { count: number; errors: number }`
  - `interface AgentToolUsage { agent: string; tools: Record<string, ToolStat>; total: number }`
  - `interface LiveTool { current: string | null; last?: { name: string; error: boolean } }`
  - `class ToolUsageRegistry` with `recordToolUse(agent, tools)`, `recordToolResult(results)`, `endTurn(agent)`, `snapshot()`, `forAgent(agent)`, `liveFor(agent)`.

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/toolUsageRegistry.test.ts
import { test, expect } from "bun:test"
import { ToolUsageRegistry } from "./toolUsageRegistry"

test("counts tool uses per agent and exposes live current tool", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("ada", [{ id: "1", name: "Read" }, { id: "2", name: "Bash" }])
  expect(r.liveFor("ada").current).toBe("Bash")          // last in the batch
  const a = r.forAgent("ada")!
  expect(a.tools.Read.count).toBe(1)
  expect(a.tools.Bash.count).toBe(1)
  expect(a.total).toBe(2)
})

test("a tool_result error is attributed to the right tool and marks live.last", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("ada", [{ id: "1", name: "Bash" }])
  r.recordToolResult([{ id: "1", isError: true }])
  expect(r.forAgent("ada")!.tools.Bash.errors).toBe(1)
  expect(r.liveFor("ada").last).toEqual({ name: "Bash", error: true })
})

test("an unknown tool_result id is ignored", () => {
  const r = new ToolUsageRegistry()
  r.recordToolResult([{ id: "nope", isError: true }])
  expect(r.snapshot()).toEqual([])
})

test("endTurn clears the current tool but keeps last", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("ada", [{ id: "1", name: "Read" }])
  r.endTurn("ada")
  expect(r.liveFor("ada").current).toBeNull()
  expect(r.liveFor("ada").last).toEqual({ name: "Read", error: false })
})

test("snapshot sorts agents by total desc and is JSON-stable", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("a", [{ id: "1", name: "Read" }])
  r.recordToolUse("b", [{ id: "2", name: "Read" }, { id: "3", name: "Bash" }])
  expect(r.snapshot().map(s => s.agent)).toEqual(["b", "a"])
})

test("pending id map is bounded (does not leak when results never arrive)", () => {
  const r = new ToolUsageRegistry(100)   // cap 100 for the test
  for (let i = 0; i < 250; i++) r.recordToolUse("ada", [{ id: `k${i}`, name: "Read" }])
  // Only the most recent 100 ids are still attributable.
  r.recordToolResult([{ id: "k0", isError: true }])    // evicted → ignored
  r.recordToolResult([{ id: "k249", isError: true }])  // still present → counted
  expect(r.forAgent("ada")!.tools.Read.errors).toBe(1)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/toolUsageRegistry.test.ts`
Expected: FAIL — `Cannot find module './toolUsageRegistry'`.

- [ ] **Step 3: Implement**

```typescript
// hub/toolUsageRegistry.ts
export interface ToolStat { count: number; errors: number }
export interface AgentToolUsage { agent: string; tools: Record<string, ToolStat>; total: number }
export interface LiveTool { current: string | null; last?: { name: string; error: boolean } }

interface Live { current: string | null; last?: { name: string; error: boolean } }

/** Per-agent tool tallies + live current/last tool, fed from the agent stream's
 *  tool_use / tool_result events. Cumulative since hub restart. Pure state. */
export class ToolUsageRegistry {
  private agents = new Map<string, Map<string, ToolStat>>()
  private live = new Map<string, Live>()
  // id → {agent,name} so a later tool_result can be attributed; bounded (insertion-ordered Map, evict oldest).
  private pending = new Map<string, { agent: string; name: string }>()

  constructor(private pendingCap = 1000) {}

  private statFor(agent: string, name: string): ToolStat {
    let tools = this.agents.get(agent)
    if (!tools) { tools = new Map(); this.agents.set(agent, tools) }
    let s = tools.get(name)
    if (!s) { s = { count: 0, errors: 0 }; tools.set(name, s) }
    return s
  }
  private liveOf(agent: string): Live {
    let l = this.live.get(agent)
    if (!l) { l = { current: null }; this.live.set(agent, l) }
    return l
  }

  recordToolUse(agent: string, tools: { id: string; name: string }[]): void {
    for (const t of tools) {
      this.statFor(agent, t.name).count++
      if (this.pending.size >= this.pendingCap) {
        const oldest = this.pending.keys().next().value
        if (oldest !== undefined) this.pending.delete(oldest)
      }
      this.pending.set(t.id, { agent, name: t.name })
      const l = this.liveOf(agent)
      l.current = t.name
      l.last = { name: t.name, error: false }
    }
  }

  recordToolResult(results: { id: string; isError: boolean }[]): void {
    for (const r of results) {
      const p = this.pending.get(r.id)
      if (!p) continue
      this.pending.delete(r.id)
      if (r.isError) {
        this.statFor(p.agent, p.name).errors++
        const l = this.liveOf(p.agent)
        if (l.last && l.last.name === p.name) l.last.error = true
      }
    }
  }

  endTurn(agent: string): void { const l = this.live.get(agent); if (l) l.current = null }

  liveFor(agent: string): LiveTool { const l = this.live.get(agent); return l ? { current: l.current, last: l.last } : { current: null } }

  forAgent(agent: string): AgentToolUsage | undefined {
    const tools = this.agents.get(agent)
    if (!tools) return undefined
    const rec: Record<string, ToolStat> = {}
    let total = 0
    for (const [name, s] of tools) { rec[name] = { ...s }; total += s.count }
    return { agent, tools: rec, total }
  }

  snapshot(): AgentToolUsage[] {
    return [...this.agents.keys()]
      .map(a => this.forAgent(a)!)
      .sort((x, y) => y.total - x.total)
  }
}
```


- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/toolUsageRegistry.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add hub/toolUsageRegistry.ts hub/toolUsageRegistry.test.ts
git commit -m "feat(tool-obs): ToolUsageRegistry — tallies + live current/last tool"
```

---

### Task 3: Tool board renderer (`hub/toolBoard.ts`)

**Files:**
- Create: `hub/toolBoard.ts`
- Test: `hub/toolBoard.test.ts`

**Interfaces:**
- Consumes: `AgentToolUsage[]` from Task 2.
- Produces: `renderToolBoard(snapshot: AgentToolUsage[]): CardSpec`.

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/toolBoard.test.ts
import { test, expect } from "bun:test"
import { renderToolBoard, formatToolLine } from "./toolBoard"
import type { AgentToolUsage } from "./toolUsageRegistry"

test("formatToolLine sorts by count desc and marks errors", () => {
  const a: AgentToolUsage = { agent: "ada", total: 20, tools: {
    Read: { count: 12, errors: 0 }, Bash: { count: 7, errors: 1 }, attach_file: { count: 1, errors: 0 } } }
  expect(formatToolLine(a)).toBe("Read ×12 · Bash ×7 (1✗) · attach_file ×1")
})

test("renderToolBoard makes one field per agent + a title", () => {
  const snap: AgentToolUsage[] = [{ agent: "ada", total: 1, tools: { Read: { count: 1, errors: 0 } } }]
  const card = renderToolBoard(snap)
  expect(card.title).toContain("Tool")
  expect(card.fields!.length).toBe(1)
  expect(card.fields![0].name).toBe("ada")
  expect(card.fields![0].value).toBe("Read ×1")
})

test("renderToolBoard empty → a single placeholder field", () => {
  const card = renderToolBoard([])
  expect(card.fields!.length).toBe(1)
  expect(card.fields![0].value).toContain("no tool activity")
})

test("formatToolLine truncates past the Discord field limit with +N more", () => {
  const tools: Record<string, { count: number; errors: number }> = {}
  for (let i = 0; i < 80; i++) tools[`tool_number_${i}`] = { count: 1, errors: 0 }
  const line = formatToolLine({ agent: "ada", total: 80, tools })
  expect(line.length).toBeLessThanOrEqual(1024)
  expect(line).toContain("more")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/toolBoard.test.ts`
Expected: FAIL — `Cannot find module './toolBoard'`.

- [ ] **Step 3: Implement**

```typescript
// hub/toolBoard.ts
import type { CardSpec } from "./types"
import type { AgentToolUsage } from "./toolUsageRegistry"

/** `Read ×12 · Bash ×7 (1✗) · attach_file ×1`, tools by count desc, truncated to
 *  Discord's 1024-char field limit with a `+N more` suffix. */
export function formatToolLine(a: AgentToolUsage): string {
  const parts = Object.entries(a.tools)
    .sort((x, y) => y[1].count - x[1].count)
    .map(([name, s]) => `${name} ×${s.count}${s.errors ? ` (${s.errors}✗)` : ""}`)
  const LIMIT = 1024
  const out: string[] = []
  let len = 0
  for (let i = 0; i < parts.length; i++) {
    const sep = out.length ? " · " : ""
    const remaining = parts.length - i
    const tail = ` · +${remaining} more`
    // Stop if adding this part would leave no room for a possible "+N more".
    if (len + sep.length + parts[i].length + (remaining > 1 ? tail.length : 0) > LIMIT) {
      out.push(`+${remaining} more`)
      break
    }
    out.push(parts[i]); len += sep.length + parts[i].length
  }
  return out.join(" · ") || "_none_"
}

/** Render the per-agent tool tallies as one embed. Pure. */
export function renderToolBoard(snapshot: AgentToolUsage[]): CardSpec {
  const fields = snapshot.slice(0, 25).map(a => ({ name: a.agent, value: formatToolLine(a) }))
  if (!fields.length) fields.push({ name: "Tools", value: "_no tool activity yet_" })
  const card: CardSpec = { title: "🛠 Tool usage", body: "Cumulative since restart.", fields, buttons: [] }
  if (snapshot.length > 25) card.footer = `+${snapshot.length - 25} more agents`
  return card
}
```

(Confirm `CardSpec` allows `footer` and a `buttons: []`/empty — check `hub/types.ts`; `renderBoard` in `statusBoard.ts` builds the same shape. Match whatever `renderBoard` does for an empty card.)

- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/toolBoard.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors), then:

```bash
git add hub/toolBoard.ts hub/toolBoard.test.ts
git commit -m "feat(tool-obs): tool-usage board renderer"
```

---

### Task 4: Live tool in the status board line (`hub/statusRegistry.ts`, `hub/statusBoard.ts`)

**Files:**
- Modify: `hub/statusRegistry.ts` (`AgentStatus` interface)
- Modify: `hub/statusBoard.ts` (`agentLine`)
- Test: `hub/statusBoard.test.ts` (create if absent, else add)

**Interfaces:**
- Consumes: the `LiveTool` shape (Task 2) — but only as two optional fields on `AgentStatus`.
- Produces: `AgentStatus` gains `currentTool?: string | null` and `lastTool?: { name: string; error: boolean }`; `agentLine` renders them.

- [ ] **Step 1: Write the failing test** (create `hub/statusBoard.test.ts` if it doesn't exist)

```typescript
// hub/statusBoard.test.ts
import { test, expect } from "bun:test"
import { agentLine } from "./statusBoard"
import type { AgentStatus } from "./statusRegistry"

const base: AgentStatus = {
  name: "ada", emoji: "🤖", mode: "persistent", alive: true, busy: true,
  queueDepth: 0, fillPct: 0.4, lastActivityMs: 0,
}

test("agentLine shows the current tool when busy", () => {
  expect(agentLine({ ...base, currentTool: "Bash" })).toContain("⚙ Bash")
})

test("agentLine shows a failed last tool when idle", () => {
  expect(agentLine({ ...base, busy: false, currentTool: null, lastTool: { name: "Bash", error: true } }))
    .toContain("⚠ Bash failed")
})

test("agentLine is unchanged when there is no tool info", () => {
  expect(agentLine(base)).not.toContain("⚙")
  expect(agentLine(base)).not.toContain("⚠")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test hub/statusBoard.test.ts`
Expected: FAIL — `AgentStatus` has no `currentTool`/`lastTool` (type error) and `agentLine` doesn't render them.

- [ ] **Step 3: Implement**

In `hub/statusRegistry.ts`, add to the `AgentStatus` interface (after `lastActivityMs`):

```typescript
  currentTool?: string | null            // tool the agent is running right now (live)
  lastTool?: { name: string; error: boolean }  // last tool used this/previous turn
```

In `hub/statusBoard.ts` `agentLine`, before the final `return parts.join("  ")`, add:

```typescript
  if (a.busy && a.currentTool) parts.push(`⚙ ${a.currentTool}`)
  else if (!a.busy && a.lastTool?.error) parts.push(`⚠ ${a.lastTool.name} failed`)
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test hub/statusBoard.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors), then:

```bash
git add hub/statusRegistry.ts hub/statusBoard.ts hub/statusBoard.test.ts
git commit -m "feat(tool-obs): live current/last tool in the status board line"
```

---

### Task 5: Transport tool callbacks (`hub/transports/streamJson.ts`)

**Files:**
- Modify: `hub/transports/streamJson.ts` (callback fields/setters + emit in `onStdoutLine`)

**Interfaces:**
- Consumes: `StreamEvent` `tools` / `tool_result` (Task 1).
- Produces: `onToolUse(cb: (tools: { id: string; name: string }[]) => void)` and `onToolResult(cb: (results: { id: string; isError: boolean }[]) => void)` on `StreamJsonTransport`.

No new unit test (no transport harness exists; this is wiring of the Task-1 parse, verified by typecheck + the full suite). Mirrors how attachments' final wiring task was verified.

- [ ] **Step 1: Add the callback fields + setters**

Near the existing `private cb` (~line 85) add:

```typescript
  private toolUseCb: (tools: { id: string; name: string }[]) => void = () => {}
  private toolResultCb: (results: { id: string; isError: boolean }[]) => void = () => {}
```

Near `onReply` (~line 107) add:

```typescript
  onToolUse(cb: typeof this.toolUseCb): void { this.toolUseCb = cb }
  onToolResult(cb: typeof this.toolResultCb): void { this.toolResultCb = cb }
```

- [ ] **Step 2: Emit from `onStdoutLine`**

The current assistant branch is:

```typescript
        if (ev?.kind === "assistant") {
          if (ev.usage) this.lastAssistantUsage = ev.usage
          return
        }
```

Replace it with (adds the tool-use emit) and add a `tool_result` branch right after:

```typescript
        if (ev?.kind === "assistant") {
          if (ev.usage) this.lastAssistantUsage = ev.usage
          if (ev.tools?.length) this.toolUseCb(ev.tools)
          return
        }
        if (ev?.kind === "tool_result") {
          this.toolResultCb(ev.results)
          return
        }
```

- [ ] **Step 3: Typecheck + full suite**

Run: `bunx tsc --noEmit` → no new errors.
Run: `bun test` → no new failures vs baseline (the 1 pre-existing).

- [ ] **Step 4: Commit**

```bash
git add hub/transports/streamJson.ts
git commit -m "feat(tool-obs): transport onToolUse/onToolResult callbacks"
```

---

### Task 6: Config + flag (`hub/types.ts`)

**Files:**
- Modify: `hub/types.ts` (`HubConfig` + new interface)

**Interfaces:**
- Produces: `HubConfig.toolObservability?: ToolObservabilityConfig`.

- [ ] **Step 1: Add the type**

In `hub/types.ts`, add the field to `HubConfig` (next to `outboundAttachments?`):

```typescript
  toolObservability?: ToolObservabilityConfig  // capture + surface per-agent tool usage (default off)
```

And the interface (next to `OutboundAttachmentConfig`):

```typescript
/** Capture tool_use/tool_result from the agent stream and surface it: live tool
 *  in the status board, a per-agent tally embed, and the !tools command. Absent/
 *  disabled ⇒ no capture/board/command (byte-identical). */
export interface ToolObservabilityConfig {
  enabled?: boolean           // master switch (default off)
  channelId?: string          // where to post the tool board (default: statusChannelId)
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsc --noEmit` → no new errors. (No test — a type-only change consumed by Task 7.)

```bash
git add hub/types.ts
git commit -m "feat(tool-obs): toolObservability config type + flag"
```

---

### Task 7: Wire it into the hub (`hub/index.ts`)

**Files:**
- Modify: `hub/index.ts` — construct the registry, wire transport callbacks (flag-gated), merge live tool into `buildAgentRows`, add a tool-board flush loop, register `!tools`.

**Interfaces:**
- Consumes: `ToolUsageRegistry` (Task 2), `renderToolBoard` (Task 3), `AgentStatus.currentTool/lastTool` (Task 4), `onToolUse`/`onToolResult` (Task 5), `toolObservability` config (Task 6); plus existing `gateway`, `statusRegistry`, `buildAgentRows`, `flushBoard` patterns, the `!`-command chain, and `onAgentReply`.
- Produces: the live feature when `toolObservability.enabled`.

Integration of already-tested units — verified by typecheck, full suite, and a manual smoke test.

- [ ] **Step 1: Imports + registry**

Add imports near the other hub imports:

```typescript
import { ToolUsageRegistry } from "./toolUsageRegistry"
import { renderToolBoard } from "./toolBoard"
```

Near `const statusRegistry = new StatusRegistry()` (~line 885) add:

```typescript
const toolObs = hub.toolObservability?.enabled === true
const toolUsage = new ToolUsageRegistry()
```

- [ ] **Step 2: Wire transport callbacks in `makeTransport`**

Inside `makeTransport`, the transport is constructed and then `t.onReply((reply) => { void onAgentReply(reply, key) })` is wired (`hub/index.ts:404`) just before `return t`. Add the tool wiring right after that `t.onReply(...)` line:

```typescript
  if (toolObs) {
    t.onToolUse((tools) => toolUsage.recordToolUse(name, tools))
    t.onToolResult((results) => toolUsage.recordToolResult(results))
  }
```

IMPORTANT: use `name` (the agent name, `makeTransport(name, key, cfg)`), NOT `key` — `key` may be a pooled-replica key, but tallies aggregate per agent name. `onAgentReply` uses `key` for routing, but `reply.agent` (used in Step 3) is the agent name, so they stay consistent on the agent name.

- [ ] **Step 3: Clear current tool at turn end**

In `onAgentReply(reply, key)` (~line 633), at the top of the function add:

```typescript
  if (toolObs) toolUsage.endTurn(reply.agent)
```

- [ ] **Step 4: Merge live tool into the status rows**

In `buildAgentRows()` (~line 926), inside the `rows.push({ … })`, add the two fields sourced from the registry:

```typescript
    rows.push({
      name, emoji: cfg.emoji, mode: "persistent",
      alive: src?.isAvailable() ?? false,
      busy: src?.isBusy() ?? false,
      queueDepth: src?.queueDepth() ?? 0,
      fillPct: src?.fillPct(hub.contextWindows) ?? 0,
      costUsd: src?.lastUsageInfo()?.costUsd,
      replicas: pool?.replicaCount(),
      lastActivityMs: src?.lastActivityMs() ?? 0,
      ...(toolObs ? { currentTool: toolUsage.liveFor(name).current, lastTool: toolUsage.liveFor(name).last } : {}),
    })
```

- [ ] **Step 5: Tool-board flush loop**

After the status-board `setInterval` block (~line 960), add a sibling flush for the tool board, gated on `toolObs` and a channel:

```typescript
const toolBoardChannel = hub.toolObservability?.channelId ?? hub.statusChannelId
const toolBoardMsgPath = join(expandHome(hub.stateDir), "tool-board-msg.txt")
let toolBoardMsgId: string | undefined = (() => {
  try { const s = readFileSync(toolBoardMsgPath, "utf8").trim(); return s || undefined } catch { return undefined }
})()
async function flushToolBoard(): Promise<void> {
  if (!toolObs || !toolBoardChannel) return
  const card = renderToolBoard(toolUsage.snapshot())
  if (toolBoardMsgId == null) {
    toolBoardMsgId = await gateway.sendCard(toolBoardChannel, card)
    try { writeFileSync(toolBoardMsgPath, toolBoardMsgId ?? "") } catch {}
  } else {
    try { await gateway.editCard(toolBoardChannel, toolBoardMsgId, card) }
    catch {
      toolBoardMsgId = await gateway.sendCard(toolBoardChannel, card)
      try { writeFileSync(toolBoardMsgPath, toolBoardMsgId ?? "") } catch {}
    }
  }
}
if (toolObs && toolBoardChannel) {
  const refresh = hub.statusRefreshMs ?? 15_000
  setInterval(() => void flushToolBoard(), refresh).unref()
  setTimeout(() => void flushToolBoard(), 3_000).unref()
}
```

- [ ] **Step 6: `!tools` command**

In the `!`-command chain (the `if (/^!workflows\b/i…)` / `!run` / `!replay` block region, ~line 1163-1210), add a new block — gated on `toolObs`:

```typescript
  if (toolObs && /^!tools\b/i.test(trimmed)) {
    const who = trimmed.replace(/^!tools\b/i, "").trim()
    const fmt = (a: { agent: string; tools: Record<string, { count: number; errors: number }> }) =>
      `**${a.agent}** — ` + (Object.entries(a.tools)
        .sort((x, y) => y[1].count - x[1].count)
        .map(([n, s]) => `${n} ×${s.count}${s.errors ? ` (${s.errors}✗)` : ""}`).join(" · ") || "_none_")
    if (who) {
      const a = toolUsage.forAgent(who)
      void gateway.sendPlain(m.chatId, a ? fmt(a) : `_no tool activity for ${who}_`)
    } else {
      const snap = toolUsage.snapshot()
      void gateway.sendPlain(m.chatId, snap.length ? snap.map(fmt).join("\n") : "_no tool activity yet_")
    }
    return
  }
```

(Match the surrounding block's variable names — `trimmed` and `m.chatId` are used by the sibling `!replay`/`!run` blocks; confirm and reuse them.)

- [ ] **Step 7: Typecheck + full suite**

Run: `bunx tsc --noEmit` → exactly the 2 pre-existing errors, no new.
Run: `bun test` → no new failures (the 1 pre-existing).

- [ ] **Step 8: Manual smoke test**

Add to a dev hub config: `"toolObservability": { "enabled": true }`. Boot, drive an agent through a tool-using turn, and confirm:
1. The status board shows `⚙ <tool>` while busy and `⚠ <tool> failed` after a failed tool.
2. A second embed (the tool board) appears in the status channel with per-agent tallies that grow.
3. `!tools` prints all agents; `!tools <agent>` prints one.
4. With the flag absent/false: no tool board, no `!tools`, status line unchanged.

- [ ] **Step 9: Commit**

```bash
git add hub/index.ts
git commit -m "feat(tool-obs): wire capture + boards + !tools behind toolObservability flag"
```

---

## Self-Review

**Spec coverage:**
- Capture tool_use + tool_result → Task 1. ✓
- Per-agent tallies + outcomes + live current/last → Task 2. ✓
- Live tool in status board → Tasks 4 (render) + 7 (merge into rows). ✓
- Dedicated tally embed → Tasks 3 (render) + 7 (flush loop). ✓
- `!tools [agent]` → Task 7. ✓
- Flag default off, double-nothing when off → Task 6 (config) + `toolObs` gate everywhere in Task 7; Task 1 parsing is pure/harmless when unwired. ✓
- Pending-map hygiene (no leak) → Task 2 (bounded, tested). ✓
- Discord field truncation / ≤25 agents → Task 3. ✓
- Error handling (unknown id ignored, junk → null) → Tasks 1, 2. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code.

**Type consistency:** `{ id, name }` (tool_use) and `{ id, isError }` (tool_result) are identical across Tasks 1, 2, 5. `AgentToolUsage`/`ToolStat`/`LiveTool` from Task 2 are consumed unchanged in Tasks 3, 7. `currentTool?`/`lastTool?: { name, error }` match across Tasks 2 (LiveTool), 4 (AgentStatus), 7 (merge). `toolObservability.{enabled,channelId}` matches across Tasks 6, 7. `renderToolBoard`/`formatToolLine` names consistent (Tasks 3, 7).

**Build order:** Tasks 1–6 are independent leaf/unit pieces (1 parse, 2 registry, 3 board, 4 status line, 5 transport, 6 config); Task 7 integrates. Each ships an independently testable deliverable (except 5/6/7 which are wiring/config/integration verified by typecheck + suite + smoke, consistent with the attachments plan).
