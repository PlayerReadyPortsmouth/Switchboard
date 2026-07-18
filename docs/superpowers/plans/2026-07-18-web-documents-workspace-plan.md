---
title: "Web Documents Workspace — Implementation Plan"
date: 2026-07-18
source_spec: docs/superpowers/specs/2026-07-18-web-documents-workspace-design.md
status: draft
---

# Web Documents Workspace — Implementation Plan

## Overview & sequencing rationale

Three phases, ReadyApp first:

**Phase 0 — ReadyApp** ships first because every change it makes is backward-compatible with
existing artifacts: absent `visibility`/`ownerId` fields produce today's behaviour, an absent
`expiresAt` no longer errors (it becomes "never expires"), and the image-inline fix is purely
additive. None of these require a hub or web client to exist; they can deploy to `api` and
sit inert until Phase 1 flips on.

**Phase 1 — Switchboard hub** depends on Phase 0 being deployed so that hub-written `.sbmd`
files with `expiresAt: ""` are accepted by `loadArtifact`. Adds `hub/documents.ts`,
the `documents` SQLite table (new migration in the existing `bun:sqlite`/migrations pattern),
extends the cleanup sweep, extends the shim socket `publish` frame, and adds the four document
HTTP routes to `hub/webServer.ts`. Gated behind `hub.shareLinks.enabled` (which was already the
existing gate — never turned on in prod, so Phase 0+1 together are the first live activation).

**Phase 2 — Web client** depends on Phase 1 for the HTTP API endpoints and the new `attachment`
SSE event type it needs to render inline document cards. Gated behind a new `features.documents`
flag in the `Session` type and the `/api/session` response. Canary'd to Aurora first.

Dependency edges:
- Phase 1 → Phase 0 deployed (needs `loadArtifact` to accept empty `expiresAt`)
- Phase 2 → Phase 1 deployed (needs `/api/documents` routes + `attachment` SSE event)
- Phase 0 is independently safe to land and deploy at any time

---

## Phase 0 — ReadyApp (`api` target)

**Flag & rollback:** These changes are backward-compatible (absent `visibility`/`ownerId` behave
as today; absent `expiresAt` = never-expires is additive not breaking). A Phase 0 deploy needs no
feature flag of its own. Rollback: `revert <SHA>` of the Phase 0 commit; no data migration to
undo.

### Task 0.1 — `Sbmd` interface: add three optional fields

**File:** `apps/api/src/lib/shareArtifact.ts` (lines 6–16)

**Test first** (`apps/api/src/lib/shareArtifact.test.ts`):
Add a case in the existing `loadArtifact` `describe` block:
```ts
it("extra optional fields (ownerId, ownerName, visibility) do not break loadArtifact", () => {
  const base = fixture("abc123ABC456ghi789", validSbmd({
    ownerId: "oid-1", ownerName: "Alice", visibility: "private"
  } as any));
  expect(loadArtifact(base, "abc123ABC456ghi789", NOW)).toMatchObject({ ok: true });
});
```
Run: `pnpm --filter @tutoring/api exec vitest run src/lib/shareArtifact.test.ts`

**Change:** Extend the `Sbmd` interface to add:
```ts
ownerId?: string;
ownerName?: string;
visibility?: "private" | "org";
```
`expiresAt` stays `string` in the interface but its validation logic changes in Task 0.2.

### Task 0.2 — `loadArtifact`: treat absent/empty `expiresAt` as "never expires"

**File:** `apps/api/src/lib/shareArtifact.ts` (lines 47–49)

**Test first** — extend `shareArtifact.test.ts`:
```ts
it("absent expiresAt → never expires, not 422", () => {
  const base = fixture("abc123ABC456ghi789", validSbmd({ expiresAt: "" }));
  expect(loadArtifact(base, "abc123ABC456ghi789", NOW)).toMatchObject({ ok: true });
});
it("null expiresAt field → never expires, not 422", () => {
  const base = fixture("abc123ABC456ghi789", validSbmd({ expiresAt: null as any }));
  expect(loadArtifact(base, "abc123ABC456ghi789", NOW)).toMatchObject({ ok: true });
});
it("unparseable expiresAt still → 422", () => {
  // Regression: non-empty non-date string should still fail closed
  const base = fixture("abc123ABC456ghi789", validSbmd({ expiresAt: "not-a-date" }));
  expect(loadArtifact(base, "abc123ABC456ghi789", NOW)).toEqual({ ok: false, status: 422 });
});
```

**Change:** Replace lines 47–49 (the `exp` check block) with:
```ts
const { expiresAt } = sbmd;
if (expiresAt !== "" && expiresAt != null) {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, status: 422 };
  if (now.getTime() > exp) return { ok: false, status: 410 };
}
// absent / empty expiresAt = never expires; skip expiry check
```

Verify: `pnpm --filter @tutoring/api exec vitest run src/lib/shareArtifact.test.ts`

### Task 0.3 — `serveArtifact`: image inline fix

**File:** `apps/api/src/lib/shareArtifact.ts` (lines 101–118)

**Test first** — extend `serveArtifact` `describe` in `shareArtifact.test.ts`:
```ts
it("view PNG → inline image bytes, not download", () => {
  const s = serveArtifact(validSbmd({ mode: "view", contentType: "image/png", filename: "photo.png" }), bytes);
  expect(s.headers["Content-Disposition"]).toBe("inline");
  expect(s.headers["Content-Type"]).toBe("image/png");
  expect(s.body).toBe(bytes);
});
it("view JPEG → inline image bytes, not download", () => {
  const s = serveArtifact(validSbmd({ mode: "view", contentType: "image/jpeg", filename: "photo.jpg" }), bytes);
  expect(s.headers["Content-Disposition"]).toBe("inline");
});
```

**Change:** Insert after the PDF branch (line 107), before `const sandboxHtml`:
```ts
if (ct.startsWith("image/")) {
  return { status: 200, body: bytes, headers: { "Content-Type": ct, "Content-Disposition": "inline", ...NOSNIFF } };
}
```

Verify: `pnpm --filter @tutoring/api exec vitest run src/lib/shareArtifact.test.ts`

### Task 0.4 — `share.ts`: `visibility === "private"` ownership gate

**File:** `apps/api/src/routes/share.ts` (lines 19–24)

**Test first** — extend `share.test.ts`:
```ts
it("private artifact, correct owner → 200", async () => {
  const { base, token } = artifactWithVisibility("download", "staff", "private", "oid-1");
  const app = await build(base);
  const res = await app.inject({ method: "GET", url: `/share/${token}` });
  expect(res.statusCode).toBe(200);
});
it("private artifact, wrong owner → 403", async () => {
  const { base, token } = artifactWithVisibility("download", "staff", "private", "oid-OTHER");
  const app = await build(base);
  const res = await app.inject({ method: "GET", url: `/share/${token}` });
  expect(res.statusCode).toBe(403);
});
it("org-scoped artifact (visibility:org) → existing scope check unchanged", async () => {
  const { base, token } = artifactWithVisibility("download", "staff", "org", "oid-OTHER");
  const app = await build(base);
  const res = await app.inject({ method: "GET", url: `/share/${token}` });
  expect(res.statusCode).toBe(200); // passes existing staff scope gate
});
it("absent visibility field → existing scope check unchanged (backward compat)", async () => {
  const { base, token } = artifact("download", "staff"); // no visibility field
  const app = await build(base);
  const res = await app.inject({ method: "GET", url: `/share/${token}` });
  expect(res.statusCode).toBe(200);
});
```

Add a `artifactWithVisibility` helper to the test that writes a `meta.sbmd` with `visibility`
and `ownerId` set.

**Change:** After `loadArtifact` succeeds (line 17), insert before the `scope` permission check:
```ts
if (r.sbmd.visibility === "private") {
  if (!r.sbmd.ownerId || request.user!.entraOid !== r.sbmd.ownerId) {
    return reply.code(403).send({ error: "forbidden" });
  }
}
```
When `visibility` is `"org"` or absent, fall through to the existing `scope` check unchanged.

Verify: `pnpm --filter @tutoring/api typecheck && pnpm --filter @tutoring/api exec vitest run src/routes/share.test.ts`

**Phase 0 deploy commit:** `feat(api): sbmd optional fields, never-expires, image inline, private visibility gate [deploy: api]`

---

## Phase 1 — Switchboard hub (behind `hub.shareLinks.enabled`)

**Flag & rollback:** All new hub behaviour is gated under the existing `hub.shareLinks.enabled`
config key (line 1246 `hub/index.ts`: `const shareLinksOn = hub.shareLinks?.enabled === true`).
The key is currently absent from production config, so absent = off = byte-identical to before.
Rollback: `revert <SHA>`; alternatively set `shareLinks.enabled: false` in hub config and restart
(no SQL migration to undo — the `documents` table is created on first start when the feature is
on, and is harmless to leave if reverted).

### Task 1.1 — `hub/documents.ts`: new module, injectable-IO, dual-write

**New file:** `hub/documents.ts`

**Test first** (`hub/documents.test.ts`, colocated):
```ts
// inject a Database from bun:sqlite ":memory:", inject fake fs IO
test("publishDocument writes sbmd to fake fs and inserts SQLite row", ...)
test("listDocuments(mine) returns only rows matching requesterId", ...)
test("listDocuments(org) returns all visibility=org rows", ...)
test("Discord-owned rows (owner_id:'discord') appear in org list, not mine", ...)
test("setVisibility rejects when requesterId !== owner_id", ...)
test("deleteDocument rejects when requesterId !== owner_id", ...)
test("deleteDocument on discord-owned row → not_owner", ...)
test("uploadDocument inserts row + writes file bytes via injected IO", ...)
```

**Shape** (implement to the spec's interface):
- `DocumentsDb`: a thin wrapper over `bun:sqlite` `Database` instance
- `publishDocument`: calls existing `publishArtifact` (from `publishLink.ts`) for fs write,
  defaulting `ttlDays` to `null` (permanent); writes to SQLite after fs succeeds
- `uploadDocument`: validates size <= `opts.maxBytes`; atomic fs write (tmp-then-rename pattern
  from `publishArtifact`); inserts SQLite row
- `setVisibility`/`deleteDocument`: check `owner_id !== "discord"` AND `requesterId === row.owner_id`
- `listDocuments`: pure SQLite query — no fs reads

Verify: `bun test hub/documents.test.ts`

### Task 1.2 — SQLite `documents` table migration

**File:** `hub/conversations/migrations.ts` (existing migration runner pattern)

OR: Create `hub/documentsMigrations.ts` alongside `hub/documents.ts` (preferred — keeps
documents separate from the conversation schema, avoids growing the conversation migration chain).

**Test first:** The existing pattern in `tests/conversationMigrations.test.ts` is the model.
Add `hub/documentsMigrations.test.ts`:
```ts
test("runDocumentsMigrations creates documents table in a fresh :memory: DB", ...)
test("runDocumentsMigrations is idempotent — safe to run twice", ...)
```

**Schema** (verbatim from spec):
```sql
CREATE TABLE IF NOT EXISTS documents (
  token TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  conversation_id TEXT,
  size_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

The DB instance is opened in `hub/index.ts` at the same stateDir as the conversation DB
(or a separate `documents.sqlite` file in stateDir — choose one file to avoid a second
WAL lock). Recommended: reuse the existing `bun:sqlite` Database instance already opened for
conversations if available, otherwise open `<stateDir>/documents.sqlite`.

Verify: `bun test hub/documentsMigrations.test.ts`

### Task 1.3 — Extend `publishCleanup.ts` reconciliation sweep

**File:** `hub/publishCleanup.ts` and the sweep block in `hub/index.ts` (lines 1616–1635)

**Test first** (`hub/publishCleanup.test.ts` or inline in existing tests if short):
```ts
test("reconciliation: inserts SQLite row for a directory with no row", ...)
test("reconciliation: deletes SQLite row for a directory that no longer exists", ...)
test("reconciliation: overwrites SQLite row whose fields disagree with disk sbmd", ...)
test("reconciliation: Discord-originated sbmd (no ownerId) → owner_id:'discord'", ...)
test("permanent artifacts (expiresAt absent/empty) are NOT passed to selectExpired", ...)
```

**Change:** The existing sweep block in `hub/index.ts` walks `ARTIFACTS_DIR/*/meta.sbmd`.
Extend `selectExpired` to skip entries where `expiresAt` is absent/empty (permanent docs).
Add a reconciliation pass after the expiry-reap pass:
- For each directory present on disk: if no SQLite row → insert one from the sbmd
- For each SQLite row with no directory → delete the row
- For each row whose fields differ from disk sbmd → overwrite

Inject the `DocumentsDb` to `selectExpired`-extended + new reconcile function. Keep all
reconciliation logic pure and tested independently of the hub wiring.

Verify: `bun test hub/publishCleanup.test.ts`

### Task 1.4 — Extend `publish_link` tool: `visibility` param + permanent default

**Files:** `shim/server.ts` (lines 245–255, the `publish_link` tool definition + handler)
and `hub/transports/shimSocket.ts` (line 126, the `publish` dispatch)

**Test first** — extend `hub/transports/shimSocket.ts` tests or add `shim/server.test.ts`:
```ts
test("publish_link with omitted ttl_days sends ttlDays:undefined to hub (permanent)", ...)
test("publish_link with ttl_days:7 sends ttlDays:7 (ephemeral)", ...)
test("publish_link forwards visibility param to hub publish frame", ...)
```

**Changes:**
1. `shim/server.ts` tool schema: add `visibility: { type: "string", enum: ["private", "org"] }`
   to `publish_link` properties. Update description to note: omitting `ttl_days` makes the
   document permanent in the org's Documents library (was: default 30 days).
2. `shim/server.ts` handler (line 315): pass `visibility: args.visibility` in the encoded frame.
3. `hub/transports/shimSocket.ts` (line 126): forward `m.visibility` to `publishCb`.
4. `ShimSocketServer.publishCb` signature (line 34): add `visibility?: string` to the arg type.
5. `hub/index.ts` `onPublish` wiring (line 610): thread `visibility` through to `publishDocument`
   (the new `hub/documents.ts` function). When `ttlDays` is undefined/null and `shareLinks.enabled`,
   default to permanent (`null` ttl) instead of `defaultTtlDays`.

Verify: `bun test && bun run typecheck`

### Task 1.5 — `attachment` shim frame (web-only SSE event)

**Files:** `hub/index.ts` (the `onPublish` wiring block), `hub/webServer.ts` (ConversationEvent
SSE stream), `hub/conversations/events.ts` (event type union)

**Determining web vs Discord origin:** The agent's `chatId` at the time of the `publish` call
identifies the conversation. Web-originated conversations have a `conversationId` in the
conversation SQLite DB (created via `createConversation`). The hub already knows the `lastChatByAgent`
map (line 662 of `hub/index.ts`). Check whether the current `chatId` is a conversation UUID
(i.e., `conversationService.getConversation(identity, chatId)` succeeds or just check if `chatId`
is registered in the conversation service). Discord chat IDs are Snowflakes (numeric strings);
conversation IDs are UUIDs. This is the simplest discriminator: if the `chatId` matches a known
conversation ID, emit the `attachment` event onto that conversation's event stream.

**Test first** (`hub/index.ts` integration helpers or separate `hub/documents.test.ts`):
```ts
test("publish from a web conversation emits attachment event on that conversation's stream", ...)
test("publish from a Discord channel does NOT emit attachment event", ...)
```

**New ConversationEvent kind:** Add `"attachment"` to the `ConversationEvent` union in
`hub/conversations/events.ts`:
```ts
| { kind: "attachment"; conversationId: string; sequence: number; ts: number;
    token: string; title: string; contentType: string; mode: string; visibility: string }
```

**Change:** After a successful `publishDocument` call in `onPublish`, if the `chatId` is a
known conversation ID, publish an `attachment` ConversationEvent onto `conversationEvents.publish`.
The `sequence` for the attachment event is the next sequence from the conversation event stream
(or a dedicated counter — the simplest approach is to use `Date.now()` as sequence since
attachments don't participate in message replay ordering).

Verify: `bun test && bun run typecheck`

### Task 1.6 — Hub HTTP routes for documents

**File:** `hub/webServer.ts` (extend `handleWebRequest` and `WebDeps`)

**Test first** (`hub/webServer.test.ts`):
```ts
test("GET /api/documents?scope=mine → calls listDocuments, returns array", ...)
test("GET /api/documents?scope=org → calls listDocuments with org scope", ...)
test("GET /api/documents missing scope → 400", ...)
test("POST /api/documents (multipart) → calls uploadDocument, returns row", ...)
test("PATCH /api/documents/:token { visibility } → calls setVisibility", ...)
test("PATCH /api/documents/:token missing visibility → 400", ...)
test("DELETE /api/documents/:token → calls deleteDocument", ...)
test("setVisibility returns not_owner → 403", ...)
test("all document routes require identity header → 400 missing_identity", ...)
```

**Changes to `WebDeps`:** Add four optional injected functions:
```ts
listDocuments?: (requesterId: string, scope: "mine" | "org") => DocumentRow[]
uploadDocument?: (requesterId: string, requesterName: string, file: { filename: string; bytes: Buffer; title?: string; visibility?: "private"|"org" }) => Promise<PublishResult>
setDocumentVisibility?: (token: string, requesterId: string, visibility: "private"|"org") => Promise<{ ok: true } | { ok: false; reason: string }>
deleteDocument?: (token: string, requesterId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
```

**Route patterns** (add alongside the conversation routes in `handleWebRequest`):
- `const documentsMatch = path === "/api/documents"`
- `const documentItemMatch = /^\/api\/documents\/([^/]+)$/.exec(path)`
- Add these to `isGuardedRoute`

**Note on `POST /api/documents` (multipart upload):** Bun's `Request` supports `request.formData()`.
Parse the multipart body to extract `file` (the bytes), `title` (optional string), and
`visibility` (optional). The `x-switchboard-user` email is the `requesterId`/`requesterName`.

**Note on proxy limitation (Discrepancy D5):** The existing `switchboardProxy.ts` only registers
`GET` and `POST` handlers (lines 44–45). `PATCH` and `DELETE` are not proxied. See Discrepancies
section. The proxy must be extended for `PATCH` and `DELETE` before these routes work end-to-end.

Verify: `bun test && bun run typecheck`

### Task 1.7 — Wire everything in `hub/index.ts`

Open the `hub/documents.ts` DB and inject it into all the above. Specifically:
- Open/create the `documents` SQLite DB at startup (when `shareLinksOn`)
- Pass `DocumentsDb` instance to the `sweep` closure (reconciliation)
- Replace the `publishArtifact` call in `onPublish` with `publishDocument` from `hub/documents.ts`
- Inject `listDocuments`/`uploadDocument`/`setDocumentVisibility`/`deleteDocument` into `WebDeps`

**Test:** No new unit test needed here — the wiring is tested end-to-end in the smoke checklist.
Run `bun test && bun run typecheck` for the full suite.

**Phase 1 commit:** `feat(hub): documents module, SQLite mirror, extended publish_link, attachment event, /api/documents routes [behind hub.shareLinks.enabled]`

---

## Phase 2 — Web client (behind `features.documents`, canary to Aurora)

**Flag & rollback:** New `features.documents: boolean` in the `Session` type and the
`/api/session` response (hub `webServer.ts` line 172–179). When `false` (default), the
`AppRail` entry is hidden, `DocumentsWorkspace` is unreachable, and the `attachment` SSE
events are ignored. Rollback: set flag to false via hub config or revert the web client commit.

**Note on ReadyApp feature-flag pattern:** The `features.*` flags for the web client
live in the switchboard hub's `/api/session` response, not in the ReadyApp `AppSetting` table.
The switchboard's `hub.shareLinks.enabled` gates the whole document feature server-side; the
`features.documents` flag in `/api/session` gates the UI. Both must be on for the full
experience. The hub config key for the UI flag could be `hub.shareLinks.documentsUI` (a boolean
field on the existing `ShareLinksConfig` type) or a separate `hub.documents.enabled` key.

### Task 2.1 — `Session` type + `/api/session` response

**Files:** `web/client/types.ts` (line 10), `hub/webServer.ts` (line 176)

**Test first** (`hub/webServer.test.ts`):
```ts
test("GET /api/session includes features.documents = false when hub.shareLinks.documentsUI absent", ...)
test("GET /api/session includes features.documents = true when enabled", ...)
```

**Change:** `Session.features` gains `documents: boolean`. The hub reads
`hub.shareLinks?.documentsUI === true` to decide the value.

Verify: `bun test && bun run typecheck`

### Task 2.2 — `routes.ts` + `base.ts`: `pathForDocument`

**File:** `web/client/routes.ts`

**Test first** (`web/client/routes.test.ts` if it exists, or inline `routes.test.ts`):
```ts
test("pathForDocument returns /documents/:token", ...)
test("pathForDocument with a non-root base prefixes correctly", ...)
test("parseWorkspaceRoute parses /documents/:token → { destination: 'documents', token }", ...)
```

**Change:**
- Add `{ destination: "documents"; token: string | null }` to `WorkspaceRoute`
- Add route parsing: `/documents` → `{ destination: "documents", token: null }`;
  `/documents/:token` → `{ destination: "documents", token }`
- Add `pathForDocument(token: string | null, base = "/"): string`

Verify: `bun test web/client/routes.test.ts`

### Task 2.3 — `api.ts`: typed document methods

**File:** `web/client/api.ts`

**Test first** (`web/client/api.test.ts`):
```ts
test("listDocuments calls GET /api/documents?scope=mine", ...)
test("uploadDocument posts FormData to POST /api/documents", ...)
test("setVisibility patches PATCH /api/documents/:token", ...)
test("deleteDocument calls DELETE /api/documents/:token", ...)
```

Note: `uploadDocument` must use `fetch` directly (not the JSON wrapper in `request()`) since it
sends `multipart/form-data`. Add a separate `requestMultipart` or `requestFormData` helper.
`setVisibility` and `deleteDocument` need PATCH and DELETE methods — the current `request()`
helper accepts any `method` string, so those work as-is.

Verify: `bun test web/client/api.test.ts`

### Task 2.4 — `conversationStream.ts`: handle `attachment` event

**File:** `web/client/conversationStream.ts`

**Test first** — extend `web/client/conversationStream.test.ts`:
```ts
test("attachment SSE event is surfaced via onEvent", ...)
test("duplicate attachment event (same token) is idempotent in the state reducer", ...)
```

**Change:** The `ConversationEvent` type in `web/client/types.ts` gains the `"attachment"` kind.
`conversationStream.ts` passes it through to `handlers.onEvent` already (line 124 dispatches
all events via `onEvent`). The key change is in the app state: extend `ConversationEvent` in
`types.ts` and ensure the state reducer in `App.tsx` or `state.ts` handles `kind === "attachment"`
by adding a `DocumentAttachment` to the conversation's attachment list (keyed by `token`,
idempotent on duplicate events).

Verify: `bun test web/client/conversationStream.test.ts`

### Task 2.5 — `DocumentCard.tsx` (new component)

**File:** `web/client/components/DocumentCard.tsx`

**Test first** (`web/client/components/DocumentCard.test.tsx`):
```ts
test("image content-type → renders <img> thumbnail pointed at /share/:token URL", ...)
test("PDF content-type → icon + title + size, not an img", ...)
test("mode:download → anchor has download attribute", ...)
test("mode:view → anchor opens /share/:token in new tab (no download attr)", ...)
test("owner-only actions (toggle, delete) visible when viewerIsOwner=true", ...)
test("owner-only actions hidden when viewerIsOwner=false", ...)
```

**Shape:** Props: `{ token, title, contentType, mode, visibility, ownerName, sizeBytes, viewerIsOwner, raBase, onVisibilityToggle?, onDelete? }`.
Two layouts controlled by a `variant` prop: `"inline"` (inside transcript) and `"row"` (list).
Image thumbnail check: `contentType.startsWith("image/")`.

Verify: `bun test web/client/components/DocumentCard.test.tsx`

### Task 2.6 — `DocumentsWorkspace.tsx` (new component)

**File:** `web/client/components/DocumentsWorkspace.tsx`

**Test first** (`web/client/components/DocumentsWorkspace.test.tsx`):
```ts
test("renders Mine and Org-wide tabs", ...)
test("Mine tab shows only viewer's own documents", ...)
test("Org-wide tab shows all org-visible documents", ...)
test("upload input triggers uploadDocument and refreshes list", ...)
test("visibility toggle calls setVisibility and refreshes list", ...)
test("delete calls deleteDocument and removes row from list", ...)
test("toggle and delete hidden for non-owned rows in Org-wide tab", ...)
```

**Shape:** Uses `api.listDocuments`, `api.uploadDocument`, `api.setVisibility`, `api.deleteDocument`.
File input accepts all types (no extension restriction — the hub's size cap is the gate).
Drag-and-drop zone calls `uploadDocument` on `drop`.

Verify: `bun test web/client/components/DocumentsWorkspace.test.tsx`

### Task 2.7 — `AppRail.tsx` + `DestinationMobileNav.tsx`: new destination

**Files:** `web/client/components/AppRail.tsx`, `web/client/components/DestinationMobileNav.tsx`

**Test first** — extend `App.test.tsx` or `AppRail` snapshot:
```ts
test("documents destination appears in AppRail when features.documents = true", ...)
test("documents destination hidden when features.documents = false", ...)
```

**Change:** `AppRail` `destinations` array gains:
```ts
{ id: "documents" as const, label: "Documents", glyph: "▤",
  href: pathForDocument(null, webBase), available: features.documents }
```
`AppRailProps` gains `features: { agents: boolean; documents: boolean }`.
`DestinationMobileNav` gains the same conditional button.

Verify: `bun test && bun run typecheck`

### Task 2.8 — `App.tsx`: wire `DocumentsWorkspace` route

**File:** `web/client/App.tsx`

Add route handling for `destination === "documents"` parallel to the existing `"agents"` block
(lines 572–591). When `session.features.documents` is false, return `<NotFound />`. Otherwise
render `<DocumentsWorkspace>` with the `api` instance and the current `session.identity`.

Wire `attachment` events from `ConversationStream` into the workspace state: when an `attachment`
event arrives for the active conversation, append a `DocumentAttachment` to the message list
(rendered by `MessageItem`/`Transcript` via `DocumentCard` in `"inline"` variant).

Verify: `bun test && bun run typecheck`

**Phase 2 commit:** `feat(web): DocumentsWorkspace, DocumentCard, AppRail documents entry, attachment SSE [behind features.documents]`

---

## Cross-cutting

### SQLite dependency

The hub already uses `bun:sqlite` via `import type { Database } from "bun:sqlite"` and the
`SqliteConversationRepository` (`hub/conversations/sqliteRepository.ts`). The conversation
migrations pattern (`hub/conversations/migrations.ts`) uses `db.exec()` / `db.query()` /
`db.transaction()`. The `documents` table should follow this exact pattern.
**Do not add a new npm dependency.** `bun:sqlite` is already the runtime — verified at
`hub/conversations/migrations.ts:1` and `hub/conversations/sqliteRepository.ts:1`.

Preferred: open a separate `documents.sqlite` file in `stateDir` to keep the `documents` schema
isolated from the conversation schema (avoids entangling two independent migration chains).
Alternative: share the conversation DB (saves one file descriptor, but couples schema evolution).
Decision: separate file — isolation wins.

### Config keys touched

| Repo | Key | Default | Effect |
|---|---|---|---|
| switchboard | `hub.shareLinks.enabled` | absent (off) | Gates ALL of Phase 1 (publishLink + documents + HTTP routes + sweep) |
| switchboard | `hub.shareLinks.documentsUI` | absent (off) | Gates `features.documents` in `/api/session` (web UI) |
| switchboard | `hub.shareLinks.defaultTtlDays` | 30 | Still used for explicit `ttl_days` callers; omitted `ttl_days` now permanent |
| readyapp | none (no new AppSetting) | n/a | Phase 0 changes are unconditional backward-compat fixes |

### Proxy extension required (Phase 1 prerequisite for Phase 2)

`apps/api/src/routes/switchboardProxy.ts` only registers GET and POST (lines 44–45). The
documents API needs PATCH and DELETE. This is a ReadyApp change in Phase 1's window (can deploy
with the Phase 0+1 ReadyApp commit). Tests: extend `switchboardProxy.test.ts` if it exists, or
add cases for PATCH/DELETE passthrough with the identity header.

### Multipart proxy

`POST /api/documents` sends `multipart/form-data`. The current proxy hardcodes
`"content-type": "application/json"` on POST (line 31) and `body: JSON.stringify(request.body)`
(line 33). This must be changed for the document upload path: detect multipart content-type and
stream the raw body instead of JSON-stringifying. This is also a ReadyApp change.

### Smoke-test checklist (from spec §Rollout)

1. Agent publishes a doc from a web conversation → inline `attachment` card appears in transcript
2. Doc appears in "Mine" tab of Documents workspace
3. Toggle to "org-wide" → confirmed visible to a second staff account
4. Upload a PNG directly via the UI drag-and-drop → in-browser thumbnail (not forced download)
5. Existing Discord-originated share link still works unchanged (check a pre-existing link)
6. Permanent doc (no `ttl_days`) survives the next sweep tick (no `expiresAt` in sbmd)

---

## Discrepancies & risks

**D1 — `shimSocket.ts` has NO web-vs-Discord detection at the transport level (line 34, 126).**
Spec §3 says the `attachment` frame is emitted "when the originating transport is a web
conversation… checked the same way other web-only behaviour is gated." There is no such existing
check in `shimSocket.ts` — the `ShimSocketServer` receives frames with no transport-origin tag.
The hub's `onPublish` closure (hub/index.ts:610) knows the agent `name` and the current
`lastChatByAgent` value. Web vs Discord must be inferred from whether that chatId is a known
conversation UUID. This works but is indirect. Risk: if a Discord channel ID happens to collide
with a UUID format, the attachment event would be misemitted. In practice Discord Snowflakes are
all-numeric, so the check `conversationService.get(chatId)` succeeds/throws is reliable.
**Resolution in the plan:** Task 1.5 uses `conversationService.getConversation` as the
discriminator. Add a test case for a numeric Discord chatId to confirm no false positive.

**D2 — `publishLink.ts` `Sbmd` type (line 6–8) is a separate copy from `shareArtifact.ts`
`Sbmd` (line 6–16).** Both must gain the three optional fields or the `.sbmd` files written by
the hub will have typed but not declared fields. The hub's `Sbmd` in `publishLink.ts` needs the
same `ownerId?`, `ownerName?`, `visibility?` additions. The spec only mentions extending the
ReadyApp `Sbmd` interface, but the producer copy must match.
**Resolution:** Task 1.1 in hub also extends `hub/publishLink.ts:Sbmd`. This is a small addition
to Phase 1 scope, not separately noted in the spec.

**D3 — `switchboardProxy.ts` only handles GET + POST (lines 44–45).** The spec assumes PATCH
and DELETE routes work end-to-end. They do not until the proxy is extended. Additionally the
proxy hardcodes `"content-type": "application/json"` and JSON-stringifies the body (line 31–33),
which breaks multipart uploads (`POST /api/documents`). Both are ReadyApp changes, and both must
land before Phase 2 works.
**Resolution:** Add these to the Phase 1 / ReadyApp task list. The proxy changes are a
prerequisite for Phase 2, not Phase 0.

**D4 — `share.ts` auth check uses `request.user!.email ?? request.user!.entraOid` in the proxy,
but `request.user!.entraOid` in `share.ts` itself.** The proxy injects `x-switchboard-user` as
`email ?? entraOid` (switchboardProxy.ts:30). The `share.ts` visibility check uses
`request.user!.entraOid` (the Entra OID). The `ownerId` field written by the hub comes from
whatever identity the hub received on the web conversation — which is the `x-switchboard-user`
header value (an email string, not an OID). This means the `ownerId` stored in `.sbmd` will be
an email, not an OID, while `request.user!.entraOid` is an OID. The ownership check would always
fail.
**Resolution:** The hub should store `ownerId` as the Entra OID (from a separate lookup or from
a new header), OR the `share.ts` visibility check should compare against the email, OR the hub
receives the OID directly. Simplest fix: the hub's `onPublish` stores whatever it receives as
`x-switchboard-user`, and `share.ts` compares against `request.user!.email` (not `entraOid`).
Check `request.user` shape in `share.ts` — `requireRole` populates it via Fastify auth, which
gives both `entraOid` and `email`. Use `email` for the ownership comparison since that's what
the proxy injects. This is a deliberate design decision that must be made before Task 0.4.

**D5 — No existing test for `share.ts` visibility clause (the test does not yet exist).**
`share.test.ts` (lines 1–83) has no test for `visibility === "private"`. Task 0.4 adds the
first tests for this clause. This is an addition, not a discrepancy, but noted because the
baseline test count will rise.

**D6 — `selectExpired` in `publishCleanup.ts` (line 12–14) will reap permanent artifacts.**
Currently `selectExpired` only adds a token to the reap list if `expiresAt` is present and past.
If `expiresAt` is absent, the `ageMs > graceMs` branch fires — so an artifact with no `expiresAt`
that is older than the grace period (1 hour) gets reaped as "corrupt." Permanent documents
(empty/absent `expiresAt`) must be excluded from the age-based reap path. The current code is
safe for now (permanent docs won't be more than 1 hour old at creation) but breaks on restart
after >1 hour. Task 1.3 must explicitly handle this.
**Resolution:** In the reconciliation extension (Task 1.3), when building the `entries` array for
`selectExpired`, omit entries with `expiresAt: "" | null | undefined` entirely (they are permanent
and never expired). Only pass entries with a populated `expiresAt` to `selectExpired`.

**D7 — `web/client/types.ts` `ConversationEvent` (line 159–167) has only three `kind` values.**
Adding `"attachment"` requires updating the union. The `conversationStream.ts` receive handler
already passes all events through `onEvent` without discriminating kind, so no logic change there,
but TypeScript will require the type union to be updated before `"attachment"` can be safely used
downstream.

**D8 — Pre-existing test baseline:** `bun test` has 1 known failure on Windows
(`tests/config.test.ts` "expandHome resolves a leading ~"). On Linux (prod) all pass. Any Phase 1
or Phase 2 PR must show Linux-green (or WSL-green if dev is on Windows). The plan does not
introduce new Windows-only failures.

**Risk: crash between fs-write and SQLite-write in `publishDocument`.**
Covered by the reconciliation sweep (Task 1.3): on the next sweep tick, any directory with no
SQLite row gets one inserted from disk. The spec explicitly calls this out; no additional
mitigation needed beyond implementing the reconciliation.

**Risk: multipart body size.** The hub's `maxBytes` cap (default 26 MB from `hub/index.ts:618`)
must also be enforced in `uploadDocument`. Bun's `request.formData()` buffers the entire body
in memory, so very large uploads will OOM before the size check. For v1 this is acceptable
(26 MB is small). Note it in the upload route's comment.
