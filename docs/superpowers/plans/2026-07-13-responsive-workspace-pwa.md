# Responsive Workspace and PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the embedded dashboard at `/` with a responsive React conversation workspace that remains fully usable without Discord and can be installed as a PWA, while preserving the existing operational dashboard at `/legacy` until Phase 4.

**Architecture:** Bun's native HTML/TypeScript/CSS bundler produces `dist/web`, and the existing Bun web listener serves those files plus the existing transport-neutral APIs. A small typed React client owns workspace state, explicit reconnect/gap recovery, local drafts, and responsive navigation; canonical conversation data remains server-owned. The current dashboard remains an isolated compatibility surface rather than being rewritten during this phase.

**Tech Stack:** Bun 1.3+ runtime/bundler, TypeScript, React 19.2.7, React DOM 19.2.7, Testing Library with Happy DOM, Playwright 1.61.1, Axe Playwright 4.12.1, and Sharp 0.35.3 for deterministic PWA icon generation.

## Global Constraints

- Switchboard remains one Bun/TypeScript production process; React and the bundler are build-time/client dependencies, not a second service.
- Use Bun's native HTML/TSX/CSS build pipeline; do not add Vite, React Router, a global state library, or a PWA plugin.
- SQLite remains `<stateDir>/switchboard.sqlite`; no browser database becomes canonical.
- Discord-disabled startup must still provide complete durable web conversations and must not read a Discord token.
- The trusted proxy header name is configurable as `webIdentityHeader`, defaulting to `X-Switchboard-User`; Switchboard still provides no login screen.
- The proxy must strip caller-supplied copies of the trusted header before setting the authenticated identity.
- `/` and client-side workspace routes serve the React shell; `/legacy` serves the existing `DASHBOARD_HTML` until Phase 4 parity and soak are complete.
- Phase 3 implements text Conversations only. Agents, Approvals, Operations, Settings, and canonical attachment composition remain in `/legacy` or the Phase 4 parity backlog; do not render dead controls or duplicate their business logic into React yet.
- New client and API code uses `conversationId`; `chatId` remains only in compatibility code.
- Client-generated idempotency keys survive failed retries and are cleared only after a successful canonical message response.
- The service worker may cache only the application shell and safe static assets. It must never cache `/api/**`, conversation responses, SSE responses, or authenticated operational data.
- Desktop is `>= 1200px`, tablet is `768px–1199px`, and mobile is `< 768px`.
- Desktop shows rail + conversation list + transcript + optional inspector; tablet moves the inspector to a drawer; mobile shows one primary pane with bottom navigation and full-screen drawers.
- Use semantic HTML, visible focus, complete keyboard navigation, labelled controls, an `aria-live="polite"` connection/turn announcer, and respect `prefers-reduced-motion`.
- User messages render only after the canonical POST succeeds. Optimistic state may show `sending`, but it must never imply offline submission succeeded.
- Reconnect first fetches the message gap after the last canonical message sequence, then reopens SSE from that sequence. Dedupe messages by `id` and order by `sequence`.
- Structured turn state is live activity. Canonical transcript messages are the durable reconnect source in this phase; tool/trace/approval parity remains Phase 4.
- Every task runs its focused tests. The phase gate is `bun run typecheck`, `bun test`, `bun run build:web`, and `bun run test:e2e` with zero failures.

---

### Task 1: React build pipeline and static workspace boundary

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.json`
- Create: `scripts/build-web.ts`
- Create: `web/client/index.html`
- Create: `web/client/main.tsx`
- Create: `web/client/styles.css`
- Create: `web/client/testSetup.ts`
- Create: `hub/webAssets.ts`
- Modify: `hub/webServer.ts`
- Test: `tests/webAssets.test.ts`
- Test: `tests/webServer.test.ts`

**Interfaces:**
- Produces: `build:web`, `hub:server`, and `test:e2e` package scripts.
- Produces: `WorkspaceAssetHandler = (pathname: string) => Promise<Response | null>`.
- Produces: `createBuiltWorkspaceAssets(root?: string): WorkspaceAssetHandler`.
- Changes: `handleWebRequest(req, deps, workspaceAssets?)` serves `/legacy` itself and delegates non-API GET routes to `workspaceAssets`.
- Preserves: all existing `/api/**` request semantics and `startWebServer` shutdown behavior.

- [ ] **Step 1: Add the pinned client and test dependencies**

Run:

```powershell
bun add react@19.2.7 react-dom@19.2.7
bun add -d @types/react@19.2.17 @types/react-dom@19.2.3 @testing-library/dom@10.4.1 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 @testing-library/jest-dom@6.9.1 happy-dom@20.10.6 @playwright/test@1.61.1 @axe-core/playwright@4.12.1 sharp@0.35.3
```

Update scripts to this shape while retaining `test` and `typecheck`:

```json
{
  "scripts": {
    "build:web": "bun run scripts/build-web.ts",
    "hub:server": "bun run hub/index.ts",
    "hub": "bun run build:web && bun run hub:server",
    "test": "bun test",
    "test:e2e": "bun run build:web && playwright test",
    "typecheck": "tsc --noEmit"
  }
}
```

Add `"jsx": "react-jsx"` and include `web` and `scripts` in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["hub", "shim", "tests", "web", "scripts"]
}
```

- [ ] **Step 2: Write failing static-asset routing tests**

Add tests proving:

```ts
test("serves index for workspace routes and immutable hashed assets", async () => {
  const root = await tempWorkspace({
    "index.html": "<main id=\"root\"></main>",
    "assets/main-ABC123.js": "export {}",
  })
  const assets = createBuiltWorkspaceAssets(root)
  expect(await (await assets("/")!).text()).toContain("id=\"root\"")
  expect(await (await assets("/conversations/c1")!).text()).toContain("id=\"root\"")
  expect((await assets("/assets/main-ABC123.js"))!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(await assets("/../package.json")).toBeNull()
})

test("root uses workspace assets and legacy keeps the embedded dashboard", async () => {
  const workspace: WorkspaceAssetHandler = async path => path === "/" ? new Response("workspace") : null
  expect(await (await handleWebRequest(new Request("http://x/"), deps(), workspace)).text()).toBe("workspace")
  expect(await (await handleWebRequest(new Request("http://x/legacy"), deps(), workspace)).text()).toContain("Switchboard")
})
```

Run: `bun test tests/webAssets.test.ts tests/webServer.test.ts`

Expected: FAIL because the asset handler and injected workspace route do not exist.

- [ ] **Step 3: Implement the Bun client build**

Create `web/client/index.html` with the manifest/theme metadata and only one root:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#121722" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icons/icon-192.png" />
    <title>Switchboard</title>
    <script type="module" src="./main.tsx"></script>
  </head>
  <body><div id="root"></div></body>
</html>
```

Create the initial entrypoint:

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

export function App() {
  return <main id="workspace"><h1>Switchboard</h1></main>
}

const root = document.getElementById("root")
if (!root) throw new Error("Workspace root is missing")
createRoot(root).render(<StrictMode><App /></StrictMode>)
```

Create the shared Bun/Happy DOM test setup and import it first from every `web/client/*.test.tsx` file:

```ts
import { expect } from "bun:test"
import * as matchers from "@testing-library/jest-dom/matchers"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (typeof document === "undefined") GlobalRegistrator.register({ url: "http://localhost/" })
expect.extend(matchers)
```

Create `scripts/build-web.ts`:

```ts
import { rm, mkdir } from "node:fs/promises"

const outdir = "dist/web"
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
const result = await Bun.build({
  entrypoints: ["web/client/index.html"],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "external",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
if (!(await Bun.file(`${outdir}/index.html`).exists())) throw new Error("Web build did not emit index.html")
```

- [ ] **Step 4: Implement safe static serving and legacy isolation**

Create `hub/webAssets.ts` with an allowlisted MIME map, `resolve()` containment check, SPA fallback for extensionless paths, `no-cache` for `index.html`, `sw.js`, and `manifest.webmanifest`, and immutable caching only for `/assets/*` and `/icons/*` filenames containing a content hash.

The exported boundary is exact:

```ts
export type WorkspaceAssetHandler = (pathname: string) => Promise<Response | null>
export function createBuiltWorkspaceAssets(root = resolve(import.meta.dir, "../dist/web")): WorkspaceAssetHandler
```

Change `handleWebRequest` to accept an optional handler:

```ts
export async function handleWebRequest(
  req: Request,
  deps: WebDeps,
  workspaceAssets: WorkspaceAssetHandler = async () => null,
): Promise<Response> {
  const { pathname } = new URL(req.url)
  if (req.method === "GET" && pathname === "/legacy/") {
    return Response.redirect(new URL("/legacy", req.url), 308)
  }
  if (req.method === "GET" && pathname === "/legacy") {
    return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    return await workspaceAssets(pathname) ?? new Response("workspace_not_built", { status: 503 })
  }
  // existing API dispatch follows unchanged
}
```

Construct `createBuiltWorkspaceAssets()` once in `startWebServer` and pass it into every request. Do not read the asset tree for API routes.

- [ ] **Step 5: Run focused tests and build**

Run:

```powershell
bun test tests/webAssets.test.ts tests/webServer.test.ts
bun run build:web
bun run typecheck
```

Expected: tests PASS, `dist/web/index.html` exists, and typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add package.json bun.lock tsconfig.json scripts/build-web.ts web/client/index.html web/client/main.tsx web/client/styles.css web/client/testSetup.ts hub/webAssets.ts hub/webServer.ts tests/webAssets.test.ts tests/webServer.test.ts
git commit -m "feat(web): add bundled React workspace shell"
```

---

### Task 2: Workspace session API and primary-agent updates

**Files:**
- Modify: `hub/types.ts`
- Modify: `hub/config.ts`
- Modify: `hub/conversations/types.ts`
- Modify: `hub/conversations/repository.ts`
- Modify: `hub/conversations/sqliteRepository.ts`
- Modify: `hub/conversations/service.ts`
- Modify: `hub/webServer.ts`
- Modify: `hub/index.ts`
- Modify: `config/hub.config.json`
- Test: `tests/config.test.ts`
- Test: `tests/conversationRepository.test.ts`
- Test: `tests/conversationService.test.ts`
- Test: `tests/conversationWeb.test.ts`

**Interfaces:**
- Produces config: `HubConfig.webIdentityHeader?: string`, default `X-Switchboard-User`.
- Produces repository: `updateConversation(id, changes, now): Conversation`.
- Produces service: `update(identity, conversationId, { title?, primaryAgent? }): Conversation`, owner-only.
- Produces API: `GET /api/session -> { identity, agents: { name, alive, busy }[] }`.
- Produces API: `PATCH /api/conversations/:id` with `{ title?, primaryAgent? }`.

- [ ] **Step 1: Write failing repository/service/API tests**

Cover the exact cases:

```ts
test("owner changes the primary agent without replacing history", () => {
  const c = service.create("owner@example.com", { title: "Build", primaryAgent: "architect" })
  const before = service.appendUserMessage("owner@example.com", c.id, { content: "hello", clientKey: "k1" })
  const updated = service.update("owner@example.com", c.id, { primaryAgent: "qa" })
  expect(updated).toMatchObject({ id: c.id, primaryAgent: "qa" })
  expect(repo.listMessages(c.id).map(m => m.id)).toEqual([before.message.id])
})

test("viewer and member cannot change conversation ownership settings", () => {
  expect(() => service.update("member@example.com", conversation.id, { primaryAgent: "qa" })).toThrow(ConversationForbiddenError)
})

test("workspace session uses the configured trusted header", async () => {
  const response = await handleWebRequest(new Request("http://x/api/session", { headers: { "x-auth-user": "ada@example.com" } }), deps({
    requireUser: req => req.headers.get("x-auth-user"),
  }))
  expect(await response.json()).toMatchObject({ identity: "ada@example.com" })
})
```

Also assert blank header names, titles, and primary agents are rejected; `PATCH` is guarded; and a missing workspace identity returns `400 missing_identity`.

Run: `bun test tests/config.test.ts tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts`

Expected: FAIL because the config field, update methods, and routes do not exist.

- [ ] **Step 2: Add the trusted-header configuration**

Add to `HubConfig`:

```ts
webIdentityHeader?: string // trusted reverse-proxy identity header; default X-Switchboard-User
```

Normalize and validate during config load:

```ts
hub.webIdentityHeader = hub.webIdentityHeader?.trim() || "X-Switchboard-User"
if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(hub.webIdentityHeader)) {
  throw new Error("config: webIdentityHeader must be a valid HTTP header name")
}
```

Add `"webIdentityHeader": "X-Switchboard-User"` to the example config and wire:

```ts
requireUser: req => req.headers.get(hub.webIdentityHeader ?? "X-Switchboard-User"),
```

- [ ] **Step 3: Implement owner-only conversation updates**

Add exact types:

```ts
export interface ConversationUpdate { title?: string; primaryAgent?: string }
```

Repository behavior must update only supplied fields, set `updated_at`, throw `RepositoryNotFoundError` for an unknown conversation, and return the updated row. Service behavior trims strings, rejects an empty patch and blank values, and calls `requireRole(identity, conversationId, ["owner"])` before persistence.

- [ ] **Step 4: Add session and PATCH routes**

Extend `WebDeps`:

```ts
updateConversation?: (identity: string, conversationId: string, input: ConversationUpdate) => Conversation
```

`GET /api/session` returns only the identity and status-safe agent fields:

```ts
return json({
  identity: email,
  agents: deps.collect().status.agents.map(({ name, alive, busy }) => ({ name, alive, busy })),
})
```

`PATCH /api/conversations/:id` accepts at least one of `title` or `primaryAgent`, rejects all other value types with `400`, and uses the same error mapping as existing conversation routes.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
bun test tests/config.test.ts tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add hub/types.ts hub/config.ts hub/conversations/types.ts hub/conversations/repository.ts hub/conversations/sqliteRepository.ts hub/conversations/service.ts hub/webServer.ts hub/index.ts config/hub.config.json tests/config.test.ts tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts
git commit -m "feat(web): add workspace session and agent selection APIs"
```

---

### Task 3: Typed client API, reconnect state, and durable local drafts

**Files:**
- Create: `web/client/types.ts`
- Create: `web/client/api.ts`
- Create: `web/client/drafts.ts`
- Create: `web/client/conversationStream.ts`
- Create: `web/client/state.ts`
- Test: `web/client/api.test.ts`
- Test: `web/client/drafts.test.ts`
- Test: `web/client/conversationStream.test.ts`
- Modify: `hub/conversations/events.ts`
- Test: `tests/conversationEvents.test.ts`

**Interfaces:**
- Produces: `WorkspaceApi` methods `session`, `listConversations`, `createConversation`, `updateConversation`, `archiveConversation`, `listMessages`, `postMessage`, and `listLinks`.
- Produces: `DraftStore` keyed by `switchboard:draft:<conversationId>`.
- Produces: `ConversationStream` with `start`, `stop`, gap recovery, and connection states `connecting | live | reconnecting | offline`.
- Produces: pure `workspaceReducer(state, action)` with message ID dedupe and sequence sorting.

- [ ] **Step 1: Write failing API and reducer tests**

Use injected `fetch` and `EventSource` factories. Cover:

```ts
test("postMessage reuses the supplied idempotency key", async () => {
  const calls: Request[] = []
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json(message, { status: 201 })
  })
  await api.postMessage("c1", { content: "hello", clientKey: "draft-1" })
  expect(calls[0].headers.get("idempotency-key")).toBe("draft-1")
})

test("reconnect fetches the durable gap before opening SSE", async () => {
  const order: string[] = []
  const stream = new ConversationStream({
    fetchGap: async after => (order.push(`gap:${after}`), [messageAt(4)]),
    open: (_url, _handlers) => (order.push("sse"), fakeSource),
    online: () => true,
  })
  await stream.start("c1", 3, handlers)
  expect(order).toEqual(["gap:3", "sse"])
})
```

Reducer tests must prove duplicate SSE/history messages render once, out-of-order events sort by `sequence`, and selecting a conversation clears stale activity from the previous conversation.

Run: `bun test web/client/api.test.ts web/client/drafts.test.ts web/client/conversationStream.test.ts tests/conversationEvents.test.ts`

Expected: FAIL because the client modules do not exist and turn-state events at the current message sequence are filtered.

- [ ] **Step 2: Implement the typed API and error boundary**

`WorkspaceApi` must throw:

```ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}
```

All paths use `encodeURIComponent(conversationId)`. All JSON requests set `content-type: application/json`; only message POST sets `idempotency-key`. Treat non-2xx bodies as `{ error?: string }` and never expose raw HTML error pages to the UI.

- [ ] **Step 3: Implement draft semantics**

Persist this exact shape:

```ts
export interface Draft { text: string; clientKey: string; updatedAt: number }
```

`write(conversationId, text)` keeps the existing key while text is unchanged, generates `crypto.randomUUID()` when text changes from the last persisted value, and deletes the entry for empty text. `markSent(conversationId, clientKey)` clears only when the stored key matches the successful request, preventing a late response from deleting newer typing.

- [ ] **Step 4: Implement explicit reconnect and reducer behavior**

`ConversationStream.start()` performs one gap fetch, emits the gap, then opens `/api/conversations/<id>/events?after=<lastSequence>`. On error it closes the source, reports `offline` when `navigator.onLine === false`, otherwise reports `reconnecting` and retries with bounded delays `[1000, 2000, 5000, 10000]`. `stop()` clears the timer and closes the source.

The stream advances its cursor only for `message_committed` events with a message. Turn/activity events are emitted but do not change the durable cursor.

- [ ] **Step 5: Allow live activity at the current message sequence**

Adjust `ConversationEventStream` so duplicate/replayed `message_committed` events remain suppressed by the message high-water mark, while live `turn_state` and `activity` events with the current message sequence are delivered. Reconnect replay remains message-only. Add a regression that publishes `message_committed`, `queued`, `working`, and `failed` at one sequence and observes all four live, while a replay subscriber receives the canonical message once.

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
bun test web/client/api.test.ts web/client/drafts.test.ts web/client/conversationStream.test.ts tests/conversationEvents.test.ts
bun run typecheck
git add web/client/types.ts web/client/api.ts web/client/drafts.ts web/client/conversationStream.ts web/client/state.ts web/client/*.test.ts hub/conversations/events.ts tests/conversationEvents.test.ts
git commit -m "feat(web): add typed conversation client state"
```

---

### Task 4: Expandable responsive workspace shell

**Files:**
- Modify: `web/client/main.tsx`
- Create: `web/client/App.tsx`
- Create: `web/client/components/AppRail.tsx`
- Create: `web/client/components/ConversationList.tsx`
- Create: `web/client/components/MobileNav.tsx`
- Create: `web/client/components/Inspector.tsx`
- Create: `web/client/components/ConnectionBanner.tsx`
- Modify: `web/client/styles.css`
- Test: `web/client/App.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceApi`, `DraftStore`, `ConversationStream`, and `workspaceReducer` from Task 3.
- Produces: responsive shell regions named `application-navigation`, `conversation-navigation`, `transcript`, and `conversation-inspector`.
- Produces URL state: `/conversations/<encoded-id>` and `/` without React Router.

- [ ] **Step 1: Write failing component tests**

Register Happy DOM at the top of the file and use Testing Library. Prove:

```tsx
test("loads session and conversations, then opens the selected transcript", async () => {
  render(<App api={fakeApi({ conversations: [conversation] })} />)
  expect(await screen.findByRole("heading", { name: "Switchboard" })).toBeVisible()
  await userEvent.click(await screen.findByRole("button", { name: /Design review/ }))
  expect(await screen.findByRole("region", { name: "Transcript" })).toBeVisible()
})

test("keyboard navigation reaches rail, list, transcript and composer in order", async () => {
  render(<App api={fakeApi()} />)
  await userEvent.tab()
  expect(screen.getByRole("button", { name: "New conversation" })).toHaveFocus()
})
```

Also test empty, loading, forbidden, and API-unavailable states with actionable copy rather than blank panes.

Run: `bun test web/client/App.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 2: Implement the application rail and navigation model**

Use a data-driven rail:

```ts
const destinations = [
  { id: "conversations", label: "Conversations", available: true },
  { id: "legacy", label: "Legacy console", available: true, href: "/legacy" },
] as const
```

Do not render dead Phase 4 buttons. The rail includes the Switchboard mark, New Conversation, Conversations, Legacy Console, connectivity status, and an install button only when install is available.

- [ ] **Step 3: Implement conversation list and workspace routing**

The list provides local title search, New Conversation dialog with title + primary-agent selection, archive confirmation, active state, last-updated time, and an explicit empty state. Use `history.pushState` and a `popstate` listener; do not add a router dependency.

- [ ] **Step 4: Implement the visual system and responsive states**

Use these tokens as the stable design contract:

```css
:root {
  color-scheme: dark;
  --ink-0: #0b0f17;
  --ink-1: #121722;
  --ink-2: #1a2230;
  --line: #2a3547;
  --text: #edf3f8;
  --muted: #93a4b7;
  --accent: #64d8cb;
  --accent-warm: #f2b66d;
  --danger: #ff7d86;
  --rail-width: 72px;
  --list-width: 320px;
  --inspector-width: 320px;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}
```

The aesthetic is a quiet technical studio: deep ink surfaces, hairline separators, restrained teal state accents, warm activity accents, no gradients, no glassmorphism, and no excessive pill shapes. Transcript width is capped at `780px`; controls remain at least `44px` on touch layouts.

Implement the exact layout changes in Global Constraints with CSS grid and media queries. Mobile safe-area padding uses `env(safe-area-inset-*)`. `prefers-reduced-motion: reduce` disables drawer and message transitions.

- [ ] **Step 5: Run focused tests, build, and commit**

```powershell
bun test web/client/App.test.tsx
bun run build:web
bun run typecheck
git add web/client
git commit -m "feat(web): build responsive workspace shell"
```

---

### Task 5: Transcript, composer, activity, and conversation inspector

**Files:**
- Create: `web/client/components/Transcript.tsx`
- Create: `web/client/components/MessageItem.tsx`
- Create: `web/client/components/Composer.tsx`
- Create: `web/client/components/ActivityItem.tsx`
- Modify: `web/client/components/Inspector.tsx`
- Modify: `web/client/App.tsx`
- Modify: `web/client/styles.css`
- Test: `web/client/ConversationView.test.tsx`

**Interfaces:**
- Consumes: Task 2 PATCH API and Task 3 stream/draft/reducer.
- Produces: canonical transcript rendering, reply targeting, send/retry, live activity disclosure, linked-surface summary, and primary-agent selector.

- [ ] **Step 1: Write failing conversation-view tests**

Cover:

```tsx
test("keeps failed text and idempotency key, then clears only after success", async () => {
  const api = rejectingThenResolvingApi()
  render(<ConversationView api={api} conversation={conversation} />)
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Ship it")
  await userEvent.click(screen.getByRole("button", { name: "Send message" }))
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Ship it")
  await userEvent.click(screen.getByRole("button", { name: "Retry send" }))
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("")
  expect(api.keys[0]).toBe(api.keys[1])
})
```

Also prove: user/agent/transport/system messages have distinct accessible labels; reply preview resolves the parent; activity items are collapsed by default; primary-agent updates refresh the header; inspector lists sync mode and health-safe link metadata; reconnect does not duplicate transcript rows.

Run: `bun test web/client/ConversationView.test.tsx`

Expected: FAIL.

- [ ] **Step 2: Implement transcript and message semantics**

Render only canonical `Message` objects. Group adjacent messages by author only when they are within five minutes and neither is a reply. Use `<article aria-label="Message from …">`; show origin and state without exposing internal IDs. Reply actions store a `replyTo` message ID and display a dismissible preview.

- [ ] **Step 3: Implement autosizing composer and send lifecycle**

`Enter` sends, `Shift+Enter` inserts a newline, IME composition never sends, blank text is disabled, and the composer autosizes to six lines. On submit:

1. Persist the draft and key.
2. Show a local `sending` status without inserting a transcript message.
3. POST with the same key for every retry.
4. On 2xx, dispatch the canonical response, clear only the matching draft, and reset reply state.
5. On failure/offline, keep the text and show Retry with the error announced through `aria-live`.

- [ ] **Step 4: Implement activity and inspector behavior**

Map `queued`, `working`, `streaming`, `completed`, and `failed` to an activity disclosure. Announce state changes politely; do not repeatedly announce streaming chunks. The inspector shows primary-agent selector, linked surfaces, sync mode, enabled state, and created/updated timestamps. Desktop inspector is collapsible; tablet/mobile use a focus-trapped drawer that returns focus to its trigger on close.

- [ ] **Step 5: Run focused tests and commit**

```powershell
bun test web/client/ConversationView.test.tsx web/client/App.test.tsx
bun run typecheck
git add web/client
git commit -m "feat(web): add canonical conversation experience"
```

---

### Task 6: Installable PWA, safe shell caching, and offline UX

**Files:**
- Create: `web/client/public/manifest.webmanifest`
- Create: `web/client/public/icon.svg`
- Create: `web/client/public/sw.template.js`
- Create: `scripts/generate-pwa-icons.ts`
- Modify: `scripts/build-web.ts`
- Create: `web/client/pwa.ts`
- Create: `web/client/components/InstallButton.tsx`
- Modify: `web/client/main.tsx`
- Modify: `web/client/App.tsx`
- Test: `tests/webBuild.test.ts`
- Test: `web/client/pwa.test.ts`

**Interfaces:**
- Produces: `/manifest.webmanifest`, `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/maskable-512.png`, and `/sw.js`.
- Produces: `registerPwa(): PwaController` with install availability and online/offline subscriptions.
- Guarantees: generated service worker rejects `/api/` and event-stream requests from cache handling.

- [ ] **Step 1: Write failing build and PWA tests**

Assert the built manifest contains `name`, `short_name`, `id`, `start_url`, `scope`, `display: "standalone"`, `theme_color`, `background_color`, and 192/512/maskable PNG icons. Assert the service worker contains an explicit API bypass and a versioned shell asset list derived from actual build outputs.

```ts
expect(manifest.icons).toEqual(expect.arrayContaining([
  expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192" }),
  expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512" }),
  expect.objectContaining({ purpose: "maskable" }),
]))
expect(serviceWorker).toContain("url.pathname.startsWith('/api/')")
```

Run: `bun test tests/webBuild.test.ts web/client/pwa.test.ts`

Expected: FAIL because PWA output does not exist.

- [ ] **Step 2: Create deterministic icons and manifest**

Create one source SVG with a safe maskable inset and a simple Switchboard `S`/routing-node mark using only vector paths. `scripts/generate-pwa-icons.ts` uses Sharp to emit exact 192×192 and 512×512 PNGs plus a 512×512 maskable PNG. Do not fetch remote assets.

The manifest uses:

```json
{
  "id": "/",
  "name": "Switchboard Workspace",
  "short_name": "Switchboard",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0b0f17",
  "theme_color": "#121722",
  "prefer_related_applications": false,
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 3: Build a versioned shell-only service worker**

Extend `build-web.ts` to copy public files, generate icons, collect emitted HTML/JS/CSS/icon/manifest paths, and replace `__SWITCHBOARD_SHELL_ASSETS__` and `__SWITCHBOARD_CACHE_VERSION__` in the template.

The fetch handler starts with:

```js
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api/") || event.request.headers.get("accept")?.includes("text/event-stream")) return
  event.respondWith(caches.match(event.request).then(hit => hit ?? fetch(event.request)))
})
```

Install uses `cache.addAll(SHELL_ASSETS)`; activate deletes every prior `switchboard-shell-*` cache and calls `clients.claim()`.

- [ ] **Step 4: Implement install and offline UI**

Register `/sw.js` only on secure contexts or localhost. Capture `beforeinstallprompt`, expose Install only while available, and clear it after `appinstalled`. Online/offline events drive the connection banner; offline copy says `Offline — drafts stay on this device. Messages are not submitted.`

- [ ] **Step 5: Run focused tests, build, and commit**

```powershell
bun test tests/webBuild.test.ts web/client/pwa.test.ts
bun run build:web
bun run typecheck
git add web/client/public web/client/pwa.ts web/client/components/InstallButton.tsx web/client/main.tsx web/client/App.tsx scripts/build-web.ts scripts/generate-pwa-icons.ts tests/webBuild.test.ts web/client/pwa.test.ts
git commit -m "feat(web): make workspace installable and offline-aware"
```

---

### Task 7: Responsive, accessibility, reconnect, and installability end-to-end gate

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/fixtures/workspaceE2eServer.ts`
- Create: `tests/e2e/workspace.spec.ts`
- Create: `tests/e2e/pwa.spec.ts`
- Modify: `README.md`
- Modify: `docs/config-reference.md`
- Modify: `docs/architecture/conversations.md`
- Modify: `docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md`

**Interfaces:**
- Produces: deterministic fixture server at `127.0.0.1:4173` with Discord disabled and in-memory canonical data.
- Produces: Playwright projects `desktop`, `tablet`, and `mobile`.
- Verifies: PWA metadata/icons/service worker, responsive layout, keyboard/focus, Axe, drafts, message idempotency, reconnect gap recovery, legacy dashboard reachability, and trusted-header behavior.

- [ ] **Step 1: Create the E2E fixture and failing responsive tests**

Configure projects exactly:

```ts
projects: [
  { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
  { name: "tablet", use: { viewport: { width: 900, height: 1100 } } },
  { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
]
```

The fixture server uses the real `handleWebRequest`, `ConversationService`, `ConversationEventStream`, and in-memory SQLite repository. It injects `owner@example.com` as the trusted proxy identity and exposes a test-only function/event endpoint only when `NODE_ENV === "test"` to simulate a dropped SSE connection and a committed gap message. Bind only to `127.0.0.1` and reject the fixture route when the environment guard is absent.

Initial E2E assertions:

```ts
test("mobile uses one pane and preserves the draft across reload", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: /Design review/ }).click()
  await page.getByRole("textbox", { name: "Message" }).fill("unsent")
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("unsent")
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible()
})
```

Run: `bun run test:e2e -- --project=mobile`

Expected: FAIL until all fixture wiring and layout selectors are correct.

- [ ] **Step 2: Complete desktop/tablet/mobile coverage**

Desktop asserts all four workspace columns and inspector collapse. Tablet asserts inspector drawer and focus return. Mobile asserts list/transcript single-pane navigation, bottom nav, safe-area controls, and no horizontal overflow. Every project creates a conversation, sends a multi-turn web-only exchange, changes the primary agent, searches, archives, and opens `/legacy`.

- [ ] **Step 3: Add reconnect and idempotency coverage**

Simulate an SSE drop, commit a message during the gap, reconnect, and assert ordered exactly-once rendering. Intercept the first message POST response after the server commits it, force a client-visible network failure, click Retry, and assert one canonical message because the same idempotency key was reused.

- [ ] **Step 4: Add accessibility and PWA verification**

Run `AxeBuilder` on list and transcript views with zero serious/critical violations. Keyboard-only coverage opens/closes the inspector and new-conversation dialog, verifies focus trapping/return, and sends with Enter while Shift+Enter inserts a newline. Assert manifest fields, icon response dimensions/content types, active service-worker registration, cached shell reload while offline, and failed `/api/conversations` while offline.

- [ ] **Step 5: Update operator and architecture documentation**

Document:

- `bun run build:web` and `bun run hub` behavior.
- `/` workspace versus `/legacy` operational compatibility UI.
- `webIdentityHeader`, its default, and the proxy strip-and-set requirement.
- PWA shell-only caching and explicit lack of offline submission.
- Phase 3 completion in the roadmap, while Phase 4 operations parity remains pending.
- The Phase 4 parity checklist explicitly retains canonical web attachments, consultations, delegations, handoff, approvals, agent management, operations, and settings; Phase 3 must not imply those are complete.
- The documented limitation that already-running uncancellable adapter sends can delay shutdown.

- [ ] **Step 6: Run the complete phase gate**

```powershell
bun run typecheck
bun test
bun run build:web
bun run test:e2e
git diff --check
```

Expected: typecheck succeeds; all unit/integration tests pass; desktop/tablet/mobile/PWA projects pass; build emits installable assets; diff check is clean.

- [ ] **Step 7: Commit**

```powershell
git add playwright.config.ts tests/fixtures/workspaceE2eServer.ts tests/e2e README.md docs/config-reference.md docs/architecture/conversations.md docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md
git commit -m "test(web): verify responsive installable workspace"
```

---

## Final Whole-Branch Verification

- [ ] Generate a review package from the Phase 3 merge base through `HEAD`.
- [ ] Request an independent whole-branch review against the approved design and this plan.
- [ ] Fix every Critical and Important finding in one consolidated pass and re-review.
- [ ] Re-run `bun run typecheck`, `bun test`, `bun run build:web`, `bun run test:e2e`, and `git diff --check` from a fresh shell.
- [ ] Use `superpowers:finishing-a-development-branch` to offer merge, PR, keep, or discard.
