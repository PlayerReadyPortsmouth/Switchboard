# Web Documents Workspace — persistent document library for the Switchboard web client

**Date:** 2026-07-18
**Status:** Approved (design), pending spec review → implementation plan

**Depends on:** the existing share-link contract (`ReadyApp/docs/superpowers/specs/2026-06-28-entra-share-links-contract-design.md`),
its RA renderer (`ReadyApp/docs/superpowers/specs/2026-06-28-entra-share-links-renderer-design.md`,
`apps/api/src/routes/share.ts` + `apps/api/src/lib/shareArtifact.ts`), and Switchboard's producer
(`docs/superpowers/specs/2026-06-28-publish-link-producer-design.md`, `hub/publishLink.ts`). This
spec **extends** all three rather than replacing them.

**Sub-project 1 of 5** in the Switchboard web-workspace expansion (order: Documents → Operations
centre → Advanced conversation view → Agent creation → Shared agent permissions). The other four
are out of scope here and will each get their own spec.

## Problem

Agents can already write a file to their outbox and call `publish_link` to get a
staff-gated, Entra-authenticated URL — but the mechanism is Discord-shaped: a
30-day TTL with a cleanup sweep, no listing/browsing, no ownership concept, and
the standalone web client (`web/client/`) has zero rendering for it at all (no
attachment/document component exists in `Transcript.tsx`/`MessageItem.tsx`
today). Meanwhile `serveArtifact` (`apps/api/src/lib/shareArtifact.ts`) has a
latent gap: PNG/JPEG in `"view"` mode fall through to `serveDownload` — images
don't actually preview in-browser despite `inferModeAndType` tagging them
`view`.

The web workspace needs: agents (and humans) to persist documents indefinitely,
browse them in a dedicated "Documents" section scoped to either the logged-in
user or the whole org, and see them rendered as rich cards inline in
conversations — with an in-browser preview for common types and a plain
download fallback otherwise.

## Goal

Extend the existing share-link pipeline (same `ARTIFACTS_DIR`, same `.sbmd`
contract, same RA renderer) to support permanent, ownable, visibility-scoped
documents; add a Switchboard-hub-side index for listing/searching; add a
"Documents" destination and inline document cards to the web client; allow
both agent-driven publishing and direct human upload.

Non-goals: object storage / multi-box replication (v1 stays single-VPS,
`ARTIFACTS_DIR` shared by both processes as today); per-document sharing to
individual named users (visibility is binary: private-to-owner or org-wide);
full-text search inside documents (title/filename search only, and only if
trivial — not a requirement of v1); editing a document's contents after
upload (replace-by-re-upload only, no in-place edit).

## Architecture

```
Agent (in a web conversation)                Human (Documents UI)
  publish_link(path, visibility?, ttl_days?)    upload via drag-and-drop
        |                                              |
        v                                              v
  shim/server.ts --REQUEST/RESPONSE-->  hub/transports/shimSocket.ts
        |                                              |
        +---------------------+  +---------------------+
                               v  v
                        hub/documents.ts (new)
                 wraps hub/publishLink.ts's fs write,
                 adds SQLite mirror row in the same call
                               |
              +----------------+-----------------+
              v                                   v
    <ARTIFACTS_DIR>/<token>/       hub SQLite `documents` table
      {file, meta.sbmd}             (token, filename, title, contentType,
      (source of truth)              mode, ownerId, ownerName, visibility,
                                      createdAt, expiresAt, conversationId)
              |                                   |
              v                                   v
  ReadyApp GET /share/:token          hub GET/POST/PATCH/DELETE /api/documents
  (Entra + staffRoles + visibility     (list/upload/toggle/delete — reached
   check, renders or downloads)         through the same Entra-authenticated
                                        proxy already in front of /switchboard/)
                                                   |
                                                   v
                                web/client: DocumentsWorkspace.tsx (list/upload)
                                            DocumentCard.tsx (list row AND
                                            inline transcript card, same component)

Reconciliation sweep (existing cleanup interval, hub/publishCleanup.ts, extended):
  reaps expired artifacts (unchanged) + rebuilds any `documents` row that's
  missing/drifted from its on-disk `meta.sbmd` (disk is authoritative).
```

## Data model changes

### `.sbmd` (the on-disk contract, `apps/api/src/lib/shareArtifact.ts` `Sbmd` type)

Three new fields, all optional for backward compatibility with existing
Discord-originated artifacts:

```ts
export interface Sbmd {
  v: number;
  mode: "download" | "page" | "view";
  contentType: string;
  filename: string;
  title: string;
  scope: string;               // unchanged: RA-permission-string gate, kept as-is
  createdAt: string;
  expiresAt: string;           // now may be "" / absent — treated as "never" (see below)
  producer: string;
  ownerId?: string;            // NEW: entraOid of the publishing/uploading user (web-originated only)
  ownerName?: string;          // NEW: display name, for the UI
  visibility?: "private" | "org"; // NEW: default "private" when present; absent = legacy behavior (scope alone gates, as today)
}
```

`loadArtifact` (`apps/api/src/lib/shareArtifact.ts`) currently does
`Date.parse(sbmd.expiresAt)` and fails closed (422) on anything unparseable —
including a missing/empty string. Change: treat a missing/empty/null
`expiresAt` as "never expires" (skip the expiry check entirely) rather than a
malformed-data failure. This is the only behavior change to the existing
`loadArtifact`/`share.ts` path; everything else (token validation, containment,
mode/scope validation) is untouched.

`share.ts`'s auth check gains one clause: when `sbmd.visibility === "private"`,
require `request.user.entraOid === sbmd.ownerId` (in addition to the existing
staff-role gate) rather than falling through to the `scope` permission check.
`visibility === "org"` or absent keeps today's `scope` check exactly as-is.

### Switchboard hub SQLite table: `documents`

```sql
CREATE TABLE documents (
  token TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  visibility TEXT NOT NULL,        -- 'private' | 'org'
  created_at TEXT NOT NULL,
  expires_at TEXT,                 -- NULL = permanent
  conversation_id TEXT,            -- NULL for direct uploads or Discord-originated
  size_bytes INTEGER NOT NULL
);
```

This table is a **mirror**, not the source of truth — `meta.sbmd` on disk is
authoritative. Every write path (`hub/documents.ts`) writes the fs artifact
first (temp-dir-then-rename, as today), then inserts/updates the row in the
same function call. The reconciliation sweep (extending
`hub/publishCleanup.ts`) walks `ARTIFACTS_DIR/*/meta.sbmd` on its existing
interval and: (a) removes rows whose directory no longer exists, (b) inserts
rows for any directory missing one, (c) overwrites any row whose fields
disagree with the on-disk `.sbmd`. This makes the index eventually-consistent
with disk even if a hub crash lands between the fs write and the SQLite write.

Discord-originated artifacts (no `ownerId`/`visibility` in their `.sbmd`) are
indexed with `owner_id: "discord"`, `owner_name: "Discord"`,
`visibility: "org"` — they show up in the org-wide Documents list but can't be
toggled private (no real owner to scope to) and aren't shown as "mine" to any
web user.

## Components

### 1. `hub/documents.ts` (new)

Injectable-I/O core, mirroring `publishLink.ts`'s shape:

```ts
export interface DocumentsOpts extends PublishOpts { db: DocumentsDb }
export function publishDocument(args: PublishArgs & { ownerId: string; ownerName: string; visibility?: "private"|"org"; conversationId?: string }, opts: DocumentsOpts): Promise<PublishResult>
export function uploadDocument(args: { filename: string; bytes: Buffer; title?: string; visibility?: "private"|"org"; ownerId: string; ownerName: string }, opts: DocumentsOpts): Promise<PublishResult>
export function setVisibility(token: string, visibility: "private"|"org", requesterId: string, opts: DocumentsOpts): Promise<{ ok: true } | { ok: false; reason: string }>
export function deleteDocument(token: string, requesterId: string, opts: DocumentsOpts): Promise<{ ok: true } | { ok: false; reason: string }>
export function listDocuments(filter: { requesterId: string; scope: "mine" | "org" }, opts: DocumentsOpts): DocumentRow[]
```

- `publishDocument` calls the existing `publishArtifact` (from `publishLink.ts`,
  unchanged) for the fs write, defaults `ttlDays` to `null` (permanent) instead
  of the config `defaultTtlDays` — explicit `ttl_days` from the agent still
  produces an ephemeral link when the caller genuinely wants one. Defaults
  `visibility` to `"private"` when the caller omits it.
- `uploadDocument` is the direct-human-upload path: validates size (reuses the
  same `maxBytes` cap as outbox attachments) and writes straight into
  `ARTIFACTS_DIR` (no outbox involved — there's no agent/conversation).
- `setVisibility`/`deleteDocument` check `requesterId === row.owner_id` before
  mutating (owner-only; no admin-override in v1 — YAGNI until someone asks).
- `listDocuments("mine")` filters `owner_id = requesterId`; `listDocuments("org")`
  filters `visibility = 'org'` (regardless of owner — that's the point).

### 2. `publish_link` tool — `shim/server.ts` (modify)

Gains an optional `visibility?: "private" | "org"` parameter alongside the
existing `path`, `mode`, `title`, `scope`, `ttl_days`. `ttl_days` semantics
change: omitted ⇒ permanent (was: config default of 30 days). Tool description
updated to explain the new default and that omitting `ttl_days` means the
document persists indefinitely in the org's Documents library.

### 3. Shim-socket `attachment` event — `hub/transports/shimSocket.ts` (modify)

When a `publish` frame's originating transport is a **web conversation** (not
Discord — checked the same way other web-only behavior is gated in
`makeTransport`), after the existing `publish_result` response, also emit
`{ t: "attachment", conversationId, token, title, contentType, mode, visibility }`
onto that conversation's event stream (the same stream `conversationStream.ts`
already consumes). This is additive — Discord transports never see this frame,
so Discord's existing behavior (agent pastes the URL as text) is unchanged.

### 4. Hub HTTP routes — `hub/webActions.ts` (modify) / new file if it grows

Reached through the same Entra-authenticated proxy already in front of
`/switchboard/*` (`apps/api/src/routes/switchboardProxy.ts` injects
`x-switchboard-user`) — no new auth mechanism needed, the hub trusts that
header exactly as its existing web routes do.

- `GET /api/documents?scope=mine|org` → `listDocuments`
- `POST /api/documents` (multipart) → `uploadDocument`
- `PATCH /api/documents/:token` `{ visibility }` → `setVisibility`
- `DELETE /api/documents/:token` → `deleteDocument`

### 5. `apps/api/src/lib/shareArtifact.ts` — image rendering fix (modify)

Add an image branch to `serveArtifact`'s `"view"` handling, parallel to the
existing PDF branch (inline, no HTML wrapper needed — image bytes aren't
executable):

```ts
if (ct.startsWith("image/")) {
  return { status: 200, body: bytes, headers: { "Content-Type": ct, "Content-Disposition": "inline", ...NOSNIFF } };
}
```

Placed before the `text/*` checks in the existing `if` chain.

### 6. Web client (`web/client/`)

- `components/DocumentCard.tsx` (new) — one component, two call sites: inline
  in `Transcript.tsx`/`MessageItem.tsx` (driven by the new `attachment` SSE
  event, keyed by token so a duplicate event is idempotent) and as a list row
  in `DocumentsWorkspace.tsx`. Image content-type → thumbnail (`<img>` pointed
  at the `/share/:token` URL); everything else → icon (by content-type
  family) + title + size. Click → for `mode: download`, sets `download`
  attribute; otherwise opens the RA `/share/:token` URL in a new tab (that's
  the authenticated render surface; the hub doesn't re-implement rendering).
- `components/DocumentsWorkspace.tsx` (new) — "Mine" / "Org-wide" tabs, list
  from `GET /api/documents`, upload control (native file input +
  drag-and-drop zone) posting to `POST /api/documents`, a visibility toggle
  and delete action per row (owner-only — hidden/disabled for rows the
  viewer doesn't own).
- `components/AppRail.tsx` (modify) — new destination
  `{ id: "documents", label: "Documents", glyph: "▤", ... }`, gated behind
  `features.documents` (new flag, same pattern as the existing
  `features.agents`).
- `routes.ts`/`base.ts` (modify) — add `pathForDocument(token, base)`,
  following the existing `pathForAgent`/`pathForConversation` pattern.
- `api.ts` (modify) — typed client methods for the four new endpoints.
- `conversationStream.ts` (modify) — handle the new `attachment` event type,
  surfacing it to `App.tsx`/`Transcript.tsx` state alongside existing message
  events.

## Error handling

- Upload/publish failures (oversize, unwritable `ARTIFACTS_DIR`, invalid
  visibility value) return a structured `{ ok: false, reason }` — same pattern
  as today's `publishArtifact`; the web UI shows the reason inline, the agent
  tool returns a readable error string rather than throwing.
- `setVisibility`/`deleteDocument` on a token the requester doesn't own →
  `{ ok: false, reason: "not_owner" }`, surfaced as 403 from the HTTP route.
- A reconciliation-sweep mismatch (row exists, disk doesn't, or vice versa) is
  corrected silently on the next sweep tick — not surfaced as a user-facing
  error, matches the existing cleanup sweep's fail-closed, non-throwing style.
- `share.ts`'s existing fail-closed behavior (malformed data → 422, missing →
  404, expired → 410) is preserved; the only change is that an absent
  `expiresAt` is no longer "malformed," it's "never expires."

## Security

- No new auth mechanism: web-originated writes/reads flow through the same
  Entra-authenticated proxy (`switchboardProxy.ts`) already gating
  `/switchboard/*`; RA reads flow through the existing `requireRole(staffRoles)`
  gate on `/share/:token`.
- Private-by-default closes the gap where an agent publishing something
  sensitive (a family's document, a draft with PII) would otherwise be
  visible org-wide the moment it's created — matches the field-encryption /
  fail-closed conventions already documented for this codebase.
- Owner-only mutation (`setVisibility`, `deleteDocument`) — no cross-user
  override in v1.
- Upload path reuses the existing size cap and containment logic
  (`resolveOutboxFile`'s validation pattern) rather than introducing new
  path-handling code.
- HTML rendering keeps its existing CSP sandbox (`sandbox` / `sandbox
  allow-scripts` per mode) — untouched. The new image branch serves raw bytes
  inline, which carries no script-execution risk (images aren't executable
  content), so no sandboxing is needed there.
- Discord-originated artifacts are never eligible for `visibility: "private"`
  toggling (no real Entra owner to scope to) — `setVisibility` rejects any
  attempt to touch a `owner_id: "discord"` row.

## Testing

- `hub/documents.ts`: fs+SQLite dual-write happens atomically within one
  function call; `listDocuments` scoping (mine vs org, including the
  Discord-owned org-wide rows); `setVisibility`/`deleteDocument` owner
  enforcement; reconciliation sweep rebuilds a missing/drifted row from disk
  and removes a row whose directory is gone.
- `apps/api/src/lib/shareArtifact.ts`: image branch (`.png`/`.jpg` content
  types render inline, not download); `loadArtifact` treats missing/empty
  `expiresAt` as never-expiring (regression test — must not 422); the new
  `visibility === "private"` ownership check in `share.ts` (owner reads OK,
  non-owner 403, missing `visibility` field falls back to today's `scope`
  check unchanged).
- `shim/server.ts` / `hub/transports/shimSocket.ts`: `publish_link` with
  omitted `ttl_days` produces a permanent artifact (was 30-day default);
  `visibility` param threading; the new `attachment` SSE frame is emitted only
  for web-conversation-originated publishes, never for Discord.
- Web client: `DocumentCard.test.tsx` (image thumbnail vs icon+title vs
  download-fallback rendering per content-type), `DocumentsWorkspace.test.tsx`
  (tab filtering, upload, visibility toggle, owner-gated actions hidden for
  non-owned rows), `conversationStream.test.ts` extended for the `attachment`
  event, `routes.test.ts` extended for `pathForDocument`.
- Full suite + typecheck green vs the known baseline (1 pre-existing Windows
  test fail in `tests/config.test.ts`, see repo `CLAUDE.md`).

## Rollout

1. Land the `.sbmd`/`share.ts`/`shareArtifact.ts` changes first (backward
   compatible — absent `visibility`/`ownerId` fields behave exactly as today).
   Deploy ReadyApp (`api` target).
2. Land `hub/documents.ts`, the SQLite migration, the extended
   `publish_link` tool, and the `attachment` shim frame. Behind
   `hub.shareLinks.enabled` (already the existing gate — currently absent from
   `config/hub.config.json`, i.e. off) — flipping it on is the point at which
   this whole feature (old and new) goes live together, since it was never
   turned on before.
3. Land the web client changes (`DocumentsWorkspace`, `DocumentCard`,
   `AppRail` entry) behind a new `features.documents` flag in the workspace's
   existing feature-flag response, canary'd to Aurora first.
4. Smoke on the box: agent publishes a doc from a web conversation → inline
   card renders → appears in "Mine" → toggle to "org-wide" → confirm it now
   appears for another staff account → upload a PNG directly via the UI →
   confirm in-browser thumbnail (not a forced download) → confirm a
   Discord-originated share link still works unchanged.
5. Open `features.documents` beyond the canary once verified.
