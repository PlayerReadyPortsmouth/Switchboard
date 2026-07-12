# Switchboard — Config & Feature Reference

Source of truth: this file is a snapshot of the code as of 2026-07-02. Re-derive from
`hub/config.ts`, `hub/types.ts`, `hub/index.ts` if it drifts — nothing here overrides the code.

## 1. Files

| File | Tracked? | Purpose |
|---|---|---|
| `config/hub.config.json` | Yes (real config) | Single hub-wide config, loaded by `loadConfigs()` in `hub/config.ts`. |
| `config/agents.example.json` | Yes (template) | Copy to `config/agents.json` before first run — `hub/config.ts` throws `config: config/agents.json not found` if it's missing. `agents.json` itself is git-ignored (real config, not template). |
| `<stateDir>/.env` | No (runtime, per-deploy) | Default `~/.switchboard/.env`. Loaded by `hub/env.ts`'s `config()` — a minimal dotenv reader that only sets a key if it isn't **already** set in `process.env` (real env always wins). This is where `DISCORD_BOT_TOKEN` etc. actually live. |

`SWITCHBOARD_CONFIG` env var overrides the config directory (default `<repo>/config`).

## 2. `hub.config.json` — every key

| Key | Type | Default | Purpose |
|---|---|---|---|
| `botTokenEnv` | string | `"DISCORD_BOT_TOKEN"` | Name of the env var holding the bot token — **not the token itself**. |
| `guildIds` | string[] | `[]` (must set) | Discord guild IDs the bot resolves roles against. |
| `socketPath` | string | `~/.switchboard/hub.sock` | Unix socket the hub listens on for agent shims. `~` expanded. |
| `stateDir` | string | `~/.switchboard` | Root for all hub state: memory vault, audit log, outbox, caches, share-artifacts (if not overridden), `.env`, sockets. |
| `routerModel` | string | `"claude-haiku-4-5"` | Model used by the router (`claude -p`) to pick an agent. |
| `switchThreshold` | number | `0.7` | Confidence (0–1) above which the router auto-switches the bound agent. |
| `defaultAgent` | string | — (required, must exist in `agents.json`) | Agent used when no route matches. |
| `ephemeralTimeoutMs` | number | `120000` | Idle timeout before an ephemeral agent session tears down. |
| `tagStyle` | `"prefix"\|"embed"` | `"prefix"` | How agent replies are tagged in Discord. |
| `chatKeyScope` | `"user"\|"channel"` | `"user"` | Scope for sticky agent bindings. |
| `memoryDir` | string | `~/.switchboard/memory` | Memory vault root. |
| `contextCacheSize` | number | `20` | Per-conversation recent-message ring buffer size. |
| `distillIdleMs` | number | `600000` | Idle gap before the background distiller turns a chat into memory notes. |
| `librarianModel` / `distillerModel` / `overseerModel` | string | — | Model ids for the memory librarian, distiller, and default overseer judge. |
| `contextWindows` | `{[model]: number}` | `{"default": 200000}` | Context window size per model id. |
| `statusChannelId` | string | absent = off | Discord channel for the live self-editing status embed. |
| `statusRefreshMs` | number | `15000` | Status board edit cadence. |
| `metricsPort` | number | absent = off | Port for Prometheus `/metrics` + `/health`. |
| `webPort` | number | absent = off | Port for the (unauthenticated, loopback-bound by default) web dashboard. |
| `memory` | object | — | `{ index: "local"\|"qdrant", embedder: "local"\|"openai", qdrant: {url, apiKeyEnv, collection}, openai: {baseUrl, apiKeyEnv, model} }` |
| `gardener` | object | off | `{ enabled, intervalMs, importanceWeight, hotSetSize, decayHalfLifeMs, staleAfterMs, archiveAfterMs, scopeBudget }` — vault-hygiene sweep. |
| `deployApproverUserId` | string | — | The one Discord user allowed to press `deploy:*` buttons. |
| `webhookPort` | number | `4400` | Single HTTP listener for all `webhooks[]` routes. |
| `webhooks[]` | array | `[]` | `{ path, secretEnv, agent, channelId, prefix? }` — inbound HMAC-verified HTTP → agent card. |
| `schedules[]` | array | `[]` | `{ id, cron?, hourUtc?, agent, channelId, message, tz? }` |
| `commands[]` | array | `[]` | `{ match, agent, channelId, message, allowlistOnly? }` — exact-text → canned message. |
| `directCommands[]` | array | `[]` | `{ match, exec:{type:"http"\|"shell",...}, render?, template?, cardTitle?, formatAgent?, allowlistOnly? }` |
| `spawnTriggers[]` | array | `[]` | `{ pattern, agent, taskTemplate, setupCommand? }` — outbound-text regex spawns an ephemeral agent. |
| `outboundWebhooks[]` | array | `[]` | `{ id, pattern?, url, secretEnv?, template?, requireApproval? }` — agents address by `id`, never a raw URL. |
| `outboundAllowedHosts[]` | string[] | `[]` | Destination-host allowlist for outbound webhooks. |
| `outboundRetries` | number | `3` | Outbound delivery retries before dead-lettering. |
| `audit` | object | — | `{ enabled, kinds[], maxBytes, keepFiles }` |
| `escalation` | object | — | `{ enabled, auto, autoMaxPerHour }` — `!hard` / auto re-run at higher effort. |
| `reload` | object | — | `{ enabled }` — gates the `!reload` operator command. |
| `trace` | object | — | `{ enabled, retentionDays, sweepIntervalMs }` |
| `receipts` | object | — | `{ enabled }` — `post_card`/`update_card`/`attach_file` become request/response with a message-id confirmation. |
| `approvals` | object | — | `{ enabled, channelId?, approvers[], ttlMs }` — human-in-the-loop gate. |
| `peering` | object | — | Cross-VPS hub liaison: `{ enabled, listenPath, selfName, selfBaseUrl, askTimeoutMs, mirrorChannelId, dedupeWindowMs, maxClockSkewMs, ratePerPeerPerMin, notifyRetry{maxAttempts,baseDelayMs}, peers[]{name,baseUrl,secretEnv} }` |
| `consult` | object | — | `{ enabled, timeoutMs }` — gates the inter-agent `ask_agent` tool. |
| `workflow` | object | — | `{ enabled, stepTimeoutMs }` |
| `workflows[]` | array | `[]` | `{ id, description, steps:[{id,agent,prompt}] }` — declarative pipelines run via `!run`. |
| `timezone` | string | `"Europe/London"` | Default IANA tz for `schedules[].cron`. |
| `shareLinks` | object | **absent = off** | See §5 — not present in the shipped example, must be hand-added. |

### Canonical conversations

`conversationDbFile` optionally selects the SQLite file used for canonical conversations. A leading `~` is expanded to the hub user's home directory. When omitted, the exact default is `<stateDir>/switchboard.sqlite`.

Conversation HTTP routes trust the `X-Switchboard-User` request header as the authenticated identity. Deploy the web listener only behind a trusted proxy that strips any client-supplied copy of this header and sets it from the authenticated session; do not expose these routes directly to untrusted clients.

SQLite uses write-ahead logging while the hub is running. A consistent live backup must include both the configured database file and its `-wal` file, captured consistently, or be made with SQLite's backup command. After a clean hub shutdown, the database file can be backed up normally.

## 3. `agents.json` — agent registry

Top-level keys are agent names → `AgentConfig` (`hub/types.ts:136-142`):

- `emoji`, `description`, `mode` (`"persistent"|"ephemeral"`)
- `access`: `{ roles: string[] ("*" = any), users?: string[], consultableBy?: string[], peerableBy?: string[] }`
- `runtime`: `cwd` (**required**, `~` expanded), `model?`, `allowedTools?` (ephemeral only), `claudeArgs?`, `appendSystemPrompt?`, `resumable?`, `useMemory?`, `injectContext?` (`"always"|"onSwitch"|"never"`), `overseer?` `{enabled,maxIterations?,maxWallclockMs?,model?}`, `sessionGovernor?` `{enabled,softPct?,hardPct?,strategy?}`, `maxQueueDepth?` (default 8), `coalesceBurst?`, `pool?` `{min,max,scaleUpQueue,scaleUpSustainMs,replicaIdleMs}`, `audit?`

`loadConfigs()` throws at boot if `defaultAgent` isn't registered, or any agent's `mode` isn't `persistent`/`ephemeral`.

## 4. Config loading, hot-reload, web editor

- **`hub/config.ts`** — `loadConfigs(dir)` parses both files, `expandHome()`s `stateDir`, `socketPath`, `outboundAttachments.outboxDir`, `shareLinks.artifactsDir`, and every agent's `runtime.cwd`.
- **`!reload` classification** (`hub/configReload.ts`) — `planReload(prev, next)` diffs old vs new config. Hub-level keys `socketPath, stateDir, defaultAgent, metricsPort, metricsHost, webPort, webHost, webhookPort` always force a **full hub restart**. Agent add/remove/mode-flip/pool changes also force full restart. Any other spawn-signature change on a non-pooled persistent agent triggers a **hard reload** (respawn just that agent).
- **Hub hot-swap "safe keys"** (`hub/hubConfigDraft.ts:18-21`) — exactly `routerModel, librarianModel, distillerModel, overseerModel, contextWindows, commands, directCommands`. Only these 7 fields can be live-hot-swapped without a restart; anything else is tier `"restart"`.
- **Web dashboard editor** (`hub/web.ts` + `hub/webActions.ts`, served on `webPort`) — a generic recursive JSON tree editor. Hub config: `GET api/hub-config` → edit → `POST api/hub-config/preview` → `POST api/hub-config/confirm`. Agent config: `POST api/agents/<name>/preview` → `confirm`. Writes are atomic (`<file>.tmp-<pid>` then `renameSync`).
- **Security guard**: `EXCLUDED_HUB_CONFIG_KEYS = ["botTokenEnv", "socketPath", "stateDir", "guildIds"]` (`hub/index.ts:130-138`) — stripped from every GET/preview response so the token env-var name, socket path, state dir, and guild IDs never round-trip through the browser.
- **The dashboard itself has no auth layer** and binds to `127.0.0.1` by default (README.md:252). If you expose `webHost: "0.0.0.0"` you need your own reverse proxy / VPN / auth in front of it.

## 5. Environment variables

| Var | Set by | Description | Required? |
|---|---|---|---|
| `SWITCHBOARD_CONFIG` | operator | Overrides config directory. | Optional |
| `<botTokenEnv>` (default `DISCORD_BOT_TOKEN`) | operator, in `<stateDir>/.env` | Discord bot token. Hub exits if unset. | **Required** |
| `<memory.openai.apiKeyEnv>` | operator | Only read when `memory.embedder === "openai"`. | Optional |
| `<memory.qdrant.apiKeyEnv>` | operator | Only read when `memory.index === "qdrant"`. | Optional |
| `<webhooks[].secretEnv>` | operator | Inbound HMAC secret per webhook route. Defaults to `""` (can't verify) if unset. | Optional per-route, effectively required if using `webhooks[]` |
| `<outboundWebhooks[].secretEnv>` | operator | HMAC signing secret for that outbound route. | Optional |
| `<directCommands[].exec.secretEnv>` | operator | Bearer secret for an HTTP directCommand. | Optional |
| `<peering.peers[].secretEnv>` | operator | Per-peer liaison shared secret. | Optional |
| `HUB_SOCKET`, `AGENT_NAME` | **hub-injected**, not operator | Shim connection identity. | Required (auto) |
| `RECEIPTS`, `CONSULT`, `ATTACH_FILES`, `PUBLISH_LINK`, `PEERING` | **hub-injected**, not operator | `"1"` toggles that shim tool's exposure, mirroring `hub.receipts/consult/outboundAttachments/shareLinks/peering.enabled`. | Optional (auto) |

**Important:** the shim (`shim/server.ts`) runs as a spawned MCP server and only sees the `env` block it's given at spawn time — **not** the hub's own `process.env`. Feature-gate vars (`CONSULT`, `ATTACH_FILES`, `PUBLISH_LINK`, `PEERING`, `RECEIPTS`) are injected via `buildShimMcpConfig`; setting them in the hub's shell does nothing.

## 6. Access-control layering

For any inbound action, in order:

1. **`hub/baseGate.ts`** — Layer 0. DM policy: `pairing` (default, unknown senders get a code, `MAX_PENDING=3`, `PAIR_TTL_MS=1h`), `allowlist` (`allowFrom[]` only), or `disabled`. Non-DM gated by opted-in `groups[]`.
2. **`hub/access.ts`** — `permittedAgents()`: per-agent `access.roles`/`access.users` check (role `"*"` = any).
3. **Feature flags** — `hub.consult.enabled`, `hub.outboundAttachments.enabled`, `hub.shareLinks.enabled`, `hub.peering.enabled`, `hub.receipts.enabled` each independently gate a shim tool's presence.
4. **`hub/deployGate.ts`** — any `deploy:*` button customId requires `userId === deployApproverUserId`; everything else passes through unconditionally (not this gate's concern).
5. **`hub/gatedActions.ts` + `hub/approvals.ts`** — namespaced button customIds (`namespace:action:arg`) matched against `hub.gatedActions[]`; `requireApproval` effects park in `ApprovalRegistry` until an approver (`approvers[]`, default `deployApproverUserId`) presses Approve/Deny. Agents have no self-approval path.

`hub/turnGate.ts` is a **concurrency** gate, not a permission gate — serializes one persistent agent's turns, capped at `runtime.maxQueueDepth` (default 8).

---

## 7. The share-link system (`publish_link`)

### 7.1 What it does

An agent calls `publish_link({ path, mode?, title?, scope?, ttl_days? })`. Switchboard:

1. Resolves `path` inside `<outboxBase>/<agent>/` (same per-agent outbox `attach_file` uses — `hub.outboundAttachments.outboxDir`, default `<stateDir>/outbox`), with realpath containment (defeats `..` and symlink escapes) via the same `resolveOutboxFile()` helper `attach_file` uses (`hub/outboxAttach.ts`).
2. Infers `mode`/`contentType` from the file extension if not given explicitly (`hub/publishLink.ts:10-24`):

   | ext | contentType | default mode |
   |---|---|---|
   | pdf | application/pdf | view |
   | html/htm | text/html | page |
   | md | text/markdown | view |
   | csv | text/csv | view |
   | txt | text/plain | view |
   | png/jpg/jpeg/gif/webp | image/* | view |
   | anything else | application/octet-stream | download |

3. Generates `token` = base62(`crypto.randomBytes(16)`) padded to 22 chars — 128 bits, cryptographically unguessable.
4. Writes atomically: `mkdir <artifactsDir>/<token>.tmp` → write the file bytes → write `meta.sbmd` (JSON below) → `rename` to `<artifactsDir>/<token>`. Any failure ⇒ `write_failed`.
5. Returns `{ ok: true, url: "https://<raHost>/share/<token>", token }`.

**No SSH/SCP/network call anywhere** — `publishArtifact()` only calls injected `io.mkdir`/`writeFile`/`rename`, all local filesystem. Per the design spec: *"v1 assumes the producer and the renderer share `ARTIFACTS_DIR` on the same VPS."* Confirmed by `package.json` — no ssh/scp/S3 client in dependencies.

### 7.2 `.sbmd` sidecar format

Written to `<artifactsDir>/<token>/meta.sbmd`, sibling to `<artifactsDir>/<token>/<filename>`:

```json
{
  "v": 1,
  "mode": "view",
  "contentType": "application/pdf",
  "filename": "report.pdf",
  "title": "report.pdf",
  "scope": "staff",
  "createdAt": "2026-06-28T00:00:00.000Z",
  "expiresAt": "2026-07-28T00:00:00.000Z",
  "producer": "agent:ada"
}
```

`scope: "staff"` is satisfied by the renderer's staff-role auth check alone; any other string is treated as a permission string checked against the requesting user's resolved permissions.

### 7.3 Config keys — `hub.shareLinks`

Not present in the shipped `config/hub.config.json` — must be hand-added:

```jsonc
"shareLinks": {
  "enabled": true,
  "artifactsDir": "/srv/share-artifacts",
  "raHost": "readyapp.player-ready.co.uk",
  "defaultTtlDays": 30,
  "maxBytes": 26214400,
  "cleanupIntervalMs": 86400000
}
```

| Key | Default if absent | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch — gates `PUBLISH_LINK=1` injection, `onPublish` handler registration, cleanup sweep. |
| `artifactsDir` | `<stateDir>/share-artifacts` | Where `<token>/{file, meta.sbmd}` is written. Must be the **exact same path** the renderer's `ARTIFACTS_DIR` env var points at. |
| `raHost` | `"readyapp.player-ready.co.uk"` | Used only to build the display URL `https://<raHost>/share/<token>` — **not validated or read by the renderer**, purely cosmetic on the Switchboard side. |
| `defaultTtlDays` | `30` | Default lifetime if the agent doesn't pass `ttl_days`. |
| `maxBytes` | `26214400` (25 MB) | Size cap. |
| `cleanupIntervalMs` | `86400000` (daily) | Sweep interval. |

### 7.4 Tool wiring

`shim/server.ts` exposes `publish_link` only when `process.env.PUBLISH_LINK === "1"` (hub-injected per `shareLinks.enabled`). Schema: `{ path (required), mode?, title?, scope?, ttl_days? }`. Request/response over the shim socket with a **30-second timeout**; returns `Published: <url>` or `publish failed: <error>`.

### 7.5 Retention / cleanup (`hub/publishCleanup.ts`)

Runs **on the Switchboard hub**, not the renderer. First sweep 30s after boot, then every `cleanupIntervalMs` (default daily):

- Reads every entry's `meta.sbmd`; expired (`expiresAt` in the past) → reaped.
- Unreadable/corrupt entry (no parseable `meta.sbmd`) → reaped only if older than a hard-coded **1 hour** grace period (handles a crash mid-write).
- Malformed (unparsable) `expiresAt` string is **kept, not reaped** — fails closed.
- Abandoned `*.tmp` dirs older than 1 hour are also swept.
- Deletion is `rmSync(dir, {recursive:true, force:true})`, best-effort.

The sweep does `readdirSync(artifactsDir)` and evaluates **every** entry regardless of which agent/hub wrote it — safe for multiple Switchboard instances sharing one `artifactsDir` (see runbook, §8).

### 7.6 Docs in this repo

- `README.md:151-172` — canonical description, "renderer is decoupled and pluggable."
- `docs/superpowers/specs/2026-06-28-publish-link-producer-design.md` — producer design spec, explicitly depends on `ReadyApp/docs/superpowers/specs/2026-06-28-entra-share-links-contract-design.md`.
- `docs/superpowers/plans/2026-06-28-publish-link-producer.md` — implementation plan.

---

## 8. The renderer (lives in the **ReadyApp** repo, not this one)

Nothing in Switchboard serves `/share/<token>` — it's purely a client that constructs the URL string. Renderer facts, for reference:

- Route: `GET /share/:token`, `apps/api/src/routes/share.ts`, registered `apps/api/src/server.ts:1381`.
- **Auth: `requireRole(staffRoles)`**, where `staffRoles = [ADMIN, AP_COORDINATOR, STAFF, TUTOR]` (`apps/api/src/policy.ts:63-68`). **Note:** the design docs specify `requireAuthenticated()`, but the shipped code deliberately uses the stricter `requireRole(staffRoles)` instead (confirmed by a test asserting a PARENT/portal role gets 403) — the docs were never updated to match. Anyone opening a share link needs an existing ReadyApp **staff** Entra account — portal (parent/professional) logins are rejected.
- Reads `ARTIFACTS_DIR` from env; route 404s with `share_links_not_configured` if unset (ships dark by design).
- `loadArtifact()` (`apps/api/src/lib/shareArtifact.ts`): token regex `^[0-9A-Za-z]{16,}$`, realpath containment, malformed `expiresAt` fails closed (422), expired → 410.
- Mode dispatch: `download` → `Content-Disposition: attachment`; `page` → live HTML in a CSP `sandbox allow-scripts`; `view` → branches by `contentType` — PDF inline, markdown via `marked.parse()`, CSV via a naive hand-rolled `<table>` (no quoted-field handling), other text via escaped `<pre>`, **anything else (including DOCX) falls back to `download`** — there is no dedicated DOCX or HTML-demo viewer despite that being how the feature was informally described; only PDF/MD/CSV/plain-text get a `view` rendering, everything else just downloads.
- `ARTIFACTS_DIR` has no in-repo config — it's set directly in `/srv/readyapp/env/api.env` on the VPS and applied with `pm2 reload api --update-env`. Current production value: `/srv/share-artifacts` (per prior deploy).

---

## 9. Deployment / runtime

`package.json` scripts: `hub` → `bun run hub/index.ts` (the only entrypoint, no separate launch step — persistent agents spawn at hub boot, ephemeral ones on demand), `test` → `bun test`, `typecheck` → `tsc --noEmit`.

README.md:44-97 setup (dev/manual-run, **not** a production process-manager runbook):

1. Install Bun.
2. `mkdir -p ~/.switchboard`; write `DISCORD_BOT_TOKEN=...` to `~/.switchboard/.env`, `chmod 600`.
3. `cp config/agents.example.json config/agents.json`.
4. Set `guildIds` in `hub.config.json`; enable Discord "Server Members" + "Message Content" privileged intents.
5. `bun run hub`.
6. First DM from a new user → pairing code → `bun run scripts/pair.ts <code>`.

No pm2/systemd/Docker config is checked into this repo. In production, the hub runs under **pm2** (process name `switchboard-hub`, per prior ops notes) — that supervision setup is VPS-side, not repo-tracked.
