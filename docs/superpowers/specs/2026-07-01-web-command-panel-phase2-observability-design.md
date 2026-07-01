# Switchboard — Web Command Panel Phase 2: Deep Observability

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**One-liner:** Turn `hub.trace.enabled` on (with real, time-based retention this time) and surface it in the web panel two ways — a "Doctor" button next to the existing Audit/Tools buttons, and a per-channel "Timeline" view that shows the full inbound → tool_use → tool_result → reply chain, live, reusing the channel's existing SSE connection rather than opening a second one.

This is Phase 2 of the 4-phase command-panel roadmap (Phase 1 — auth + approvals + channel chat + audit/tools — shipped live 2026-07-01). Phases 3 (agent config management) and 4 (live hub config editing) remain unscoped; F4's `!reload` already covers some of what Phase 4 wanted from the Discord side.

---

## 0. Why this, why now

`hub/turnTrace.ts` (part of the F1-F4 reliability merge, also shipped 2026-07-01) already captures exactly the data Phase 2 was scoped to need — full per-turn records with agent, chat, tool names, and tool-result error flags — via `!trace`/`!doctor` in Discord. It's off in production pending a retention decision. This phase makes that decision, turns it on, and gives the browser the same visibility Discord already has (`!doctor`), plus something Discord's compact text rendering can't easily do: a scrollable, live-updating timeline of a conversation's tool calls.

## 1. Trace retention

`TurnTrace.readTail(n)` (`hub/turnTrace.ts:32`) reads the entire `trace.jsonl` into memory on every query — there is no rotation today, size- or time-based. Left alone, the file grows unbounded and every read gets slower.

New pure module:

```ts
// hub/traceSweep.ts
import type { TraceRecord } from "./turnTrace"

/** Keep only records at or after `now - maxAgeMs`. Pure. */
export function sweepTrace(records: TraceRecord[], now: number, maxAgeMs: number): TraceRecord[] {
  const cutoff = now - maxAgeMs
  return records.filter((r) => Date.parse(r.ts) >= cutoff)
}
```

Wiring in `hub/index.ts` (near the existing `trace`/`traceFile` construction at line 581-584): a periodic sweep — read `traceFile`, `parseTraceTail(raw, Infinity)`-equivalent (read all, not just a tail, since sweeping needs every record), filter via `sweepTrace`, write to a temp file, rename over `traceFile` (atomic, matching the temp-then-rename pattern already used elsewhere in this codebase). Runs once at boot and then on an interval, mirroring the existing `gardener.intervalMs` cron shape.

Config additions to the existing `trace` block in `config/hub.config.json`:

```jsonc
"trace": {
  "enabled": true,
  "retentionDays": 14,
  "sweepIntervalMs": 21600000   // 6h
}
```

`retentionDays`/`sweepIntervalMs` are optional with these defaults — omitting them keeps today's `{enabled}`-only shape valid for anyone who copies the example config without reading this spec.

## 2. Doctor button

`hub/index.ts:1742-1758` (the `!doctor` Discord branch) already contains a self-contained fact-gathering block: state-dir writability probe, agent liveness from `pools`/`transports`, pending-approval count, audit/trace-enabled flags, router model. Extract it into a named function:

```ts
function gatherDoctorFacts(): DoctorFacts { /* exact existing logic, unchanged */ }
```

The Discord branch calls `gateway.sendPlain(m.chatId, renderDoctor(runDoctor(gatherDoctorFacts())))` exactly as today. `WebDeps.runCommand` (`hub/index.ts`) gains a third branch: `if (name === "doctor") return renderDoctor(runDoctor(gatherDoctorFacts()))` — no channel-posting, matching the existing `audit`/`tools` command behavior established in Phase 1 (result renders into the requester's own chat pane via the `chatLine` mechanism already built for that).

Web UI: one more `<button data-cmd="doctor">Doctor</button>` in the existing `cmdRow` (`hub/web.ts`) — no new client-side plumbing, the Phase 1 command-button/`chatLine` wiring already handles arbitrary command names generically.

## 3. Timeline drill-down

### 3.1 Data shape

`hub/channelStream.ts`'s `ChannelEvent` becomes a discriminated union:

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
  tools?: { id: string; name: string }[]        // present for tool_use
  results?: { id: string; isError: boolean }[]  // present for tool_result
}
export type ChannelEvent = ChatEvent | ToolEvent
```

`ChannelStream.publish`/`subscribe` signatures are unchanged (still `(channelId, evt)` / `(channelId, cb)`) — only the event shape gains a discriminant.

**Existing publish call sites** (top of `gateway.handleInbound`, inside `onAgentReply`'s reply-text block) each gain one field: `kind: "chat"` on their literal object — the only change, fully backward compatible with Phase 1's Chat-mode rendering, which will filter to `kind === "chat"` (see 3.3).

**New publish call sites**, at the exact two points `trace.record(...)` already fires for tool calls (`hub/index.ts:495-500`, inside `makeTransport`):

```ts
t.onToolUse((tools) => {
  const chat = lastChatByAgent.get(name) ?? ""
  trace.record({ agent: name, chat, kind: "tool_use", tools })
  if (chat) channelStream.publish(chat, { kind: "tool_use", ts: Date.now(), agent: name, tools })
  ...
})
t.onToolResult((results) => {
  const chat = lastChatByAgent.get(name) ?? ""
  trace.record({ agent: name, chat, kind: "tool_result", results })
  if (chat) channelStream.publish(chat, { kind: "tool_result", ts: Date.now(), agent: name, results })
  ...
})
```

(`lastChatByAgent` already exists and is already read by the `trace.record` calls at this exact site — no new state.)

### 3.2 History endpoint

New route, same pattern as the existing `GET /api/channel/:id/history`:

```
GET /api/channel/:id/timeline → TurnTrace.recent({ chat: id, limit: 50 })
```

Added to `WebDeps` as `fetchChannelTimeline: (channelId: string) => Promise<TraceRecord[]>` (async for consistency with `fetchChannelHistory`, even though the underlying `TurnTrace.recent` call is itself synchronous), wired in `hub/webServer.ts` alongside the existing history route. Distinct from Chat mode's history (which fetches from Discord) because tool calls only ever exist in the trace — Discord never sees them.

When `hub.trace.enabled` is false (not this branch's default, but a legitimate future state if someone turns it back off), `fetchChannelTimeline` returns `[]` — the Timeline view shows an explicit "trace is off" empty state rather than a silent blank pane.

### 3.3 Web UI

In `hub/web.ts`'s channel chat section: a two-way toggle in the pane header, "Chat" / "Timeline" (plain buttons, matching the existing vanilla-JS/no-framework style). Switching modes:

- **Opening Timeline**: fetch `api/channel/<id>/timeline`, render each `TraceRecord` as a line (reusing `renderTrace`'s formatting logic client-side is out of scope for a shared module across the Bun/browser boundary — the web JS gets its own small compact-line renderer mirroring the same visual shape: timestamp, agent, kind, and for `tool_use`/`tool_result` the tool names / error count, for `inbound`/`reply`/`card`/`update` a truncated text preview).
- **Live updates**: the *same* `EventSource` connection already open for the channel (`api/channel/<id>/stream`) feeds both modes. The message handler checks `evt.kind`: Chat mode ignores non-`"chat"` events; Timeline mode renders every event, chat-kind included (so a human/web message still shows inline, interleaved with the tool calls that followed it).
- Switching modes does not close/reopen the SSE connection — both views are subscribers to the same live feed, just filtering/rendering differently. Switching to Timeline re-fetches the trace-backed history (since Chat mode's Discord-backed history was already loaded and doesn't carry tool events).

## 4. Testing

- `hub/traceSweep.ts` / `hub/traceSweep.test.ts`: `sweepTrace` — records exactly at the cutoff, before it, after it; empty input; `maxAgeMs` larger than the data's span (no-op).
- `hub/index.ts` doctor extraction: no new tests needed beyond what already exists (`runDoctor`/`renderDoctor` are already tested in `hub/doctor.ts`'s own suite; the extraction is a behavior-preserving refactor, verified by the existing manual `!doctor` behavior plus the new `runCommand("doctor", ...)` path exercised via `hub/webServer.test.ts`'s existing command-route tests).
- `hub/channelStream.ts`: extend the existing pub/sub tests to cover publishing/receiving both `ChatEvent` and `ToolEvent` shapes through the same channel.
- `hub/webServer.ts`: new `GET /api/channel/:id/timeline` route test (happy path, trace-disabled empty-array path), following the existing `fetchChannelHistory` test's shape.
- Manual verification (post-merge, live hub): open Timeline for an active channel, trigger a turn that uses a tool, confirm the tool_use/tool_result pair appears live without a page reload or reconnect.

## 5. Non-goals (this phase)

- No cost/usage-over-time charting — out of scope, a plausible Phase 2b if wanted later.
- No cross-channel trace search (the existing `!trace` Discord command's `agent=`/`kind=`/`limit=` filters aren't exposed in the web UI — only per-channel timeline, matching the "drill down from the channel you're already looking at" scope decided above).
- Doctor stays a one-shot button (matches Audit/Tools) — no live-updating doctor status badge.

## 6. Build order

1. `hub/traceSweep.ts` + tests. Wire the periodic sweep into `hub/index.ts`. Flip `hub.trace.enabled: true` + add `retentionDays`/`sweepIntervalMs` to config.
2. Extract `gatherDoctorFacts()`; wire `runCommand("doctor", ...)`; add the Doctor button in `hub/web.ts`.
3. `ChannelEvent` → discriminated union in `hub/channelStream.ts` + tests. Update the two existing publish call sites (`kind: "chat"`). Add the two new publish call sites in `makeTransport`.
4. `GET /api/channel/:id/timeline` route + `WebDeps.fetchChannelTimeline` + test.
5. Web UI: Chat/Timeline toggle, timeline renderer, SSE handler kind-filtering.
6. Wire end-to-end, deploy, manual verification.
