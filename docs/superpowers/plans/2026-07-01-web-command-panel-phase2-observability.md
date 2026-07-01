# Web Command Panel Phase 2: Deep Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on full-fidelity turn tracing with real retention, add a "Doctor" button to the web panel, and add a live "Timeline" drill-down view to the channel chat pane showing the full inbound → tool_use → tool_result → reply chain.

**Architecture:** `hub/channelStream.ts`'s `ChannelEvent` becomes a discriminated union (chat messages + tool-call events) published from the exact points `trace.record(...)` already fires. `hub/webServer.ts` gains a new trace-backed history route. `hub/index.ts` wires a periodic trace-sweep job and a `gatherDoctorFacts()` extraction shared between the Discord `!doctor` command and the new web "Doctor" button. `hub/web.ts` gains a Chat/Timeline toggle that renders both historical (trace-backed) and live (SSE) data through one shared line-renderer.

**Tech Stack:** Bun + TypeScript (hub), `bun:test`, vanilla-JS dashboard (no build step).

## Global Constraints

- Hub tests use `bun:test`, run via `bun test` from the Switchboard repo root. No mocking library — small hand-rolled fakes.
- Dashboard JS uses plain `function(){}`/`var`/string concatenation — no arrow functions, no template literals, matching the existing script block's style exactly.
- New/changed pure logic lives in small, dependency-injected modules; `hub/index.ts` is wiring-only and is not unit-tested directly (it runs boot side effects at module scope).
- Avoid `Math.random()` for identifiers (house rule — not directly relevant to this plan's new code, but don't introduce any).
- `hub.trace.retentionDays` default 14, `hub.trace.sweepIntervalMs` default 6h (21600000), matching the `gardener.intervalMs` config-naming precedent.
- Commit after each task.

---

### Task 1: `hub/traceSweep.ts` — pure retention filter

**Files:**
- Create: `hub/traceSweep.ts`
- Test: `hub/traceSweep.test.ts`

**Interfaces:**
- Consumes: `TraceRecord` from `./turnTrace` (already exists — `{v, ts, agent, chat, kind, text?, tools?, results?, bytes}`, `ts` is an ISO string).
- Produces: `export function sweepTrace(records: TraceRecord[], now: number, maxAgeMs: number): TraceRecord[]`
- Consumed by: Task 4 (`hub/index.ts`'s periodic sweep job).

- [ ] **Step 1: Write the failing test**

```ts
// hub/traceSweep.test.ts
import { test, expect } from "bun:test"
import { sweepTrace } from "./traceSweep"
import type { TraceRecord } from "./turnTrace"

const rec = (ts: string): TraceRecord => ({ v: 1, ts, agent: "a", chat: "c", kind: "reply", bytes: 0 })

test("drops records older than maxAgeMs, keeps records at or after the cutoff", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z")
  const maxAgeMs = 14 * 24 * 60 * 60_000 // 14 days
  const cutoff = now - maxAgeMs
  const records = [
    rec(new Date(cutoff - 1000).toISOString()),   // 1s before cutoff — dropped
    rec(new Date(cutoff).toISOString()),           // exactly at cutoff — kept
    rec(new Date(cutoff + 1000).toISOString()),    // 1s after cutoff — kept
    rec(new Date(now).toISOString()),               // now — kept
  ]
  const kept = sweepTrace(records, now, maxAgeMs)
  expect(kept).toEqual([records[1], records[2], records[3]])
})

test("empty input returns empty output", () => {
  expect(sweepTrace([], Date.now(), 1000)).toEqual([])
})

test("maxAgeMs larger than the data's span keeps everything", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z")
  const records = [rec(new Date(now - 1000).toISOString()), rec(new Date(now).toISOString())]
  expect(sweepTrace(records, now, 365 * 24 * 60 * 60_000)).toEqual(records)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/traceSweep.test.ts`
Expected: FAIL — cannot find module `./traceSweep`

- [ ] **Step 3: Implement `traceSweep.ts`**

```ts
// hub/traceSweep.ts
import type { TraceRecord } from "./turnTrace"

/** Keep only records at or after `now - maxAgeMs`. Pure — the IO (read the whole
 *  trace file, filter, atomically rewrite) lives in hub/index.ts's periodic job. */
export function sweepTrace(records: TraceRecord[], now: number, maxAgeMs: number): TraceRecord[] {
  const cutoff = now - maxAgeMs
  return records.filter((r) => Date.parse(r.ts) >= cutoff)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/traceSweep.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add hub/traceSweep.ts hub/traceSweep.test.ts
git commit -m "feat(trace): add sweepTrace — pure time-based retention filter"
```

---

### Task 2: `hub/channelStream.ts` — `ChannelEvent` becomes a discriminated union

**Files:**
- Modify: `hub/channelStream.ts`
- Modify: `hub/channelStream.test.ts`

**Interfaces:**
- Produces:
  - `export interface ChatEvent { kind: "chat"; ts: number; author: string; content: string; origin: "discord" | "web" | "agent" }`
  - `export interface ToolEvent { kind: "tool_use" | "tool_result"; ts: number; agent: string; tools?: { id: string; name: string }[]; results?: { id: string; isError: boolean }[] }`
  - `export type ChannelEvent = ChatEvent | ToolEvent`
  - `ChannelStream.subscribe`/`.publish` signatures unchanged (still generic over the whole `ChannelEvent`).
- Consumed by: Task 3 (`hub/webServer.ts` imports `ChannelEvent` directly, replacing its own duplicate `ChannelMessageJson` type), Task 4 (`hub/index.ts`'s publish call sites).

- [ ] **Step 1: Write the failing test**

Rewrite `hub/channelStream.test.ts` in full (existing 3 tests updated to the `kind: "chat"` shape, plus 2 new tests for `ToolEvent`):

```ts
// hub/channelStream.test.ts
import { test, expect } from "bun:test"
import { ChannelStream } from "./channelStream"

test("publish fans out to subscribers of that channel only", () => {
  const cs = new ChannelStream()
  const seenA: string[] = []
  const seenB: string[] = []
  cs.subscribe("chan-a", (e) => { if (e.kind === "chat") seenA.push(e.content) })
  cs.subscribe("chan-b", (e) => { if (e.kind === "chat") seenB.push(e.content) })
  cs.publish("chan-a", { kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seenA).toEqual(["hi"])
  expect(seenB).toEqual([])
})

test("unsubscribe stops delivery", () => {
  const cs = new ChannelStream()
  const seen: string[] = []
  const unsub = cs.subscribe("chan-a", (e) => { if (e.kind === "chat") seen.push(e.content) })
  unsub()
  cs.publish("chan-a", { kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seen).toEqual([])
})

test("publish with no subscribers is a no-op", () => {
  const cs = new ChannelStream()
  expect(() => cs.publish("chan-z", { kind: "chat", ts: 1, author: "x", content: "hi", origin: "web" })).not.toThrow()
})

test("publishes and delivers a tool_use event through the same channel as chat events", () => {
  const cs = new ChannelStream()
  const seen: unknown[] = []
  cs.subscribe("chan-a", (e) => seen.push(e))
  cs.publish("chan-a", { kind: "tool_use", ts: 1, agent: "qa", tools: [{ id: "t1", name: "Read" }] })
  expect(seen).toEqual([{ kind: "tool_use", ts: 1, agent: "qa", tools: [{ id: "t1", name: "Read" }] }])
})

test("publishes and delivers a tool_result event with error flags", () => {
  const cs = new ChannelStream()
  const seen: unknown[] = []
  cs.subscribe("chan-a", (e) => seen.push(e))
  cs.publish("chan-a", { kind: "tool_result", ts: 1, agent: "qa", results: [{ id: "t1", isError: true }] })
  expect(seen).toEqual([{ kind: "tool_result", ts: 1, agent: "qa", results: [{ id: "t1", isError: true }] }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/channelStream.test.ts`
Expected: FAIL — `Object literal may only specify known properties` type errors surface as the events not matching the old `ChannelEvent` shape (bun:test doesn't typecheck at runtime, but the new `e.kind === "chat"` narrowing and the tool-event literals reference fields the old interface doesn't have — run `bunx tsc --noEmit` alongside to confirm the expected compile failure too: `Object literal may only specify known properties, and 'kind' does not exist in type 'ChannelEvent'`).

- [ ] **Step 3: Update `ChannelEvent` to the discriminated union**

Replace the top of `hub/channelStream.ts` (the `ChannelEvent` interface only — the `ChannelStream` class body is unchanged, since both its methods are already generic over the whole event type):

```ts
export interface ChatEvent {
  kind: "chat"
  ts: number
  author: string
  content: string
  origin: "discord" | "web" | "agent"
}

export interface ToolEvent {
  kind: "tool_use" | "tool_result"
  ts: number
  agent: string
  tools?: { id: string; name: string }[]        // present for kind === "tool_use"
  results?: { id: string; isError: boolean }[]  // present for kind === "tool_result"
}

export type ChannelEvent = ChatEvent | ToolEvent
```

The `ChannelStream` class below it (subscribe/publish/the private `subscribers` map) is untouched — do not modify it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/channelStream.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: new errors in `hub/webServer.ts` and `hub/index.ts` (their own `ChannelMessageJson`/publish-call-site literals haven't been updated yet — that's Tasks 3-4). No errors should originate from `hub/channelStream.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add hub/channelStream.ts hub/channelStream.test.ts
git commit -m "feat(web): ChannelEvent becomes a discriminated union (chat + tool-call events)"
```

---

### Task 3: `hub/webServer.ts` — timeline route + adopt the shared `ChannelEvent` type

**Files:**
- Modify: `hub/webServer.ts`
- Modify: `tests/webServer.test.ts`

**Interfaces:**
- Consumes: `ChannelEvent` from `./channelStream` (Task 2). `TraceRecord` from `./turnTrace` (already exists).
- Removes: the duplicate `ChannelMessageJson` interface (was structurally identical to the old `ChannelEvent` — now redundant and a source of drift risk, since `hub/index.ts` previously bridged the two types with an unchecked `as` cast).
- Produces:
  - `WebDeps.fetchChannelTimeline: (channelId: string) => Promise<TraceRecord[]>`
  - `WebDeps.fetchChannelHistory`/`subscribeChannel` now typed against `ChannelEvent` directly (no more `ChannelMessageJson`).
  - New route: `GET /api/channel/:id/timeline` (guarded, same auth pattern as every other `/api/channel/:id/*` route).
- Consumed by: Task 4 (`hub/index.ts` supplies the real `fetchChannelTimeline` and the now-unified `fetchChannelHistory`/`subscribeChannel` — the `as (e: ChannelEvent) => void` cast in the current `subscribeChannel` wiring is removed there too, since the types now match natively).

- [ ] **Step 1: Write the failing tests**

In `tests/webServer.test.ts`: update the `fakeDeps()` helper and existing history/stream tests to the new `kind: "chat"` shape, add `fetchChannelTimeline` to the fake, and add two new tests for the timeline route.

```ts
// In fakeDeps(), add a line: fetchChannelTimeline: async () => [],
// (alongside the existing fetchChannelHistory/subscribeChannel/etc. defaults)

// Update the existing history test's literal:
test("GET /api/channel/:id/history → 200 JSON list", async () => {
  const deps = fakeDeps({ fetchChannelHistory: async (id) => { expect(id).toBe("c1"); return [{ kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" }] } })
  const res = await handleWebRequest(get("/api/channel/c1/history", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" }])
})

// New tests:
test("GET /api/channel/:id/timeline → 200 JSON list of TraceRecords", async () => {
  const deps = fakeDeps({
    fetchChannelTimeline: async (id) => { expect(id).toBe("c1"); return [{ v: 1, ts: "2026-07-01T00:00:00.000Z", agent: "qa", chat: "c1", kind: "tool_use", tools: [{ id: "t1", name: "Read" }], bytes: 0 }] },
  })
  const res = await handleWebRequest(get("/api/channel/c1/timeline", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ v: 1, ts: "2026-07-01T00:00:00.000Z", agent: "qa", chat: "c1", kind: "tool_use", tools: [{ id: "t1", name: "Read" }], bytes: 0 }])
})

test("GET /api/channel/:id/timeline without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/channel/c1/timeline"), fakeDeps())
  expect(res.status).toBe(400)
})

test("DELETE /api/channel/:id/timeline with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/channel/c1/timeline", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})
```

(`del(...)` already exists in this file from an earlier fix round — a `new Request(..., { method: "DELETE" })` helper alongside `get`/`post`. If it doesn't exist, add it: `const del = (path: string, headers: Record<string, string> = {}) => new Request(\`http://hub${path}\`, { method: "DELETE", headers })`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/webServer.test.ts`
Expected: FAIL — `fetchChannelTimeline` doesn't exist on `WebDeps`, `/timeline` route doesn't exist (404 instead of 200/400/405).

- [ ] **Step 3: Implement**

In `hub/webServer.ts`:

1. Remove the `ChannelMessageJson` interface entirely.
2. Add `import type { ChannelEvent } from "./channelStream"` to the top imports (alongside the existing `DASHBOARD_HTML, renderDashboardJson, type WebInput` import from `./web`).
3. Add `import type { TraceRecord } from "./turnTrace"`.
4. In `WebDeps`, replace every `ChannelMessageJson` reference with `ChannelEvent`, and add the new field:

```ts
export interface WebDeps {
  collect: () => WebInput
  requireUser: (req: Request) => string | null
  resolveApproval: (id: string, decision: "grant" | "deny", actor: string) => Promise<"granted" | "denied" | "not_found">
  listChannels: () => ChannelInfo[]
  fetchChannelHistory: (channelId: string) => Promise<ChannelEvent[]>
  fetchChannelTimeline: (channelId: string) => Promise<TraceRecord[]>
  subscribeChannel: (channelId: string, cb: (evt: ChannelEvent) => void) => () => void
  sendChannelMessage: (channelId: string, email: string, text: string) => Promise<void>
  runCommand: (name: string, channelId: string) => Promise<string | null>
}
```

5. Update `sseResponse`'s generic parameter from `ChannelMessageJson` to `ChannelEvent`:

```ts
function sseResponse(subscribe: (cb: (evt: ChannelEvent) => void) => () => void): Response {
```

6. Add the new route regex alongside the existing ones:

```ts
const channelTimelineMatch = /^\/api\/channel\/([^/]+)\/timeline$/.exec(path)
```

7. Add it to `isGuardedRoute`:

```ts
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch
```

8. Add the handler, right after the existing `channelHistoryMatch` block:

```ts
    if (method === "GET" && channelTimelineMatch) {
      return json(await deps.fetchChannelTimeline(channelTimelineMatch[1]))
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/webServer.test.ts`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: errors remaining only in `hub/index.ts` (Task 4's job) — none in `hub/webServer.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add hub/webServer.ts tests/webServer.test.ts
git commit -m "feat(web): GET /api/channel/:id/timeline + adopt shared ChannelEvent type"
```

---

### Task 4: `hub/index.ts` + `config/hub.config.json` — wire it all up

**Files:**
- Modify: `hub/index.ts`
- Modify: `config/hub.config.json`
- Modify: `hub/types.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- No new exports (wiring layer, not unit-tested directly — verified via the full suite + typecheck + a manual smoke check, matching the precedent set by Phase 1's equivalent wiring task).

- [ ] **Step 1: Extend `TraceConfig` in `hub/types.ts`**

Find the existing `TraceConfig` interface (`hub/types.ts:512-517`) and add the two new optional fields:

```ts
/** Full-fidelity per-turn trace (message bodies included), separate from the
 *  metadata-only AuditLog. Default off; when on, writes JSONL to <stateDir>/trace.jsonl. */
export interface TraceConfig {
  enabled?: boolean              // default false
  file?: string                 // default <stateDir>/trace.jsonl
  retentionDays?: number         // periodic sweep drops records older than this (default 14)
  sweepIntervalMs?: number       // sweep cadence (default 6h)
}
```

- [ ] **Step 2: Flip the flag and add retention config in `config/hub.config.json`**

Find the existing `trace` block (`config/hub.config.json:149-151`) and replace it:

```jsonc
  "trace": {
    "enabled": true,
    "retentionDays": 14,
    "sweepIntervalMs": 21600000
  },
```

- [ ] **Step 3: Add the `TraceRecord` type import**

Find the existing turnTrace import (`hub/index.ts:52`) and extend it:

```ts
import { TurnTrace, parseTraceTail, renderTrace, type TraceFilter, type TraceRecord } from "./turnTrace"
```

Also add the new sweep import right after it:

```ts
import { sweepTrace } from "./traceSweep"
```

- [ ] **Step 4: Wire the periodic trace-sweep job**

Find the `trace`/`traceFile`/`lastChatByAgent` construction block (`hub/index.ts:577-588`). Immediately after it (after the `const lastChatByAgent = new Map<string, string>()` line), add:

```ts
// Periodic trace sweep: drop records older than retentionDays, keeping trace.jsonl
// bounded (readTail/full-read reads the whole file, so an unbounded file gets
// slower forever). Mirrors the gardener's enabled+intervalMs+setInterval shape.
if (hub.trace?.enabled) {
  const retentionMs = (hub.trace.retentionDays ?? 14) * 24 * 60 * 60_000
  const runTraceSweep = () => {
    try {
      // parseTraceTail's `n` is a slice(-n) count; Infinity clamps to slice(0) — the
      // whole file — since a sweep must inspect every record, not just a tail window.
      const all = parseTraceTail(readFileSync(traceFile, "utf8"), Infinity)
      const kept = sweepTrace(all, Date.now(), retentionMs)
      if (kept.length === all.length) return
      const tmp = `${traceFile}.tmp-${process.pid}`
      writeFileSync(tmp, kept.map((r) => JSON.stringify(r) + "\n").join(""))
      renameSync(tmp, traceFile)
    } catch (err) { process.stderr.write(`trace sweep failed: ${err}\n`) }
  }
  runTraceSweep()
  setInterval(runTraceSweep, hub.trace.sweepIntervalMs ?? 6 * 60 * 60_000).unref()
}
```

(`readFileSync`/`writeFileSync`/`renameSync` are already imported in this file — used by the existing audit-rotation and doctor state-dir-probe code. If `bunx tsc --noEmit` reports any of them as missing, add to the existing `from "fs"` import line rather than adding a new import statement.)

- [ ] **Step 5: Extract `gatherDoctorFacts()`**

Find the existing `!doctor` Discord command branch (`hub/index.ts:1742-1758` — search for `/^!doctor\b/i`). Add a new top-level function immediately before the `gateway.handleInbound((m) => {` line (i.e. at module scope, after `agents`/`pools`/`transports`/`approvalRegistry`/`hub` are all already declared earlier in the file):

```ts
/** Gather the facts `!doctor` and the web panel's Doctor button both render via
 *  runDoctor/renderDoctor — extracted so both call sites stay byte-identical. */
function gatherDoctorFacts(): DoctorFacts {
  let stateDirWritable = true
  try { const probe = join(hub.stateDir, `.doctor-${process.pid}`); writeFileSync(probe, ""); unlinkSync(probe) } catch { stateDirWritable = false }
  const doctorAgents = Object.entries(agents)
    .filter(([, cfg]) => cfg.mode === "persistent")
    .map(([name]) => ({ name, alive: (pools.get(name) ?? transports.get(name))?.isAvailable() ?? false, registered: true }))
  return {
    agents: doctorAgents,
    stateDirWritable,
    pendingApprovals: approvalRegistry.pendingCount(),
    auditEnabled: hub.audit?.enabled === true,
    traceEnabled: hub.trace?.enabled === true,
    routerModel: hub.routerModel,
  }
}
```

Then replace the body of the `!doctor` branch to call it instead of inlining the same logic:

```ts
  if (/^!doctor\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    void gateway.sendPlain(m.chatId, renderDoctor(runDoctor(gatherDoctorFacts())))
    return
  }
```

(This is behavior-preserving — `gatherDoctorFacts()` contains exactly the logic that was inline before.)

- [ ] **Step 6: Wire the "doctor" command into `webDeps.runCommand`**

Find `webDeps.runCommand`'s body (`hub/index.ts:1926-1937` — search for `runCommand: async`). Add a third branch:

```ts
  runCommand: async (name, channelId): Promise<string | null> => {
    if (name === "audit") {
      if (!hub.audit?.enabled) return "📜 audit logging is off (set `hub.audit.enabled`)."
      return buildAuditText("", audit, (ts) => new Date(ts).toISOString().slice(11, 19))
    }
    if (name === "tools" && toolObs) {
      return buildToolsText("", toolUsage)
    }
    if (name === "doctor") {
      return renderDoctor(runDoctor(gatherDoctorFacts()))
    }
    return null
  },
```

- [ ] **Step 7: Add `kind: "chat"` to the three existing chat-publish call sites**

Run `grep -n "channelStream.publish" hub/index.ts` to find all three call sites (top of `gateway.handleInbound`, inside `onAgentReply`, inside `webDeps.sendChannelMessage`). Each currently publishes an object literal like `{ ts: Date.now(), author: ..., content: ..., origin: ... }` — add `kind: "chat",` as the first property of each:

```ts
// Top of gateway.handleInbound:
channelStream.publish(m.chatId, { kind: "chat", ts: Date.now(), author: m.user, content: m.content, origin: "discord" })

// Inside onAgentReply's reply-text block:
channelStream.publish(reply.chatId, { kind: "chat", ts: Date.now(), author: reply.agent, content: reply.text, origin: "agent" })

// Inside webDeps.sendChannelMessage:
channelStream.publish(channelId, { kind: "chat", ts: Date.now(), author: email, content: text, origin: "web" })
```

- [ ] **Step 8: Publish tool-call events alongside the existing trace.record calls**

Find `makeTransport`'s `onToolUse`/`onToolResult` wiring (`hub/index.ts:470-508` area — search for `t.onToolUse`). Add a `channelStream.publish` call inside each, using the same `lastChatByAgent` lookup `trace.record` already uses:

```ts
  t.onToolUse((tools) => {
    const chat = lastChatByAgent.get(name) ?? ""
    trace.record({ agent: name, chat, kind: "tool_use", tools })
    if (chat) channelStream.publish(chat, { kind: "tool_use", ts: Date.now(), agent: name, tools })
    if (toolObs) toolUsage.recordToolUse(name, tools)
  })
  t.onToolResult((results) => {
    const chat = lastChatByAgent.get(name) ?? ""
    trace.record({ agent: name, chat, kind: "tool_result", results })
    if (chat) channelStream.publish(chat, { kind: "tool_result", ts: Date.now(), agent: name, results })
    if (escalationOn && escCfg?.auto) turnErrors.set(key, (turnErrors.get(key) ?? 0) + countErrors(results))
    if (toolObs) toolUsage.recordToolResult(results)
  })
```

(The `if (chat)` guard skips publishing when `lastChatByAgent` has no entry yet for this agent — `trace.record` itself tolerates an empty `chat: ""`, since trace queries are keyed by an exact match and an empty string just won't match any real channel filter, but `channelStream.publish("", ...)` would create a spurious `""`-keyed subscriber bucket that nothing ever subscribes to — skipping it is strictly better, not just equivalent.)

- [ ] **Step 9: Update `fetchChannelHistory`'s Discord-message mapping to include `kind: "chat"`**

Find the real `fetchChannelHistory` implementation inside `webDeps` (search for `fetchChannelHistory: async`). Its Discord-message-to-JSON mapping needs one field added:

```ts
      return [...msgs.values()].reverse().map((msg: any) => ({
        kind: "chat",
        ts: msg.createdTimestamp,
        author: msg.author.username,
        content: msg.content,
        origin: msg.author.bot ? "agent" : "discord",
      }))
```

- [ ] **Step 10: Remove the now-unnecessary cast in `subscribeChannel`, add `fetchChannelTimeline`**

Find `webDeps.subscribeChannel` (search for `subscribeChannel:`). It currently reads something like `subscribeChannel: (channelId, cb) => channelStream.subscribe(channelId, cb as (e: ChannelEvent) => void),` — remove the cast, since `WebDeps`'s `subscribeChannel` callback type and `ChannelStream.subscribe`'s callback type are now the same imported `ChannelEvent` (Task 2/3 made them the single source of truth, no bridging needed):

```ts
  subscribeChannel: (channelId, cb) => channelStream.subscribe(channelId, cb),
```

Add the new `fetchChannelTimeline` field to the same `webDeps` object (anywhere alongside `fetchChannelHistory`/`subscribeChannel`):

```ts
  fetchChannelTimeline: async (channelId): Promise<TraceRecord[]> => {
    return trace.recent({ chat: channelId, limit: 50 })
  },
```

- [ ] **Step 11: Run the full hub test suite**

Run: `bun test`
Expected: PASS — all tests from Tasks 1-3 plus every existing test, with exactly 1 pre-existing failure (`tests/config.test.ts:8` `expandHome` on Windows, unrelated).

- [ ] **Step 12: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 13: Manual smoke test**

If a real Discord token/config is available: `bun run hub`, confirm it boots without throwing, then `curl localhost:8080/api/channel/<a-real-channel-id>/timeline` and confirm it returns `[]` or real `TraceRecord[]` JSON (not an error). If no live token is available in this environment, skip the live-boot check and instead confirm the file compiles and every new/changed code path is covered by Step 11/12 — note in your report which verification level you achieved.

- [ ] **Step 14: Commit**

```bash
git add hub/index.ts hub/types.ts config/hub.config.json
git commit -m "feat(observability): trace retention sweep + Doctor extraction + tool-event publishing"
```

---

### Task 5: `hub/web.ts` — Doctor button + Chat/Timeline toggle

**Files:**
- Modify: `hub/web.ts`
- Modify: `hub/web.test.ts`

**Interfaces:**
- Consumes: `GET /api/channel/:id/timeline` (Task 3), the `doctor` command name (Task 4), the extended `ChannelEvent` shape flowing over the existing SSE connection (Task 2/4).
- No new exports — this is the dashboard's static HTML/JS template string.

- [ ] **Step 1: Write the failing tests**

Append to `hub/web.test.ts`:

```ts
test("the dashboard HTML has a Doctor command button and a Chat/Timeline mode toggle", () => {
  expect(DASHBOARD_HTML).toContain('data-cmd="doctor"')
  expect(DASHBOARD_HTML).toContain('data-mode="chat"')
  expect(DASHBOARD_HTML).toContain('data-mode="timeline"')
  expect(DASHBOARD_HTML).toContain("api/channel/'+")
  expect(DASHBOARD_HTML).toContain("/timeline")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/web.test.ts`
Expected: FAIL — none of these markers exist yet.

- [ ] **Step 3: Add the Doctor button**

Find every place `$('cmdRow').innerHTML = '...'` is set (search for `cmdRow'].innerHTML` — it currently appears once, inside `openChannel(id)`, setting `'<button data-cmd="audit">Audit</button> <button data-cmd="tools">Tools</button>'`). Add the Doctor button to that same string:

```js
  $('cmdRow').innerHTML = '<button data-cmd="audit">Audit</button> <button data-cmd="tools">Tools</button> <button data-cmd="doctor">Doctor</button>';
```

(The existing `[data-cmd]` click handler and `chatLine`-based rendering already generically handle any command name — no other change needed for Doctor to work.)

- [ ] **Step 4: Add the Chat/Timeline mode toggle markup**

Find the channel-chat `<section>` (search for `<h2>Channel chat</h2>`). Add a mode-toggle `<div>` right after the `channelPicker` `<select>` and before `<div id="cmdRow">`:

```html
  <div id="viewMode" style="margin:4px 0">
    <button data-mode="chat" class="mode-active">Chat</button>
    <button data-mode="timeline">Timeline</button>
  </div>
```

- [ ] **Step 5: Add the mode-toggle CSS**

In the `<style>` block, add a rule for the active-mode indicator (alongside the existing `.badge`/`.ok`/`.degraded` rules):

```css
  #viewMode button.mode-active { background:#1d2129; border-color:#4f8cff; }
```

- [ ] **Step 6: Add `currentMode` state and the unified `timelineLine` renderer**

Near the existing `var currentChannel = null, es = null;` declaration, extend it:

```js
var currentChannel = null, es = null, currentMode = 'chat';
```

Add a new function alongside `chatLine`. It renders either a live `ChannelEvent` (fields: `kind`, plus `author`/`content`/`origin` for chat, or `agent`/`tools`/`results` for tool events) or a historical `TraceRecord` (fields: `kind`, `agent`, `text`, `tools`, `results`) with one shared body, since Timeline mode must render both shapes through the same live SSE connection and the same historical fetch:

```js
function timelineLine(r){
  var div = document.createElement('div');
  var who = r.agent || r.author || '?';
  var head = fmtTime(r.ts)+' ['+who+'] '+r.kind;
  var tail = '';
  if (r.kind === 'tool_use' && r.tools) {
    tail = ' ' + r.tools.map(function(t){ return t.name; }).join(', ');
  } else if (r.kind === 'tool_result' && r.results) {
    var errs = 0;
    for (var i=0;i<r.results.length;i++) { if (r.results[i].isError) errs++; }
    tail = ' ' + r.results.length + ' result' + (r.results.length===1?'':'s') + (errs ? ' ('+errs+'✗)' : '');
  } else {
    var text = r.text !== undefined ? r.text : r.content;
    if (text) {
      var oneLine = String(text).replace(/\s+/g,' ');
      tail = ' ' + (oneLine.length > 160 ? oneLine.slice(0,157)+'…' : oneLine);
    }
  }
  div.textContent = head + tail;
  return div;
}
```

(`fmtTime` already accepts either an epoch-ms number or an ISO date string — both `ChannelEvent.ts` (number) and `TraceRecord.ts` (ISO string) work unchanged, since it just does `new Date(ts)` internally, and the JS `Date` constructor accepts either.)

- [ ] **Step 7: Wire the mode-toggle click handler**

Add a new click-delegate, alongside the existing `[data-cmd]`/`[data-appr]` ones:

```js
document.addEventListener('click', function(ev){
  var btn = ev.target.closest('[data-mode]');
  if (!btn || !currentChannel) return;
  var mode = btn.getAttribute('data-mode');
  if (mode === currentMode) return;
  currentMode = mode;
  var buttons = document.querySelectorAll('#viewMode [data-mode]');
  for (var i=0;i<buttons.length;i++) {
    buttons[i].className = buttons[i].getAttribute('data-mode') === mode ? 'mode-active' : '';
  }
  $('chat').innerHTML = '';
  if (mode === 'timeline') {
    fetch('api/channel/'+currentChannel+'/timeline').then(function(r){ return r.json(); }).then(function(rows){
      rows.forEach(function(r){ $('chat').appendChild(timelineLine(r)); });
      $('chat').scrollTop = $('chat').scrollHeight;
    });
  } else {
    fetch('api/channel/'+currentChannel+'/history').then(function(r){ return r.json(); }).then(function(rows){
      rows.forEach(function(e){ $('chat').appendChild(chatLine(e)); });
      $('chat').scrollTop = $('chat').scrollHeight;
    });
  }
});
```

- [ ] **Step 8: Make the live SSE handler and `openChannel` mode-aware**

Find `openChannel(id)`'s `es.onmessage` assignment (currently `es.onmessage = function(ev){ $('chat').appendChild(chatLine(JSON.parse(ev.data))); $('chat').scrollTop = $('chat').scrollHeight; };`). Replace it:

```js
  es.onmessage = function(ev){
    var e = JSON.parse(ev.data);
    if (currentMode === 'timeline') {
      $('chat').appendChild(timelineLine(e));
    } else if (e.kind === 'chat') {
      $('chat').appendChild(chatLine(e));
    } else {
      return;
    }
    $('chat').scrollTop = $('chat').scrollHeight;
  };
```

Also, `openChannel(id)` resets `currentMode` back to `'chat'` when switching channels (so opening a new channel doesn't silently stay in Timeline mode with no toggle-button feedback) — find the start of `openChannel(id)` and add this right after `currentChannel = id;`:

```js
  currentMode = 'chat';
  var modeButtons = document.querySelectorAll('#viewMode [data-mode]');
  for (var mi=0; mi<modeButtons.length; mi++) {
    modeButtons[mi].className = modeButtons[mi].getAttribute('data-mode') === 'chat' ? 'mode-active' : '';
  }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `bun test hub/web.test.ts`
Expected: PASS

- [ ] **Step 10: Run the full suite + typecheck**

Run: `bun test` — expect the 1 pre-existing failure only.
Run: `bunx tsc --noEmit` — expect 0 errors.

- [ ] **Step 11: Commit**

```bash
git add hub/web.ts hub/web.test.ts
git commit -m "feat(web): Doctor button + Chat/Timeline drill-down toggle"
```

---

### Task 6: End-to-end verification + deploy

**Files:** none (verification + deploy only)

- [ ] **Step 1: Full suite + typecheck on the merged branch**

```bash
bun test
bunx tsc --noEmit
```
Expected: all green (1 known pre-existing failure only).

- [ ] **Step 2: Deploy to the VPS**

```bash
ssh readyapp-newvps "cd /srv/switchboard && git pull --ff-only origin master && pm2 restart switchboard-hub"
```
Confirm clean boot: `ssh readyapp-newvps "tail -10 /home/ubuntu/.pm2/logs/switchboard-hub-error.log"` shows `gateway connected` / `web dashboard on 127.0.0.1:8080` with no crash, and `pm2 describe switchboard-hub` shows `status: online` with a fresh `uptime`.

- [ ] **Step 3: Manual verification against the live hub**

```bash
ssh readyapp-newvps "curl -s -H 'X-Switchboard-User: test@example.com' localhost:8080/api/channel/<a-real-channel-id>/timeline"
```
Confirm it returns JSON (an array, possibly empty if no tool calls have happened in that channel since trace was turned on — not an error).

In the browser (`https://readyapp.player-ready.co.uk/switchboard/`), as an allowlisted user: open a channel, click "Doctor" and confirm a pass/warn/fail report renders in the chat pane; click the "Timeline" toggle and confirm it switches to trace-backed rendering (empty or populated depending on recent activity); trigger a turn that uses a tool in that channel and confirm the tool_use/tool_result pair appears live in Timeline mode without a page reload.

- [ ] **Step 4: Note follow-ups for whoever picks this up next**

No cross-channel trace search in the web UI (only per-channel timeline — `!trace`'s `agent=`/`kind=`/`limit=` filters stay Discord-only). No cost/usage-over-time charting. Doctor stays a one-shot button, no live-updating badge. These were explicit non-goals in the design spec, not gaps.
