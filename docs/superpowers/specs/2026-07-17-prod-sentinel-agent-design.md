# prod-sentinel — production error triage agent

**Date:** 2026-07-17
**Status:** Approved (brainstorm)
**Scope:** A new Switchboard agent that turns a ReadyApp prod error into a deduped, root-caused, triaged Bug-board card.
**Repos:** `Switchboard` (agent config + prompt), `ReadyApp` (`apps/api` error-emit, behind a flag)

## Purpose & success criteria

Today a prod incident is noticed by a human, then manually triaged and root-caused. `prod-sentinel`
collapses that: an unhandled server error becomes, within minutes, a **triaged Bug-board card**
carrying the stack trace, a suspected file/cause, the deployed commit, and a severity — with a
Discord ping only when it's high-severity.

**Success:** a real 5xx in prod lands as exactly one actionable card (repeats bump a count, not spawn
duplicates); the card's suspected-cause is right often enough to save the triage step; normal ops
(4xx, expected errors, quiet periods) produce no noise. The agent never edits code.

## Decisions (from brainstorm)

- **Input:** a ReadyApp `api` error webhook (not GlitchTip, not log-tailing). GlitchTip/Sentry exists
  in code but `SENTRY_DSN` is unset in prod (no-op), so no aggregated signal exists today; the webhook
  is the MVP-fast path and reuses Switchboard's proven webhook→spawn→card pattern (pr-review).
- **Trigger:** 5xx / unhandled exceptions only (4xx ignored), **deduped by error signature**.
- **Output:** diagnose + file a triaged Bug-board card; high-severity also pings Discord. **Read-only** —
  no code changes, no fix branches (that is an explicit phase 2).
- **Scope:** ReadyApp `api` only for MVP. **One persistent agent** (not a router+worker split).
  **Model:** Opus 4.8. **Channel:** a new `#prod-incidents`.

## Architecture

```
ReadyApp api error path (5xx/unhandled)
  └─ reportProdError()  [flag-gated, fail-open, source-side dedup+cooldown, HMAC-signed]
       └─ POST /hooks/prod-error  ──▶  Switchboard hub webhookListener
             └─ deliver "PROD_ERROR <json>" to agent `prod-sentinel`  (#prod-incidents)
                   └─ prod-sentinel (persistent, Opus, read-only ReadyApp checkout):
                        1. board-check dedup  2. root-cause  3. file/bump Bug-board card  4. hi-sev → ping
```

### Component 1 — ReadyApp `api` error-emit (`apps/api/src/lib/prodSentinel.ts`, new)

- **Hook point:** the api's Fastify `setErrorHandler` for 5xx responses, plus the existing
  `uncaughtException`/`unhandledRejection` crash handlers in `server.ts` (which already call
  `Sentry.captureException`). Add a `reportProdError(err, context)` call alongside — it must **never
  throw and never block** the request/response path (wrap in try/catch, fire-and-forget).
- **Filter:** only report when the response status is ≥ 500 or the error is an unhandled
  exception/rejection. Skip anything < 500 (validation, auth, not-found) and skip a small env-configurable
  denylist of known-benign error names if needed.
- **Signature:** `sha256(normalizedMessage + "\n" + topAppStackFrame)` truncated to 16 hex chars, where
  `normalizedMessage` strips volatile substrings (UUIDs, numbers, quoted values) and `topAppStackFrame`
  is the first stack frame under `apps/` (ignoring node_modules). This is what dedup keys on.
- **Source-side dedup + cooldown:** keep an in-process LRU (`Map` with timestamp) of signatures seen;
  emit at most one POST per signature per **cooldown window (default 10 min, env-tunable)**, carrying the
  occurrence count accumulated during the window. Prevents an error storm from a single deploy becoming a
  webhook/agent-spawn storm. (In-process is sufficient for MVP; a Redis-backed counter is the multi-instance
  upgrade, noted in Future work.)
- **Payload (POST body, JSON):**
  ```json
  {
    "signature": "a1b2c3d4e5f60718",
    "message": "Cannot read properties of undefined (reading 'id')",
    "errorName": "TypeError",
    "stack": ["<top N app frames, node_modules elided>"],
    "route": "POST /sessions/:id/attendance",
    "statusCode": 500,
    "release": "<GIT_SHA>",
    "environment": "production",
    "count": 7,
    "firstSeen": "2026-07-17T21:50:09Z",
    "lastSeen": "2026-07-17T21:58:41Z"
  }
  ```
- **Signing:** HMAC-SHA256 of the raw body with `PROD_SENTINEL_WEBHOOK_SECRET`, sent as
  `X-Switchboard-Signature: sha256=<hex>` (the header/scheme the hub's webhookListener already verifies).
- **Flag:** gated by an `AppSetting` runtime flag `prod_sentinel_emit` (per ReadyApp's feature-flag rule),
  **fail-closed to off**, with a per-user/global canary allowlist (empty = full). The api reads it via the
  standard 60s-TTL `AppSetting` cache. When off, `reportProdError` is a no-op → byte-identical behaviour to
  today. Deploys to `live` dark.

### Component 2 — Switchboard wiring (config-only)

- **`config/hub.config.json`** — add a webhook route:
  ```json
  { "path": "/hooks/prod-error", "secretEnv": "PROD_SENTINEL_WEBHOOK_SECRET",
    "agent": "prod-sentinel", "channelId": "<#prod-incidents id>", "prefix": "PROD_ERROR" }
  ```
  (Secret value lives in `~/.switchboard/.env`, never in config.)
- **`config/agents.json`** — add the agent:
  ```json
  "prod-sentinel": {
    "emoji": "🚨",
    "description": "watches ReadyApp prod errors; root-causes and files triaged Bug-board cards",
    "mode": "persistent",
    "access": { "roles": ["dev", "admin"], "users": ["<Aurora user id, canary>"] },
    "runtime": {
      "cwd": "/srv/readyapp",
      "model": "claude-opus-4-8",
      "allowedTools": ["Read", "Grep", "Glob", "Bash"],
      "appendSystemPrompt": "<the SOP in Component 3>",
      "sessionGovernor": { "enabled": true, "softPct": 0.75, "hardPct": 0.9, "strategy": "restart" }
    }
  }
  ```
  - `cwd: /srv/readyapp` is the **live deploy checkout, read-only for investigation** — the agent reads
    source at the exact deployed `GIT_SHA` (matches `release` in the payload). It must never write there
    (enforced by SOP + read-only toolset; no `Edit`/`Write`). The board/Discord-card tools come from the
    per-agent shim + the ReadyApp MCP, not the filesystem.
  - Persistent (not ephemeral) so it owns light dedup state across events and stays warm; a router+ephemeral-worker
    split (mirroring pr-review) is the scale-up path if error volume ever outgrows one turn queue (Future work).

### Component 3 — prod-sentinel behaviour (its `appendSystemPrompt` SOP)

On each `PROD_ERROR <json>` message:
1. **Parse** the payload. `SIG = .signature`.
2. **Board-check dedup:** search the ReadyApp **Bug fixes** board for an open card whose body contains the
   marker `sentinel-sig:SIG`. If found → add a comment noting the new occurrence window + updated `count`/
   `lastSeen`, and **stop** (no new card, no ping unless it just crossed into high-severity).
3. **Root-cause:** open the top app stack frame's `file:line` in `/srv/readyapp`, read the surrounding code
   and its callers, grep for the failing pattern, and form a one-paragraph suspected-cause hypothesis. Note
   the deployed `release` so the reader can correlate with a recent deploy.
4. **File a card** on the **Bug fixes** board:
   - **Title:** concise error summary + route, e.g. `500 POST /sessions/:id/attendance — TypeError reading 'id'`.
   - **Body:** the suspected cause hypothesis; the `file:line`; the stack (top app frames); affected route +
     method; `release` (GIT_SHA); `count`, `firstSeen`, `lastSeen`; and a hidden dedup marker line
     `sentinel-sig:SIG`.
   - **Severity** (see rubric) as a label.
5. **High-severity only → Discord ping** in `#prod-incidents` (`@` Aurora), one line linking the card. Medium/low
   file the card silently.

**Severity rubric:** `high` = affects money/data-integrity/auth/safeguarding, or a broad crash loop
(high `count` fast); `medium` = a real 500 on a normal flow, contained; `low` = rare/edge, single occurrence,
non-critical path.

## Testing

- **ReadyApp (`apps/api`, vitest):** `reportProdError` fires the webhook for a 5xx / unhandled error and
  **not** for a 4xx; respects the cooldown (second identical signature within the window does not re-POST,
  count increments); computes a stable signature (volatile substrings normalized out); is HMAC-signed;
  **fail-open** (a throwing/unreachable webhook never propagates into the request path); and is a **no-op when
  the flag is off**. Colocated `prodSentinel.test.ts`, injected fetch/clock per the api's test conventions.
- **Switchboard:** config-only (webhook routing is already covered by the hub's webhook tests). The agent
  behaviour (LLM) is verified by a **live smoke**: POST a synthetic signed `PROD_ERROR` to `/hooks/prod-error`
  on a running hub and confirm the agent files one card with the right shape, and that a second identical POST
  comments instead of duplicating.

## Rollout

1. Ship the ReadyApp emit to `live` with `prod_sentinel_emit` **off** (dark; byte-identical to today).
2. Add the Switchboard webhook + `prod-sentinel` agent (`enabled`, canary `access.users = [Aurora]`);
   set `PROD_SENTINEL_WEBHOOK_SECRET` in both `~/.switchboard/.env` and ReadyApp `api.env`; create
   `#prod-incidents`.
3. Live-smoke with a synthetic error. Then flip `prod_sentinel_emit` on (canary), watch the next real 500
   land end-to-end, and tune the cooldown window + severity rubric.
4. Widen the flag once signal quality is confirmed.

## Out of scope / Future work

- **Phase 2 — auto-fix:** for clear-cut cases, also push a fix branch → flows into the existing pr-review
  pipeline (review card + human merge gate). Deliberately excluded from MVP until diagnosis quality is proven.
- **More services:** hub, portal (Astro), `ai-service` — same `reportProdError` pattern, added after `api`.
- **GlitchTip:** if/when self-hosted GlitchTip is actually stood up (`SENTRY_DSN` set), prod-sentinel can be
  fed from its richer, cross-service, release-tagged issue stream instead of (or alongside) the api webhook.
- **Router + ephemeral worker split** (mirroring pr-review) if error volume ever outgrows a single persistent
  turn queue.
- **Redis-backed dedup** for multi-instance api (the in-process LRU only dedups per api process).
