# Share Links — Switchboard `publish_link` Producer (sub-project 2 of 3)

**Date:** 2026-06-28
**Status:** Approved (design), pending spec review → implementation plan

**Depends on:** the contract
`ReadyApp/docs/superpowers/specs/2026-06-28-entra-share-links-contract-design.md`
(the `.sbmd` schema, `<ARTIFACTS_DIR>/<token>/` layout, token format, URL,
modes, scope, TTL/cleanup). The RA renderer (sub-project 3) is built on branch
`ReadyApp/feature/entra-share-links`. This spec is the producer half.

## Problem

Agents produce artifacts (PDF statements, rendered HTML dashboards, large CSVs,
markdown reports) too big or unviewable as Discord attachments. They need to
publish one and get back a staff-only Entra-gated URL to share. The RA renderer
already serves `<ARTIFACTS_DIR>/<token>/`; this builds the Switchboard side that
writes a conforming artifact and returns the URL.

## Goal

A flag-gated agent tool `publish_link` that, given a file in the agent's outbox,
writes a contract-conforming `<token>/{file, meta.sbmd}` to the shared
`ARTIFACTS_DIR` and returns `https://<RA_HOST>/share/<token>` to the agent —
plus a cleanup sweep that reaps expired artifacts.

Non-goals: the rendering (RA's job); updating/listing published artifacts;
per-recipient links; object storage. v1 assumes the producer and the renderer
share `ARTIFACTS_DIR` on the same VPS.

## Architecture

```
agent → publish_link(path, mode?, title?, scope?, ttl_days?)     [shim/server.ts]
  REQUEST/RESPONSE (like recall): shim sends {t:"publish", id, …}, awaits
  {t:"publish_result", id, url|error}, returns the URL string to the agent.
  → hub ShimSocketServer.onPublish (bound to the agent name)      [hub/transports/shimSocket.ts]
  → publishArtifact(...)                                          [hub/publishLink.ts, new]
       validate path (resolveOutboxFile — reused from attach_file)
       infer contentType+mode from extension if omitted
       token = base62(randomBytes(16))
       write <ARTIFACTS_DIR>/<token>.tmp/{<filename>, meta.sbmd} → rename <token>/
       url = https://<RA_HOST>/share/<token>
  → socket.write {t:"publish_result", id, url}                    (or error)

cleanup sweep (setInterval, default daily)                        [hub/index.ts]
  → for each <token>/ with meta.sbmd.expiresAt in the past → rm -rf <token>/
```

Gating: exposed only when `hub.shareLinks.enabled` — the hub injects
`PUBLISH_LINK=1` into the shim's MCP-config env via `buildShimMcpConfig`
(threaded from a new `publishEnabled` transport opt), exactly as `ATTACH_FILES`
is for `attach_file`. Off ⇒ tool not listed AND a stray `publish` frame ignored
(double-gate).

## Components

### 1. Agent tool — `shim/server.ts` (modify)

New tool, listed only when `process.env.PUBLISH_LINK === "1"` (same conditional
pattern as `attach_file`):
```
publish_link(path, mode?, title?, scope?, ttl_days?)
```
(No `chat_id` — the tool returns the URL to the agent rather than posting to a
channel; the agent decides what to do with the link.)
- `path` — relative to the agent's outbox (validated hub-side, like `attach_file`).
- `mode` — optional `"download" | "page" | "view"`; inferred if omitted.
- `title` — optional human label (defaults to the filename).
- `scope` — optional `"staff" | "<ra-permission>"`; default `"staff"`.
- `ttl_days` — optional integer; default from config.

Unlike `attach_file` (fire-and-forget), this is **request/response** — it maps to
`{ t: "publish", id, … }` and the shim awaits `{ t: "publish_result", id, url }`
(or `{ …, error }`), returning the URL (or the error message) as the tool's text
result. Mirrors how `recall`/`ask_agent` are handled in `shim/server.ts` (a
`pending` map keyed by a request id, with a timeout). Description tells the agent
to write the file into its outbox first, then publish it.

### 2. Shim-socket frame — `hub/transports/shimSocket.ts` (modify)

Add an `onPublish` request/response handler beside `onRecall`/`onAskAgent`: on a
`{ t: "publish", id, … }` frame, run the (async) publish, then
`socket.write(encode({ t: "publish_result", id, url }))` (or `{ …, error }`). The
agent identity is the registered transport agent (as with the other shim
callbacks), so an agent can only publish from its own outbox.

### 3. Publish core — `hub/publishLink.ts` (new)

Injectable I/O so it is unit-testable (mirrors `attachHandler`/`outboxAttach`):
```ts
export interface PublishOpts {
  artifactsDir: string; raHost: string; agent: string;
  outboxBase: string; maxBytes: number; defaultTtlDays: number;
  now: Date; randomToken: () => string;   // injectable for tests
}
export interface PublishArgs { path: string; mode?: string; title?: string; scope?: string; ttlDays?: number }
export type PublishResult = { ok: true; url: string; token: string } | { ok: false; reason: string }

export function inferModeAndType(filename: string): { mode: "download"|"page"|"view"; contentType: string }
export function buildSbmd(args, inferred, opts): Sbmd     // the contract's .sbmd object
export async function publishArtifact(args: PublishArgs, opts: PublishOpts, io: PublishIO): Promise<PublishResult>
```
- `publishArtifact`: validate `path` via `resolveOutboxFile(path, { outboxBase, agent, maxBytes, allowedExtensions: [] })` (reused) → on `!ok` return `{ok:false, reason}`; else read the bytes (already buffered by the validator), compute `contentType`/`mode` (explicit args win over `inferModeAndType`), build the `.sbmd`, generate the token, write `<artifactsDir>/<token>.tmp/{<basename>, meta.sbmd}` then rename to `<token>/` (atomic), return `{ ok:true, url: \`https://${raHost}/share/${token}\`, token }`.
- `inferModeAndType` MIME map: `.pdf`→`application/pdf`/`view`; `.html`/`.htm`→`text/html`/`page`; `.md`→`text/markdown`/`view`; `.csv`→`text/csv`/`view`; `.txt`→`text/plain`/`view`; `.png`/`.jpg`/`.gif`/`.webp`→ image type/`view`(falls to download in RA); else `application/octet-stream`/`download`.
- Token: `crypto.randomBytes(16)` → base62 (≈22 chars, `[0-9A-Za-z]`); injected as `randomToken()` for deterministic tests. (Switchboard forbids `Math.random` in pure modules — `crypto.randomBytes` is fine; inject for tests.)
- `.sbmd` exactly matches the contract (`v:1`, `mode`, `contentType`, `filename`=basename, `title`, `scope` default `"staff"`, `createdAt`=now, `expiresAt`=now+ttl, `producer`=`agent:<name>`).

### 4. Cleanup sweep — `hub/publishCleanup.ts` (new, pure selection) + `hub/index.ts` (wire)

- `selectExpired(entries: { token: string; expiresAt: string }[], now: Date): string[]` — pure; returns tokens whose `expiresAt` is past (or whose `.sbmd` is unreadable AND the dir is older than a grace period — pass that in). Unit-tested.
- `hub/index.ts`: a `setInterval(cleanupIntervalMs)` (default daily, `unref`'d) that reads `<ARTIFACTS_DIR>/*/meta.sbmd`, runs `selectExpired`, and `rm -rf`s the selected `<token>/` dirs. Also reaps stale `*.tmp/` dirs older than the grace period (abandoned mid-write). Gated on `shareLinks.enabled`.

### 5. Config + gating — `hub/types.ts`, `hub/index.ts`, `hub/transports/streamJson*.ts` (modify)

```jsonc
hub.shareLinks: {
  enabled: false,
  artifactsDir: "/srv/share-artifacts",
  raHost: "readyapp.player-ready.co.uk",
  defaultTtlDays: 30,
  maxBytes: 26214400,            // 25 MB
  cleanupIntervalMs: 86400000    // daily
}
```
- `publishEnabled: !!hub.shareLinks?.enabled` added to the transport opts (declared BEFORE the persistent-agent spawn loop, per the makeTransport-TDZ lesson) and threaded into `buildShimMcpConfig(..., consultEnabled, attachEnabled, publishEnabled)` → injects `PUBLISH_LINK=1`.
- `onPublish` wired in `makeTransport` bound to the agent `name`, gated by `shareLinks.enabled`.

## Error handling

- Path fails outbox containment / missing / oversize → `publish_result` with a
  reason; the tool returns a readable error to the agent (it does not crash the turn).
- `ARTIFACTS_DIR` unwritable → error result + stderr log.
- A partial write never becomes visible (temp-dir-then-rename).
- Disabled but a `publish` frame arrives → ignored (double-gate); the shim
  wouldn't list the tool anyway.

## Security

- Reuses `attach_file`'s outbox containment (`resolveOutboxFile` realpath) — an
  agent can only publish a file it wrote into *its own* outbox; identity comes
  from the transport, not the frame.
- Token unguessable (`randomBytes(16)`); the real access boundary is RA's Entra
  staff gate (renderer). The producer sets `scope` (default `staff`); an agent
  publishing CYP/finance can pass a stricter RA permission string.
- Size cap (default 25 MB). The artifact bytes are read once (already buffered by
  `resolveOutboxFile`) and written; no path passed downstream.

## Testing

- **`publishLink` core:** outbox containment reuse (escape/oversize → reason);
  `inferModeAndType` per extension; explicit `mode`/`scope`/`ttl` override the
  defaults; `.sbmd` shape (v/mode/contentType/filename/title/scope/expiresAt math)
  with injected `now`+`randomToken`; atomic write (temp dir then rename — via
  injected fs, assert the final `<token>/` has both files and no leftover `.tmp`).
- **`selectExpired`:** past vs future `expiresAt`; unreadable `.sbmd` past grace.
- **`toolCallToWire("publish_link", …)`** → `{ t:"publish", … }` mapping + the
  request/response handling (shim returns the URL).
- Full suite + typecheck green vs the known baseline (1 pre-existing test fail,
  2 pre-existing tsc errors).

## Rollout

1. Land behind `shareLinks.enabled: false`.
2. Set `artifactsDir` to the SAME path the RA renderer reads, set `raHost`, enable
   on the hub, restart. The RA renderer must have `ARTIFACTS_DIR` set to the same
   dir (it ships dark until then).
3. Smoke: an agent writes `report.md` to its outbox, calls `publish_link`, gets a
   URL; open it as staff → the rendered page; confirm a non-staff/expired link
   behaves per the renderer; confirm the cleanup sweep removes an expired artifact.

The producer + renderer share exactly two coordination points: `ARTIFACTS_DIR`
and `RA_HOST`.
