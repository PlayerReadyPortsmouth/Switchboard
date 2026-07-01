# Web Command Panel (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Switchboard's read-only web dashboard into a real control surface — approve/deny pending approvals, send/receive messages in a mirrored Discord channel, and run the `!audit`/`!tools` built-ins — all from the browser, gated by a widened, AppSetting-backed version of ReadyApp's existing Entra proxy.

**Architecture:** Every write goes through the exact in-process objects Discord already drives (`ApprovalRegistry.resolve`, `orchestrator.handleMessage`, the `!audit`/`!tools` renderers) — no parallel execution path. A new `channelStream` pub/sub fans out both Discord-originated and web-originated channel activity to open browser tabs via SSE. Auth is entirely upstream: ReadyApp's Fastify proxy is the only thing that can reach the hub's loopback-bound `webPort`, and it now forwards POST + a trusted identity header once an `AppSetting`-backed allowlist (`switchboardCommandPanel`) says a caller may.

**Tech Stack:** Switchboard hub — Bun + TypeScript, `bun:test`, vanilla-JS dashboard (no build step). ReadyApp — Fastify 5 + Prisma (api), React 18 + TanStack Query (web), Vitest.

## Global Constraints

- Hub tests use `bun:test` (`import { test, expect } from "bun:test"`), run via `bun test` from the Switchboard repo root. No mocking library — small hand-rolled fakes.
- ReadyApp tests use Vitest, run via `pnpm --filter @tutoring/api exec vitest run <path>` from the ReadyApp repo root.
- New/changed pure logic lives in small, dependency-injected modules (matching `hub/directCommands.ts`, `hub/approval.ts`) — `hub/index.ts` only wires real dependencies into them; it is not unit-tested directly (it runs boot side effects at module scope).
- Every new hub module avoids `Math.random()` for identifiers (existing house rule, see `hub/index.ts:893` comment "Math.random forbidden") — use injected `now`/counters instead.
- New ReadyApp feature flag follows the existing `AppSetting`-backed, per-user-allowlist pattern (`onboarding_flags` in `apps/api/src/routes/adminSettings.ts` is the reference).
- Dashboard JS keeps using **relative** fetch URLs (`'api/status'`, not `'/api/status'`) — required for the subpath mount under `/switchboard/` (see `hub/web.test.ts`).
- Commit after each task, per the codebase's existing granular-commit history.

---

## Part A — Switchboard hub (`C:\Users\Aura\Documents\Ready\Switchboard`)

### Task 1: `ApprovalRegistry.list()`

**Files:**
- Modify: `hub/approval.ts`
- Test: `tests/approval.test.ts`

**Interfaces:**
- Produces: `ApprovalRegistry.list(): PendingApproval[]` — every currently-pending entry (not resolved/expired), for the web dashboard's new approvals panel.

- [ ] **Step 1: Write the failing test**

Open `tests/approval.test.ts`, find the existing `harness()` helper (constructs an `ApprovalRegistry` with injected `now`/`genId`/`ttlMs`), and add:

```ts
test("list() returns every pending entry, none resolved/expired", () => {
  const { reg } = harness()
  const a = reg.request({ kind: "outbound", target: "route-a", actor: "hub", summary: "a" }, () => {})
  const b = reg.request({ kind: "outbound", target: "route-b", actor: "hub", summary: "b" }, () => {})
  reg.resolve(a.id, "grant")
  expect(reg.list()).toEqual([b])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/approval.test.ts`
Expected: FAIL — `reg.list is not a function`

- [ ] **Step 3: Implement `list()`**

In `hub/approval.ts`, inside `class ApprovalRegistry`, add (near `pendingCount()`):

```ts
  list(): PendingApproval[] {
    return [...this.pending.values()]
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/approval.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hub/approval.ts tests/approval.test.ts
git commit -m "feat(approval): add ApprovalRegistry.list() for the web panel"
```

---

### Task 2: `hub/channelStream.ts` — per-channel pub/sub

**Files:**
- Create: `hub/channelStream.ts`
- Test: `hub/channelStream.test.ts`

**Interfaces:**
- Produces:
  - `export interface ChannelEvent { ts: number; author: string; content: string; origin: "discord" | "web" | "agent" }`
  - `export class ChannelStream { subscribe(channelId: string, cb: (evt: ChannelEvent) => void): () => void; publish(channelId: string, evt: ChannelEvent): void }`
- Consumed by: Task 6 (`webServer.ts` SSE route), Task 7 (`index.ts` wiring at the Discord-inbound and agent-reply hook points).

- [ ] **Step 1: Write the failing test**

```ts
// hub/channelStream.test.ts
import { test, expect } from "bun:test"
import { ChannelStream } from "./channelStream"

test("publish fans out to subscribers of that channel only", () => {
  const cs = new ChannelStream()
  const seenA: string[] = []
  const seenB: string[] = []
  cs.subscribe("chan-a", (e) => seenA.push(e.content))
  cs.subscribe("chan-b", (e) => seenB.push(e.content))
  cs.publish("chan-a", { ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seenA).toEqual(["hi"])
  expect(seenB).toEqual([])
})

test("unsubscribe stops delivery", () => {
  const cs = new ChannelStream()
  const seen: string[] = []
  const unsub = cs.subscribe("chan-a", (e) => seen.push(e.content))
  unsub()
  cs.publish("chan-a", { ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seen).toEqual([])
})

test("publish with no subscribers is a no-op", () => {
  const cs = new ChannelStream()
  expect(() => cs.publish("chan-z", { ts: 1, author: "x", content: "hi", origin: "web" })).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/channelStream.test.ts`
Expected: FAIL — cannot find module `./channelStream`

- [ ] **Step 3: Implement `ChannelStream`**

```ts
// hub/channelStream.ts
export interface ChannelEvent {
  ts: number
  author: string
  content: string
  origin: "discord" | "web" | "agent"
}

/** In-memory per-channel pub/sub feeding the web dashboard's live chat pane.
 *  A hub restart drops subscribers — browser tabs reconnect and re-fetch
 *  history, same recovery story as the SSE-backed metrics/status views. */
export class ChannelStream {
  private subscribers = new Map<string, Set<(evt: ChannelEvent) => void>>()

  subscribe(channelId: string, cb: (evt: ChannelEvent) => void): () => void {
    let set = this.subscribers.get(channelId)
    if (!set) { set = new Set(); this.subscribers.set(channelId, set) }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.subscribers.delete(channelId)
    }
  }

  publish(channelId: string, evt: ChannelEvent): void {
    const set = this.subscribers.get(channelId)
    if (!set) return
    for (const cb of set) cb(evt)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/channelStream.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add hub/channelStream.ts hub/channelStream.test.ts
git commit -m "feat(web): add ChannelStream pub/sub for live channel mirroring"
```

---

### Task 3: `hub/commandActions.ts` — shared `!audit`/`!tools` renderers

**Files:**
- Create: `hub/commandActions.ts`
- Test: `hub/commandActions.test.ts`

**Interfaces:**
- Consumes: `parseAuditCommand`, `renderAuditLines`, `renderAuditSummary` from `./auditCommand`; `AuditEvent`, `AuditFilter`, `AuditSummary` from `./types`; `AgentToolUsage` from `./toolUsageRegistry`.
- Produces:
  - `export interface AuditSource { recent(filter?: AuditFilter): AuditEvent[]; summary(filter?: AuditFilter): AuditSummary }`
  - `export function buildAuditText(query: string, audit: AuditSource, fmtTime: (ts: number) => string): string`
  - `export interface ToolUsageSource { forAgent(agent: string): AgentToolUsage | undefined; snapshot(): AgentToolUsage[] }`
  - `export function buildToolsText(who: string, toolUsage: ToolUsageSource): string`
- Consumed by: Task 6 (`POST /api/command/:name`), Task 7 (refactor of the `!audit`/`!tools` branches in `index.ts` to call these instead of inlining the logic).

- [ ] **Step 1: Write the failing test**

```ts
// hub/commandActions.test.ts
import { test, expect } from "bun:test"
import { buildAuditText, buildToolsText, type AuditSource, type ToolUsageSource } from "./commandActions"

const fmtTime = (ts: number) => new Date(ts).toISOString().slice(11, 19)

test("buildAuditText: bare query renders recent lines", () => {
  const audit: AuditSource = {
    recent: (f) => { expect(f).toEqual({ limit: 25 }); return [{ ts: 0, kind: "route", actor: "a", action: "b", outcome: "ok" } as any] },
    summary: () => { throw new Error("should not be called") },
  }
  expect(buildAuditText("", audit, fmtTime)).toContain("route a b")
})

test("buildAuditText: 'cost' query renders the summary", () => {
  const audit: AuditSource = {
    recent: () => { throw new Error("should not be called") },
    summary: (f) => { expect(f).toEqual({}); return { total: 3, byKind: {}, byOutcome: {}, costUsd: 0.01, actors: 2 } },
  }
  expect(buildAuditText("cost", audit, fmtTime)).toContain("total: 3")
})

test("buildToolsText: no arg → snapshot across agents", () => {
  const toolUsage: ToolUsageSource = {
    forAgent: () => undefined,
    snapshot: () => [{ agent: "qa", tools: { Read: { count: 3, errors: 1 } }, total: 3 }],
  }
  expect(buildToolsText("", toolUsage)).toBe("**qa** — Read ×3 (1✗)")
})

test("buildToolsText: agent arg with no activity", () => {
  const toolUsage: ToolUsageSource = { forAgent: () => undefined, snapshot: () => [] }
  expect(buildToolsText("qa", toolUsage)).toBe("_no tool activity for qa_")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/commandActions.test.ts`
Expected: FAIL — cannot find module `./commandActions`

- [ ] **Step 3: Implement `commandActions.ts`**

```ts
// hub/commandActions.ts
import { parseAuditCommand, renderAuditLines, renderAuditSummary } from "./auditCommand"
import type { AuditEvent, AuditFilter, AuditSummary } from "./types"
import type { AgentToolUsage } from "./toolUsageRegistry"

export interface AuditSource {
  recent(filter?: AuditFilter): AuditEvent[]
  summary(filter?: AuditFilter): AuditSummary
}

/** Same grammar/output as the `!audit` Discord command — shared so the web
 *  "Audit" button and Discord render identically. Pure given an injected
 *  audit source + time formatter. */
export function buildAuditText(query: string, audit: AuditSource, fmtTime: (ts: number) => string): string {
  const q = parseAuditCommand(query)
  return q.summary
    ? renderAuditSummary(audit.summary(q.filter))
    : renderAuditLines(audit.recent({ ...q.filter, limit: q.filter.limit ?? 25 }), fmtTime)
}

export interface ToolUsageSource {
  forAgent(agent: string): AgentToolUsage | undefined
  snapshot(): AgentToolUsage[]
}

function fmtToolUsage(a: AgentToolUsage): string {
  return `**${a.agent}** — ` + (Object.entries(a.tools)
    .sort((x, y) => y[1].count - x[1].count)
    .map(([n, s]) => `${n} ×${s.count}${s.errors ? ` (${s.errors}✗)` : ""}`).join(" · ") || "_none_")
}

/** Same output as the `!tools` Discord command (per-agent or fleet-wide). */
export function buildToolsText(who: string, toolUsage: ToolUsageSource): string {
  if (who) {
    const a = toolUsage.forAgent(who)
    return a ? fmtToolUsage(a) : `_no tool activity for ${who}_`
  }
  const snap = toolUsage.snapshot()
  return snap.length ? snap.map(fmtToolUsage).join("\n") : "_no tool activity yet_"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/commandActions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add hub/commandActions.ts hub/commandActions.test.ts
git commit -m "feat(web): extract buildAuditText/buildToolsText for reuse by the web panel"
```

---

### Task 4: `hub/webActions.ts` — approval JSON projection + web message construction

**Files:**
- Create: `hub/webActions.ts`
- Test: `hub/webActions.test.ts`

**Interfaces:**
- Consumes: `InboundMessage` from `./types`; `PendingApproval` from `./approval`.
- Produces:
  - `export interface PendingApprovalJson { id: string; kind: string; target: string; actor: string; chat?: string; summary: string; createdAt: number; expiresAt: number }`
  - `export function pendingApprovalsToJson(list: PendingApproval[]): PendingApprovalJson[]`
  - `export function buildWebInboundMessage(chatId: string, email: string, text: string, now: number, genId: () => string): InboundMessage`
  - `export function formatMirrorLine(email: string, text: string): string`
- Consumed by: Task 6 (`webServer.ts` routes), Task 7 (`index.ts` wiring).

- [ ] **Step 1: Write the failing test**

```ts
// hub/webActions.test.ts
import { test, expect } from "bun:test"
import { pendingApprovalsToJson, buildWebInboundMessage, formatMirrorLine } from "./webActions"
import type { PendingApproval } from "./approval"

test("pendingApprovalsToJson projects the fields the panel needs, drops `fire`/`state`", () => {
  const e: PendingApproval = {
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub", chat: "chan-1",
    summary: "POST → route-a", createdAt: 100, expiresAt: 200, state: "pending", fire: () => {},
  }
  expect(pendingApprovalsToJson([e])).toEqual([{
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub", chat: "chan-1",
    summary: "POST → route-a", createdAt: 100, expiresAt: 200,
  }])
})

test("buildWebInboundMessage tags the actor as web:<email> and isn't a DM", () => {
  const m = buildWebInboundMessage("chan-1", "aurora@player-ready.co.uk", "hello", 1000, () => "web-1")
  expect(m).toEqual({
    chatId: "chan-1", messageId: "web-1", userId: "web:aurora@player-ready.co.uk",
    user: "aurora@player-ready.co.uk", content: "hello", ts: new Date(1000).toISOString(), isDM: false,
  })
})

test("formatMirrorLine matches the Discord mirror convention", () => {
  expect(formatMirrorLine("aurora@player-ready.co.uk", "hello")).toBe(
    "**aurora@player-ready.co.uk (web):** hello",
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/webActions.test.ts`
Expected: FAIL — cannot find module `./webActions`

- [ ] **Step 3: Implement `webActions.ts`**

```ts
// hub/webActions.ts
import type { InboundMessage } from "./types"
import type { PendingApproval } from "./approval"

export interface PendingApprovalJson {
  id: string
  kind: string
  target: string
  actor: string
  chat?: string
  summary: string
  createdAt: number
  expiresAt: number
}

/** Project pending approvals for the web panel — drops `fire` (a closure,
 *  not serializable) and `state` (the list only ever contains "pending"). */
export function pendingApprovalsToJson(list: PendingApproval[]): PendingApprovalJson[] {
  return list.map((e) => ({
    id: e.id, kind: e.kind, target: e.target, actor: e.actor, chat: e.chat,
    summary: e.summary, createdAt: e.createdAt, expiresAt: e.expiresAt,
  }))
}

/** Build the InboundMessage for a web-sent chat message — routed through the
 *  exact same orchestrator.handleMessage() path as a Discord message, tagged
 *  so audit/actor attribution reads `web:<email>` instead of a Discord id.
 *  `genId` is injected (house rule: no Math.random for identifiers). */
export function buildWebInboundMessage(
  chatId: string, email: string, text: string, now: number, genId: () => string,
): InboundMessage {
  return {
    chatId, messageId: genId(), userId: `web:${email}`, user: email,
    content: text, ts: new Date(now).toISOString(), isDM: false,
  }
}

/** The line posted to the real Discord channel when a web chat message is
 *  mirrored in, so Discord-side participants see who sent it and from where. */
export function formatMirrorLine(email: string, text: string): string {
  return `**${email} (web):** ${text}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/webActions.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add hub/webActions.ts hub/webActions.test.ts
git commit -m "feat(web): add webActions — approval JSON projection + web-origin message builder"
```

---

### Task 5: `hub/web.ts` — extend the dashboard payload + HTML for approvals & chat

**Files:**
- Modify: `hub/web.ts`
- Test: `hub/web.test.ts`

**Interfaces:**
- Consumes: `pendingApprovalsToJson`, `PendingApprovalJson` from `./webActions` (Task 4).
- Produces: `WebInput.pendingApprovalList: PendingApproval[]` (new field — raw entries; the hub, not this pure module, supplies them); `DashboardJson.pendingApprovalList: PendingApprovalJson[]`.
- Consumed by: Task 6 (`webServer.ts`), Task 7 (`index.ts`'s `collectWeb()`).

- [ ] **Step 1: Write the failing test**

Append to `hub/web.test.ts`:

```ts
import { renderDashboardJson } from "./web"
import type { PendingApproval } from "./approval"

test("renderDashboardJson projects pendingApprovalList via webActions", () => {
  const e: PendingApproval = {
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub",
    summary: "POST → route-a", createdAt: 100, expiresAt: 200, state: "pending", fire: () => {},
  }
  const json = renderDashboardJson({
    now: 1000, startedAt: 0,
    status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
    audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
    recent: [], pendingApprovals: 1, pendingApprovalList: [e],
  })
  expect(json.pendingApprovalList).toEqual([{
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub", chat: undefined,
    summary: "POST → route-a", createdAt: 100, expiresAt: 200,
  }])
})

test("the dashboard HTML has an approvals panel and a channel chat pane", () => {
  expect(DASHBOARD_HTML).toContain('id="approvals"')
  expect(DASHBOARD_HTML).toContain('id="chat"')
  expect(DASHBOARD_HTML).toContain("api/channels")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/web.test.ts`
Expected: FAIL — `WebInput` has no `pendingApprovalList` (TS error surfaces as a runtime property mismatch since `renderDashboardJson` won't read it yet), and the HTML assertions fail (no such ids/text yet).

- [ ] **Step 3: Extend `WebInput`/`DashboardJson`/`renderDashboardJson`**

In `hub/web.ts`, update the imports and interfaces:

```ts
import type { StatusSnapshot } from "./statusRegistry"
import type { AuditEvent, AuditSummary } from "./types"
import type { PendingApproval } from "./approval"
import { renderHealth } from "./metrics"
import { pendingApprovalsToJson, type PendingApprovalJson } from "./webActions"

export interface WebInput {
  now: number
  startedAt: number
  status: StatusSnapshot
  audit: AuditSummary
  recent: AuditEvent[]
  pendingApprovals: number
  pendingApprovalList: PendingApproval[]   // NEW
}

export interface DashboardJson {
  status: "ok" | "degraded"
  uptimeSec: number
  routeRate10m: number
  pendingApprovals: number
  pendingApprovalList: PendingApprovalJson[]   // NEW
  agents: { name: string; alive: boolean; busy: boolean; contextFill: number; queueDepth: number; costUsd: number; replicas: number }[]
  ephemerals: { jobId: string; agent: string; task: string }[]
  audit: AuditSummary
  recent: { ts: number; kind: string; actor: string; action: string; target?: string; outcome: string }[]
}
```

In `renderDashboardJson`, add one line to the returned object:

```ts
    pendingApprovalList: pendingApprovalsToJson(i.pendingApprovalList),
```

- [ ] **Step 4: Extend `DASHBOARD_HTML`**

In `hub/web.ts`, inside the `<main>` section, add two new `<section>`s after the existing "Recent activity" section (still inside the closing `</main>`):

```html
  <section><h2>Approvals</h2><div id="approvals" class="muted">no pending approvals</div></section>
  <section>
    <h2>Channel chat</h2>
    <select id="channelPicker"><option value="">select a channel…</option></select>
    <div id="cmdRow" style="margin:8px 0"></div>
    <div id="chat" class="feed" style="max-height:320px;overflow-y:auto"></div>
    <form id="chatForm" style="margin-top:8px;display:flex;gap:8px">
      <input id="chatInput" type="text" placeholder="Message this channel…" style="flex:1;background:#1a1d24;border:1px solid #232733;color:#e6e6e6;padding:6px 8px;border-radius:4px">
      <button type="submit">Send</button>
    </form>
  </section>
```

Add the corresponding rendering + wiring to the `<script>` block — extend `render(d)` with an approvals section, and add channel/chat/SSE/command logic:

```js
function renderApprovals(list){
  $('approvals').innerHTML = list.length ? list.map(function(a){
    return '<div style="margin-bottom:8px">'+esc(a.summary)+' <span class="muted">('+esc(a.kind)+' · '+esc(a.target)+' · by '+esc(a.actor)+')</span> '+
      '<button data-appr="'+a.id+'" data-decision="grant">Approve</button> '+
      '<button data-appr="'+a.id+'" data-decision="deny">Deny</button></div>';
  }).join('') : 'no pending approvals';
}
document.addEventListener('click', function(ev){
  var btn = ev.target.closest('[data-appr]');
  if (!btn) return;
  fetch('api/approvals/'+btn.getAttribute('data-appr'), {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({decision: btn.getAttribute('data-decision')}),
  }).then(poll);
});

var currentChannel = null, es = null;
function chatLine(e){
  var div = document.createElement('div');
  div.textContent = fmtTime(e.ts)+' ['+e.origin+'] '+e.author+': '+e.content;
  return div;
}
function openChannel(id){
  if (es) { es.close(); es = null; }
  currentChannel = id;
  $('chat').innerHTML = '';
  if (!id) return;
  fetch('api/channel/'+id+'/history').then(function(r){ return r.json(); }).then(function(rows){
    rows.forEach(function(e){ $('chat').appendChild(chatLine(e)); });
    $('chat').scrollTop = $('chat').scrollHeight;
  });
  es = new EventSource('api/channel/'+id+'/stream');
  es.onmessage = function(ev){
    $('chat').appendChild(chatLine(JSON.parse(ev.data)));
    $('chat').scrollTop = $('chat').scrollHeight;
  };
  $('cmdRow').innerHTML = '<button data-cmd="audit">Audit</button> <button data-cmd="tools">Tools</button>';
}
$('channelPicker').addEventListener('change', function(){ openChannel(this.value || null); });
document.addEventListener('click', function(ev){
  var btn = ev.target.closest('[data-cmd]');
  if (!btn || !currentChannel) return;
  fetch('api/command/'+btn.getAttribute('data-cmd'), {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({channelId: currentChannel}),
  });
});
$('chatForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  if (!currentChannel) return;
  var text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  fetch('api/channel/'+currentChannel+'/message', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({text: text}),
  });
});
function loadChannels(){
  fetch('api/channels').then(function(r){ return r.json(); }).then(function(rows){
    var sel = $('channelPicker');
    var have = {}; for (var i=1;i<sel.options.length;i++) have[sel.options[i].value]=true;
    rows.forEach(function(c){
      if (have[c.channelId]) return;
      var opt = document.createElement('option');
      opt.value = c.channelId; opt.textContent = (c.name || c.channelId) + ' ('+c.agent+')';
      sel.appendChild(opt);
    });
  });
}
loadChannels(); setInterval(loadChannels, 15000);
```

And extend the existing `render(d)` function (called from `poll()`) with one added line, right after the `$('feed').innerHTML=...` block:

```js
  renderApprovals(d.pendingApprovalList);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test hub/web.test.ts`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors from `hub/web.ts`

- [ ] **Step 7: Commit**

```bash
git add hub/web.ts hub/web.test.ts
git commit -m "feat(web): approvals panel + channel chat pane in the dashboard UI"
```

---

### Task 6: `hub/webServer.ts` — new authenticated routes

**Files:**
- Modify: `hub/webServer.ts`
- Modify: `tests/webServer.test.ts`

**Interfaces:**
- Consumes: `WebInput`, `DashboardJson`, `renderDashboardJson`, `DASHBOARD_HTML` from `./web`; `ChannelEvent`, `ChannelStream` from `./channelStream` (Task 2 — only the `ChannelEvent` type is needed here, the instance is injected).
- Produces:
  ```ts
  export interface ChannelInfo { channelId: string; name?: string; agent: string }
  export interface WebDeps {
    collect: () => WebInput
    requireUser: (req: Request) => string | null   // reads X-Switchboard-User; null ⇒ missing
    resolveApproval: (id: string, decision: "grant" | "deny", actor: string) => Promise<"granted" | "denied" | "not_found"> 
    listChannels: () => ChannelInfo[]
    fetchChannelHistory: (channelId: string) => Promise<{ ts: number; author: string; content: string; origin: "discord" | "web" | "agent" }[]>
    subscribeChannel: (channelId: string, cb: (evt: { ts: number; author: string; content: string; origin: "discord" | "web" | "agent" }) => void) => () => void
    sendChannelMessage: (channelId: string, email: string, text: string) => Promise<void>
    runCommand: (name: string, channelId: string) => Promise<string | null>   // null ⇒ unknown command
  }
  export function handleWebRequest(req: Request, deps: WebDeps): Promise<Response>
  export function startWebServer(port: number, deps: WebDeps, host?: string): { stop: () => void } | null
  ```
- Consumed by: Task 7 (`index.ts` — supplies the real `WebDeps`).

- [ ] **Step 1: Write the failing tests**

Rewrite `tests/webServer.test.ts` in full (the existing 3 tests move to the new async/deps shape, plus new ones):

```ts
import { test, expect } from "bun:test"
import { handleWebRequest } from "../hub/webServer"
import type { WebInput, DashboardJson } from "../hub/web"
import type { WebDeps } from "../hub/webServer"

const baseInput = (): WebInput => ({
  now: 1000, startedAt: 0,
  status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
  audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
  recent: [], pendingApprovals: 0, pendingApprovalList: [],
})

function fakeDeps(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    collect: baseInput,
    requireUser: (req) => req.headers.get("x-switchboard-user"),
    resolveApproval: async () => "not_found",
    listChannels: () => [],
    fetchChannelHistory: async () => [],
    subscribeChannel: () => () => {},
    sendChannelMessage: async () => {},
    runCommand: async () => null,
    ...overrides,
  }
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "GET", headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://hub${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

test("GET / → 200 HTML dashboard (no auth required)", async () => {
  const res = await handleWebRequest(get("/"), fakeDeps())
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/html")
})

test("GET /api/status → 200 JSON payload (no auth required)", async () => {
  const res = await handleWebRequest(get("/api/status"), fakeDeps())
  expect(res.status).toBe(200)
  const json = (await res.json()) as DashboardJson
  expect(json.status).toBe("ok")
  expect(json.pendingApprovalList).toEqual([])
})

test("POST / → 405, unknown path → 404", async () => {
  expect((await handleWebRequest(post("/", {}, { "x-switchboard-user": "a@b.com" }), fakeDeps())).status).toBe(405)
  expect((await handleWebRequest(get("/nope"), fakeDeps())).status).toBe(404)
})

test("POST /api/approvals/:id without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(post("/api/approvals/appr-1", { decision: "grant" }), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/approvals/:id grant → 200, calls resolveApproval with the header identity", async () => {
  let called: [string, string, string] | null = null
  const deps = fakeDeps({
    resolveApproval: async (id, decision, actor) => { called = [id, decision, actor]; return "granted" },
  })
  const res = await handleWebRequest(post("/api/approvals/appr-1", { decision: "grant" }, { "x-switchboard-user": "aurora@player-ready.co.uk" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ state: "granted" })
  expect(called).toEqual(["appr-1", "grant", "aurora@player-ready.co.uk"])
})

test("POST /api/approvals/:id already resolved → 409", async () => {
  const deps = fakeDeps({ resolveApproval: async () => "not_found" })
  const res = await handleWebRequest(post("/api/approvals/appr-1", { decision: "deny" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(409)
})

test("GET /api/channels → 200 JSON list", async () => {
  const deps = fakeDeps({ listChannels: () => [{ channelId: "c1", agent: "qa" }] })
  const res = await handleWebRequest(get("/api/channels", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ channelId: "c1", agent: "qa" }])
})

test("GET /api/channel/:id/history → 200 JSON list", async () => {
  const deps = fakeDeps({ fetchChannelHistory: async (id) => { expect(id).toBe("c1"); return [{ ts: 1, author: "x", content: "hi", origin: "discord" }] } })
  const res = await handleWebRequest(get("/api/channel/c1/history", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual([{ ts: 1, author: "x", content: "hi", origin: "discord" }])
})

test("POST /api/channel/:id/message → 200, calls sendChannelMessage", async () => {
  let called: [string, string, string] | null = null
  const deps = fakeDeps({ sendChannelMessage: async (id, email, text) => { called = [id, email, text] } })
  const res = await handleWebRequest(post("/api/channel/c1/message", { text: "hello" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual(["c1", "a@b.com", "hello"])
})

test("POST /api/command/:name → 200 with text, unknown command → 404", async () => {
  const deps = fakeDeps({ runCommand: async (name) => (name === "audit" ? "📜 audit: no matching events." : null) })
  const ok = await handleWebRequest(post("/api/command/audit", { channelId: "c1" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ text: "📜 audit: no matching events." })
  const bad = await handleWebRequest(post("/api/command/nope", { channelId: "c1" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(bad.status).toBe(404)
})

test("GET /api/channel/:id/stream → SSE headers, subscribes and unsubscribes on cancel", async () => {
  let unsubscribed = false
  const deps = fakeDeps({
    subscribeChannel: (id, cb) => {
      expect(id).toBe("c1")
      cb({ ts: 1, author: "x", content: "hi", origin: "web" })
      return () => { unsubscribed = true }
    },
  })
  const res = await handleWebRequest(get("/api/channel/c1/stream", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toContain('"content":"hi"')
  await reader.cancel()
  expect(unsubscribed).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/webServer.test.ts`
Expected: FAIL — `handleWebRequest` doesn't accept a `WebDeps` object yet, no `WebDeps` export, routes don't exist.

- [ ] **Step 3: Implement the extended `webServer.ts`**

```ts
// hub/webServer.ts
import { DASHBOARD_HTML, renderDashboardJson, type WebInput } from "./web"

export interface ChannelInfo { channelId: string; name?: string; agent: string }
export interface ChannelMessageJson { ts: number; author: string; content: string; origin: "discord" | "web" | "agent" }

export interface WebDeps {
  collect: () => WebInput
  requireUser: (req: Request) => string | null
  resolveApproval: (id: string, decision: "grant" | "deny", actor: string) => Promise<"granted" | "denied" | "not_found">
  listChannels: () => ChannelInfo[]
  fetchChannelHistory: (channelId: string) => Promise<ChannelMessageJson[]>
  subscribeChannel: (channelId: string, cb: (evt: ChannelMessageJson) => void) => () => void
  sendChannelMessage: (channelId: string, email: string, text: string) => Promise<void>
  runCommand: (name: string, channelId: string) => Promise<string | null>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function sseResponse(subscribe: (cb: (evt: ChannelMessageJson) => void) => () => void): Response {
  let unsubscribe: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      unsubscribe = subscribe((evt) => controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`)))
    },
    cancel() { unsubscribe() },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

export async function handleWebRequest(req: Request, deps: WebDeps): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (method === "GET" && path === "/api/status") {
    return json(renderDashboardJson(deps.collect()))
  }

  // Every route below requires the identity header the ReadyApp proxy sets.
  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path)
  const channelHistoryMatch = /^\/api\/channel\/([^/]+)\/history$/.exec(path)
  const channelStreamMatch = /^\/api\/channel\/([^/]+)\/stream$/.exec(path)
  const channelMessageMatch = /^\/api\/channel\/([^/]+)\/message$/.exec(path)
  const commandMatch = /^\/api\/command\/([^/]+)$/.exec(path)
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelStreamMatch || channelMessageMatch || commandMatch

  if (isGuardedRoute) {
    const email = deps.requireUser(req)
    if (!email) return json({ error: "missing_identity" }, 400)

    if (method === "GET" && path === "/api/channels") return json(deps.listChannels())

    if (method === "POST" && approvalMatch) {
      const body = (await req.json().catch(() => null)) as { decision?: "grant" | "deny" } | null
      if (body?.decision !== "grant" && body?.decision !== "deny") return json({ error: "bad_decision" }, 400)
      const state = await deps.resolveApproval(approvalMatch[1], body.decision, email)
      return state === "not_found" ? json({ state }, 409) : json({ state })
    }

    if (method === "GET" && channelHistoryMatch) {
      return json(await deps.fetchChannelHistory(channelHistoryMatch[1]))
    }

    if (method === "GET" && channelStreamMatch) {
      return sseResponse((cb) => deps.subscribeChannel(channelStreamMatch[1], cb))
    }

    if (method === "POST" && channelMessageMatch) {
      const body = (await req.json().catch(() => null)) as { text?: string } | null
      if (!body?.text) return json({ error: "missing_text" }, 400)
      await deps.sendChannelMessage(channelMessageMatch[1], email, body.text)
      return json({ ok: true })
    }

    if (method === "POST" && commandMatch) {
      const body = (await req.json().catch(() => null)) as { channelId?: string } | null
      if (!body?.channelId) return json({ error: "missing_channelId" }, 400)
      const text = await deps.runCommand(commandMatch[1], body.channelId)
      return text === null ? json({ error: "unknown_command" }, 404) : json({ text })
    }
  }

  if (method !== "GET" && method !== "POST") return new Response("method", { status: 405 })
  return new Response("not found", { status: 404 })
}

export function startWebServer(port: number, deps: WebDeps, host = "127.0.0.1"): { stop: () => void } | null {
  if (!port) return null
  const server = Bun.serve({ port, hostname: host, fetch: (req) => handleWebRequest(req, deps) })
  return { stop: () => server.stop(true) }
}
```

Note on the `POST / → 405` test: `/` only has a `GET` handler above, so a `POST /` falls through every guarded-route check (none match `/`) to the final `method !== "GET" && method !== "POST"` check — which is `false` for POST, so it would incorrectly reach `return new Response("not found", { status: 404 })`. Fix: change the final fallback to explicitly 405 when the path matched no route but the method is POST/GET, vs 404 only for truly unknown methods. Simplest correct fix — add an explicit check right after the `GET /` and `GET /api/status` handlers:

```ts
  if (path === "/" || path === "/api/status") return new Response("method", { status: 405 })
```

Insert this line immediately after the `GET /api/status` block (before the guarded-route regexes), so a non-GET request to `/` or `/api/status` returns 405 before falling through.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/webServer.test.ts`
Expected: PASS (all 11 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add hub/webServer.ts tests/webServer.test.ts
git commit -m "feat(web): approvals, channel history/stream/message, and command routes"
```

---

### Task 7: `hub/index.ts` — wire real dependencies

**Files:**
- Modify: `hub/index.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–6.
- No new exports (this is the untested wiring layer — verified manually per Task 11).

- [ ] **Step 1: Track recently-active channels**

Near the top-level state declarations (alongside `approvalCards`, around `hub/index.ts:578`), add:

```ts
const channelActivity = new Map<string, { agent: string; lastActive: number }>()
const channelStream = new ChannelStream()
```

Add the import at the top of the file: `import { ChannelStream, type ChannelEvent } from "./channelStream"` and `import { pendingApprovalsToJson, buildWebInboundMessage, formatMirrorLine } from "./webActions"` and `import { buildAuditText, buildToolsText } from "./commandActions"` and `import type { WebDeps, ChannelInfo, ChannelMessageJson } from "./webServer"`.

- [ ] **Step 2: Record channel activity + mirror agent replies, in `onAgentReply`**

In `hub/index.ts`, at the `reply.kind === "reply" && reply.text` block (around line 864-889), right before the existing `await gateway.sendReply(reply, agents[reply.agent])` on line 890, add:

```ts
    channelActivity.set(reply.chatId, { agent: reply.agent, lastActive: Date.now() })
    channelStream.publish(reply.chatId, { ts: Date.now(), author: reply.agent, content: reply.text, origin: "agent" })
```

(This sits inside the `if (reply.kind === "reply" && reply.text)` block, so it only fires for genuine text replies — matching exactly what reaches Discord as a message, not cards/reacts/edits which have their own render paths.)

- [ ] **Step 3: Mirror human Discord messages, in `gateway.handleInbound`**

At the very top of the `gateway.handleInbound((m) => { ... })` callback (`hub/index.ts:1509`, before the `!workflows` check), add:

```ts
  channelStream.publish(m.chatId, { ts: Date.now(), author: m.user, content: m.content, origin: "discord" })
```

- [ ] **Step 4: Refactor `!audit` and `!tools` branches to use `commandActions`**

Replace the body of the `!audit` branch (`hub/index.ts:1534-1544`) with:

```ts
  if (/^!audit\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    if (!hub.audit?.enabled) { void gateway.sendPlain(m.chatId, "📜 audit logging is off (set `hub.audit.enabled`)."); return }
    void gateway.sendPlain(m.chatId, buildAuditText(trimmed.replace(/^!audit\b/i, ""), audit, (ts) => new Date(ts).toISOString().slice(11, 19)))
    return
  }
```

Replace the body of the `!tools` branch (`hub/index.ts:1564-1579`) with:

```ts
  if (toolObs && /^!tools\b/i.test(trimmed)) {
    if (!baseGate.listAllowed().includes(m.userId)) return
    void gateway.sendPlain(m.chatId, buildToolsText(trimmed.replace(/^!tools\b/i, "").trim(), toolUsage))
    return
  }
```

(Both are behavior-preserving — `buildAuditText`/`buildToolsText` contain exactly the logic that was inline before, verified by Task 3's tests.)

- [ ] **Step 5: Extend `collectWeb()` with the new approval list**

Update `collectWeb()` (`hub/index.ts:1663-1666`):

```ts
function collectWeb(): WebInput {
  return { ...collectMetrics(), recent: audit.recent({ limit: 30 }), pendingApprovalList: approvalRegistry.list() }
}
```

- [ ] **Step 6: Build the real `WebDeps` and switch `startWebServer`'s call**

Replace the `startWebServer(hub.webPort ?? 0, collectWeb, hub.webHost)` call (`hub/index.ts:1668`) with a `webDeps` object built first, then passed:

```ts
const webDeps: WebDeps = {
  collect: collectWeb,
  requireUser: (req) => req.headers.get("x-switchboard-user"),

  resolveApproval: async (id, decision, actor) => {
    // Deliberately NOT calling the existing resolveApproval(id, decision, userId) —
    // it hardcodes `actor: \`user:${userId}\`` for the audit row, which would
    // double-prefix a web actor as "user:web:<email>". Inline the same steps
    // (registry resolve → audit → card edit → fire) with a clean "web:<email>" actor.
    const e = approvalRegistry.resolve(id, decision)
    if (!e) return "not_found"
    audit.record({
      kind: "approval", actor: `web:${actor}`, action: decision === "grant" ? "grant" : "deny",
      target: e.target, chat: e.chat, outcome: decision === "grant" ? "ok" : "deny", corr: e.id,
    })
    const loc = approvalCards.get(e.id); approvalCards.delete(e.id)
    if (loc) await gateway.editCard(loc.chatId, loc.messageId, renderApprovalCard(e))
    if (decision === "grant") {
      try { await e.fire(e.id) } catch (err) { process.stderr.write(`approval ${e.id} fire failed: ${err}\n`) }
    }
    return decision === "grant" ? "granted" : "denied"
  },

  listChannels: (): ChannelInfo[] => {
    const now = Date.now()
    return [...channelActivity.entries()]
      .filter(([, v]) => now - v.lastActive < 24 * 60 * 60 * 1000)   // last 24h
      .sort((a, b) => b[1].lastActive - a[1].lastActive)
      .map(([channelId, v]) => ({ channelId, agent: v.agent }))
  },

  fetchChannelHistory: async (channelId): Promise<ChannelMessageJson[]> => {
    try {
      const ch = await gateway.client.channels.fetch(channelId)
      if (!ch || !("messages" in ch)) return []
      const msgs = await (ch as any).messages.fetch({ limit: 50 })
      return [...msgs.values()].reverse().map((msg: any) => ({
        ts: msg.createdTimestamp,
        author: msg.author.username,
        content: msg.content,
        origin: msg.author.bot ? "agent" : "discord",
      }))
    } catch { return [] }
  },

  subscribeChannel: (channelId, cb) => channelStream.subscribe(channelId, cb as (e: ChannelEvent) => void),

  sendChannelMessage: async (channelId, email, text) => {
    await gateway.sendPlain(channelId, formatMirrorLine(email, text))
    channelStream.publish(channelId, { ts: Date.now(), author: email, content: text, origin: "web" })
    const inbound = buildWebInboundMessage(channelId, email, text, Date.now(), () => `web-${++webMsgCounter}`)
    void orchestrator.handleMessage(inbound)
  },

  runCommand: async (name, channelId): Promise<string | null> => {
    if (name === "audit") {
      if (!hub.audit?.enabled) return "📜 audit logging is off (set `hub.audit.enabled`)."
      return buildAuditText("", audit, (ts) => new Date(ts).toISOString().slice(11, 19))
    }
    if (name === "tools" && toolObs) {
      return buildToolsText("", toolUsage)
    }
    return null
  },
}
const webServer = startWebServer(hub.webPort ?? 0, webDeps, hub.webHost)
```

Add `let webMsgCounter = 0` near the other counters (alongside `let approvalCounter = 0` and `let jobCounter = 0`).

- [ ] **Step 7: Run the full hub test suite**

Run: `bun test`
Expected: PASS — all existing + new tests green (no test directly exercises `index.ts`, so this step is really confirming Tasks 1–6's tests still pass after the imports/wiring land, plus catching any accidental syntax error).

- [ ] **Step 8: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 9: Manual smoke test**

Run: `bun run hub` (with a real `config/hub.config.json`/`config/agents.json` and Discord token configured, `webPort` set) — confirm the hub boots without throwing, and `curl localhost:8080/api/status` returns JSON including an (empty) `pendingApprovalList`.

- [ ] **Step 10: Commit**

```bash
git add hub/index.ts
git commit -m "feat(web): wire approvals/channel-chat/commands into the running hub"
```

---

## Part B — ReadyApp (`C:\Users\Aura\Documents\Ready\ReadyApp`)

### Task 8: `switchboardCommandPanel` AppSetting flag

**Files:**
- Modify: `apps/api/src/routes/adminSettings.ts`
- Test: `apps/api/src/routes/adminSettings.test.ts` (add to the existing file if present, else create alongside following the file's existing test conventions — check for an existing `adminSettings.test.ts` first and match its harness).

**Interfaces:**
- Produces (exported from `adminSettings.ts` for reuse by Task 9):
  - `export const SWITCHBOARD_COMMAND_PANEL_KEY = "switchboard_command_panel_flags"`
  - `export type SwitchboardCommandPanelFlags = { enabled: boolean; allowlist: string[] }`
  - `export function parseSwitchboardCommandPanelFlags(value: unknown): SwitchboardCommandPanelFlags`
  - Routes: `GET /settings/switchboard-command-panel-flags` (`requireAuthenticated()`), `PUT /admin/switchboard-command-panel-flags` (`requirePermission("admin.settings.update")`)

- [ ] **Step 1: Write the failing test**

Add to the test file (mirror the file's existing Fastify-handler-capture or `app.inject` pattern used for the onboarding-flags tests — find those tests first with `grep -n "onboarding-flags" apps/api/src/routes/adminSettings.test.ts` and copy their exact harness style):

```ts
test("GET /settings/switchboard-command-panel-flags returns the default when unset", async () => {
  // mock prisma.appSetting.findUnique to resolve null, matching the onboarding-flags default test
  const res = await inject({ method: "GET", url: "/settings/switchboard-command-panel-flags" })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ data: { enabled: false, allowlist: [] } })
})

test("PUT /admin/switchboard-command-panel-flags upserts and audits", async () => {
  const res = await inject({
    method: "PUT", url: "/admin/switchboard-command-panel-flags",
    payload: { flags: { enabled: true, allowlist: ["aurora.nicholas@player-ready.co.uk"] } },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ data: { enabled: true, allowlist: ["aurora.nicholas@player-ready.co.uk"] } })
  // assert prisma.appSetting.upsert was called with key SWITCHBOARD_COMMAND_PANEL_KEY, matching the onboarding test's assertion style
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tutoring/api exec vitest run src/routes/adminSettings.test.ts -t "switchboard-command-panel"`
Expected: FAIL — route not found (404)

- [ ] **Step 3: Implement the flag**

In `apps/api/src/routes/adminSettings.ts`, near `ONBOARDING_FLAGS_KEY`/`parseOnboardingFlags` (around line 93-113), add:

```ts
export const SWITCHBOARD_COMMAND_PANEL_KEY = "switchboard_command_panel_flags";

/** Web command panel access — the single allowlist gating the whole
 *  /switchboard route (read dashboard + write actions) in switchboardProxy.ts.
 *  Fail-closed default: disabled, empty allowlist. */
export type SwitchboardCommandPanelFlags = { enabled: boolean; allowlist: string[] };
const SWITCHBOARD_COMMAND_PANEL_DEFAULT: SwitchboardCommandPanelFlags = { enabled: false, allowlist: [] };
export function parseSwitchboardCommandPanelFlags(value: unknown): SwitchboardCommandPanelFlags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return SWITCHBOARD_COMMAND_PANEL_DEFAULT;
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : SWITCHBOARD_COMMAND_PANEL_DEFAULT.enabled,
    allowlist: Array.isArray(raw.allowlist)
      ? raw.allowlist.filter((e): e is string => typeof e === "string")
      : SWITCHBOARD_COMMAND_PANEL_DEFAULT.allowlist,
  };
}
```

Next to the onboarding routes (around line 1888-1919), add:

```ts
fastify.get("/settings/switchboard-command-panel-flags", { preHandler: requireAuthenticated() }, async () => {
  const value = await getCachedSetting(SWITCHBOARD_COMMAND_PANEL_KEY);
  return { data: parseSwitchboardCommandPanelFlags(value) };
});
fastify.put("/admin/switchboard-command-panel-flags", { preHandler: requirePermission("admin.settings.update") }, async (request) => {
  const flags = parseSwitchboardCommandPanelFlags((request.body as { flags?: unknown })?.flags);
  await prisma.appSetting.upsert({
    where: { key: SWITCHBOARD_COMMAND_PANEL_KEY },
    update: { value: flags },
    create: { key: SWITCHBOARD_COMMAND_PANEL_KEY, value: flags },
  });
  await auditAppSettingChange(SWITCHBOARD_COMMAND_PANEL_KEY, request.user?.entraOid ?? "unknown");
  return { data: flags };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tutoring/api exec vitest run src/routes/adminSettings.test.ts -t "switchboard-command-panel"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tutoring/api exec tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/adminSettings.ts apps/api/src/routes/adminSettings.test.ts
git commit -m "feat(api): switchboardCommandPanel AppSetting flag (runtime allowlist, no redeploy)"
```

---

### Task 9: `switchboardProxy.ts` — POST passthrough + identity header + flag-gated allowlist

**Files:**
- Modify: `apps/api/src/routes/switchboardProxy.ts`
- Modify: `apps/api/src/lib/switchboardProxy.ts` (only if `stripPrefix` needs adjustment — verify first; it already operates on any path under `/switchboard`, so no change is expected, but re-run its existing tests as a regression check in Step 4)
- Modify: `apps/api/src/routes/switchboardProxy.test.ts`

**Interfaces:**
- Consumes: `SWITCHBOARD_COMMAND_PANEL_KEY`, `parseSwitchboardCommandPanelFlags` from `./adminSettings.js` (Task 8); `getCachedSetting` from `../lib/appSettingCache.js`.
- Produces: `switchboardProxyRoutes` now forwards `GET`/`POST`, and every proxied request carries `X-Switchboard-User: <email>`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/switchboardProxy.test.ts` (keep the existing tests; update the ones whose assumptions change — the dormant-route test and OID-allowlist tests move from env-var to flag-based, so replace those two, keep the rest):

```ts
vi.mock("../lib/appSettingCache.js", () => ({ getCachedSetting: vi.fn() }));
import { getCachedSetting } from "../lib/appSettingCache.js";

// Replace the old `beforeEach` env-var setup with:
beforeEach(() => {
  requestMock.mockReset();
  process.env.SWITCHBOARD_WEB_PORT = "8080";
  (getCachedSetting as any).mockResolvedValue({ enabled: true, allowlist: ["oid-allowed"] });
});

it("POST forwards body + sets X-Switchboard-User from the request's email", async () => {
  requestMock.mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) });
  const app = await build("oid-allowed", "aurora@player-ready.co.uk");
  const res = await app.inject({ method: "POST", url: "/switchboard/api/approvals/appr-1", payload: { decision: "grant" } });
  expect(res.statusCode).toBe(200);
  expect(requestMock).toHaveBeenCalledWith(
    "http://127.0.0.1:8080/api/approvals/appr-1",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ decision: "grant" }),
      headers: expect.objectContaining({ "x-switchboard-user": "aurora@player-ready.co.uk", "content-type": "application/json" }),
    }),
  );
});

it("flag disabled → 403 even for a listed OID", async () => {
  (getCachedSetting as any).mockResolvedValue({ enabled: false, allowlist: ["oid-allowed"] });
  const app = await build("oid-allowed");
  const res = await app.inject({ method: "GET", url: "/switchboard/api/status" });
  expect(res.statusCode).toBe(403);
});

it("non-allowlisted OID → 403 (flag-based, not env)", async () => {
  const app = await build("oid-evil");
  const res = await app.inject({ method: "GET", url: "/switchboard/api/status" });
  expect(res.statusCode).toBe(403);
});
```

Update the `build()` helper to also inject an `email` onto `request.user` and register the route unconditionally when `SWITCHBOARD_WEB_PORT` is set (dormancy is now port-only, not OID-count-based):

```ts
async function build(oid = "oid-allowed", email = "someone@player-ready.co.uk") {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => { (req as any).user = { entraOid: oid, email }; });
  await app.register(switchboardProxyRoutes);
  return app;
}
```

Update the existing "dormant (no env)" test to only unset `SWITCHBOARD_WEB_PORT` (the flag no longer gates route registration, only per-request authorization):

```ts
it("dormant (no port env) → routes not registered → 404", async () => {
  delete process.env.SWITCHBOARD_WEB_PORT;
  const app = await build("oid-allowed");
  const res = await app.inject({ method: "GET", url: "/switchboard/api/status" });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tutoring/api exec vitest run src/routes/switchboardProxy.test.ts`
Expected: FAIL — POST isn't forwarded, no `X-Switchboard-User` header, allowlist still reads `SWITCHBOARD_UI_OIDS`.

- [ ] **Step 3: Implement**

Replace `apps/api/src/routes/switchboardProxy.ts` in full:

```ts
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { request as undiciRequest } from "undici";
import { requireAuthenticated } from "../policy.js";
import { stripPrefix } from "../lib/switchboardProxy.js";
import { getCachedSetting } from "../lib/appSettingCache.js";
import { SWITCHBOARD_COMMAND_PANEL_KEY, parseSwitchboardCommandPanelFlags } from "./adminSettings.js";

export const switchboardProxyRoutes: FastifyPluginAsync = async (server) => {
  const port = process.env.SWITCHBOARD_WEB_PORT;
  if (!port) return;   // dormant: routes not registered → 404

  const oidGate = async (request: FastifyRequest, reply: FastifyReply) => {
    const flags = parseSwitchboardCommandPanelFlags(await getCachedSetting(SWITCHBOARD_COMMAND_PANEL_KEY));
    if (!flags.enabled || !flags.allowlist.includes(request.user!.entraOid)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  };

  server.get("/switchboard", { preHandler: [requireAuthenticated(), oidGate] }, async (_request, reply) =>
    reply.redirect("/switchboard/", 301),
  );

  const proxy = async (request: FastifyRequest, reply: FastifyReply) => {
    const stripped = stripPrefix(request.url);
    if (!stripped) return reply.code(400).send({ error: "bad_path" });
    try {
      const upstream = await undiciRequest(`http://127.0.0.1:${port}${stripped}`, {
        method: request.method as "GET" | "POST",
        headers: {
          "x-switchboard-user": request.user!.email ?? request.user!.entraOid,
          ...(request.method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
      });
      reply.code(upstream.statusCode);
      const ct = upstream.headers["content-type"];
      if (typeof ct === "string") reply.header("content-type", ct);
      return reply.send(upstream.body);
    } catch {
      return reply.code(502).send({ error: "switchboard_unreachable" });
    }
  };

  server.get("/switchboard/*", { preHandler: [requireAuthenticated(), oidGate] }, proxy);
  server.post("/switchboard/*", { preHandler: [requireAuthenticated(), oidGate] }, proxy);
};
```

(`request.user.email?: string` is confirmed optional on the `AuthedUser` type in `apps/api/src/auth.ts:49` — the `?? request.user!.entraOid` fallback covers synthetic/HubSpot-seeded accounts that haven't logged in via Entra yet and so have no `email` populated.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tutoring/api exec vitest run src/routes/switchboardProxy.test.ts src/lib/switchboardProxy.test.ts`
Expected: PASS (all tests, including the untouched `stripPrefix` unit tests as a regression check)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tutoring/api exec tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Update the deploy env var**

`SWITCHBOARD_UI_OIDS` is no longer read — note in the PR description that it can be removed from `/srv/readyapp/env/api.env` after this ships (not required for the code to work; an orphaned env var is harmless, just note it for cleanup).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/switchboardProxy.ts apps/api/src/routes/switchboardProxy.test.ts
git commit -m "feat(api): POST passthrough + identity header + AppSetting-backed allowlist for /switchboard"
```

---

### Task 10: Web — command-panel flag hook + Feature Flags page entry

**Files:**
- Create: `apps/web/src/lib/switchboard/useSwitchboardCommandPanelFlags.ts`
- Modify: `apps/web/src/pages/settings/SystemFeatureFlags.tsx`

**Interfaces:**
- Consumes: `RolloutFlag` type from `../webFlags` (existing, per Task 8's research: `export type RolloutFlag = { enabled: boolean; allowlist: string[] }` in `apps/web/src/lib/webFlags.ts:6`); `useApi` from `../api`.
- Produces: `export function useSwitchboardCommandPanelFlags(): RolloutFlag` (used later, when the panel UI itself is built inside the iframe/proxied dashboard — this task only wires the admin-facing toggle, since the dashboard UI lives inside `hub/web.ts`'s own HTML, not React).

- [ ] **Step 1: Implement the hook**

```ts
// apps/web/src/lib/switchboard/useSwitchboardCommandPanelFlags.ts
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../api";
import type { RolloutFlag } from "../webFlags";

const FALLBACK: RolloutFlag = { enabled: false, allowlist: [] };

export function useSwitchboardCommandPanelFlags(): RolloutFlag {
  const { apiFetch } = useApi();
  const { data } = useQuery({
    queryKey: ["switchboard-command-panel-flags"],
    queryFn: () => apiFetch<{ data: RolloutFlag }>("/settings/switchboard-command-panel-flags"),
    staleTime: 60_000,
    retry: false,
  });
  return data?.data ?? FALLBACK;
}
```

This task has no test file of its own — it's a thin `useQuery` wrapper matching `useOnboardingFlags`'s non-bootstrap half exactly; correctness is covered by Task 8's API-level tests plus the manual verification in Task 11.

- [ ] **Step 2: Register the flag card**

In `apps/web/src/pages/settings/SystemFeatureFlags.tsx`, inside the `return (...)` of `SystemFeatureFlags()`, add one more `<RolloutFlagCard>` alongside the existing ones (e.g. right after the onboarding card):

```tsx
<RolloutFlagCard
  cardId="flag-switchboard-command-panel"
  title="Switchboard command panel"
  description="Write access to the Switchboard web dashboard — approve/deny gated actions, mirror a Discord channel's chat, run !audit/!tools. Read-only dashboard access is unaffected by this flag."
  getUrl="/settings/switchboard-command-panel-flags"
  putUrl="/admin/switchboard-command-panel-flags"
  queryKey={["switchboard-command-panel-flags"]}
  selectFlag={(d) => d as RolloutFlag}
  buildBody={(_prev, next) => ({ flags: next })}
  canEdit={canEdit}
  isCardOpen={isCardOpen}
  onToggleCard={onToggleCard}
/>
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @tutoring/web exec tsc --noEmit`
Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/switchboard/useSwitchboardCommandPanelFlags.ts apps/web/src/pages/settings/SystemFeatureFlags.tsx
git commit -m "feat(web): switchboard command panel flag card on the Feature Flags page"
```

---

### Task 11: End-to-end wiring check + PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Full hub test + typecheck**

From `C:\Users\Aura\Documents\Ready\Switchboard`:
```bash
bun test
bunx tsc --noEmit
```
Expected: all green.

- [ ] **Step 2: Full ReadyApp API test + typecheck (scoped)**

From `C:\Users\Aura\Documents\Ready\ReadyApp`:
```bash
pnpm --filter @tutoring/api exec vitest run src/routes/switchboardProxy.test.ts src/lib/switchboardProxy.test.ts src/routes/adminSettings.test.ts
pnpm --filter @tutoring/api exec tsc --noEmit
pnpm --filter @tutoring/web exec tsc --noEmit
```
Expected: all green. (Full-repo `pnpm test`/`pnpm typecheck` is optional here given the size of this monorepo — the scoped runs above cover every file this plan touched.)

- [ ] **Step 3: Set the flag on for yourself only (staging/dev config, not prod)**

Via `PUT /admin/switchboard-command-panel-flags` with `{ flags: { enabled: true, allowlist: ["<your-entra-oid>"] } }`, or directly through the new Feature Flags page card (Task 10).

- [ ] **Step 4: Manual verification against a real (dev) hub**

- Approve one real pending approval from the browser at `/switchboard/` — confirm the response is 200 and, if Discord is reachable, the original card there flips to "✅ Approved".
- Pick a channel from the dropdown, confirm history loads (last ≤50 messages) and the SSE connection opens (Network tab shows an `EventStream`).
- Send a message from the web chat box — confirm it appears in the real Discord channel prefixed `**<email> (web):**`, and the agent's reply streams back into the web pane.
- Click "Audit" and "Tools" — confirm text renders in the panel state you wired (per Task 6/7, these post via `/api/command/:name` — the current plan renders their result as an alert/log rather than inline chat; if you want them inline in the chat pane instead, that's a small follow-up to `hub/web.ts`'s `cmdRow` click handler, appending the returned `text` as a synthetic chat line — note this as a fast-follow rather than blocking the PR).

- [ ] **Step 5: Open PRs**

Switchboard repo: push the feature branch, open a PR against `master` (this repo doesn't auto-deploy — no `[deploy: …]` tag needed, that convention is ReadyApp-specific).

ReadyApp repo: push the feature branch, open a PR against `live` with an empty `push:` summary commit tagged `[deploy: api, web]` per this repo's branching convention (`CLAUDE.md`), noting `SWITCHBOARD_WEB_PORT` must already be set in `/srv/readyapp/env/api.env` pointing at the deployed hub's `webPort`, and that `SWITCHBOARD_UI_OIDS` is now unused and can be removed.

- [ ] **Step 6: Note explicit non-goals for anyone picking this up next**

No message edit/delete propagation; no persistent transcript store; `Memory` (`!memory`) command intentionally deferred (stateful pagination doesn't fit the stateless command-button contract built here); Phases 2–4 (deep observability, agent config management, live hub config editing) are separate future specs.
