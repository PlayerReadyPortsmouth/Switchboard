# Cross-VPS Agent Liaison — Design

**Date:** 2026-06-30
**Status:** Approved design; pre-implementation.
**Component:** switchboard engine (public). Deployment-specific peer addresses/secrets live in the operator's private config layer, never here.

## Problem

Each VPS runs its own independent switchboard **hub** (its own bot token, guild,
agent registry, and `stateDir`). Today an agent can only talk *back to its own hub*
through the MCP shim — there is **no agent→agent transport at all**, not even between
two agents on the same hub. We want agents on different VPSs to liaise: an agent on
hub A can address and exchange messages with a named agent on hub B.

The VPSs already share a **WireGuard** bridge, so private L3 reachability and on-the-wire
encryption are solved. What is missing is the **app-level liaison layer**: addressing,
authentication, a request/reply + notify protocol, resilience, and always-on visibility.

## Scope (locked 2026-06-30)

- **Topology:** 2 hubs currently; a **static peer registry** in config (no dynamic
  discovery in v1).
- **Comms model:** **both** fire-and-forget notify **and** request/reply.
- **Addressing:** target a specific remote agent by `peer:agent`.
- **Auth:** **app-level HMAC** (per-peer shared secret) layered on top of WireGuard
  (defence in depth).
- **Visibility:** **silent by default** (no Discord noise); optional Discord channel
  mirror; every exchange **always** recorded. The hub **already has a persisted
  `AuditLog`** (`<stateDir>/audit.jsonl`, rotated, `kind`-discriminated) — but it is
  **metadata-only by invariant** (`types.ts`: "never message bodies; secrets redacted").
  So liaison records split: **metadata** → the existing `AuditLog` as a new
  `kind:"liaison"`; **full message bodies** → a *separate* `liaison.log.jsonl`
  transcript. This keeps the audit invariant intact while giving the (future) web UI the
  full text it needs. The web UI itself is out of scope here; we define + emit its data.

### Non-goals (v1)

- Dynamic peer discovery / gossip.
- A shared message broker (rejected — see Alternatives).
- Building the web UI (separate future work; we only define + emit its data). The hub's
  existing `!audit` command already renders the metadata ledger and will show liaison
  metadata for free.
- Cross-hub routing of arbitrary Discord traffic — this is agent↔agent liaison only.

## Reuse of existing subsystems

This feature deliberately builds on machinery the hub already has, rather than parallel
implementations:

- **`verifySignature(rawBody, header, secret)`** (`webhookListener.ts`) — the HMAC scheme
  for peer auth is the exact one webhooks already use.
- **`ConsultRegistry`** (`consult.ts`) — the same-hub `ask_agent` request/reply engine
  (virtual-channel pending entries, single-shot `settle`, `sweepExpired` timeout, and
  `consultAnswerFromReply` which serializes a card answer to title+body). `ask_peer` is a
  **cross-hub consult**: the outbound side opens a pending entry keyed by `corrId` whose
  `resolve` writes the tool result back to the asking agent; the inbound side runs a
  *real local consult* against the named local agent and POSTs its answer back.
- **`deliverToAgent(agentName, channelId, idTag, content)`** (`index.ts`) — the canonical
  "inject a message to a named agent, bypassing the router" primitive; webhooks already
  use it. Peer `notify` and the inbound leg of `ask` deliver through it.
- **`AuditLog.record({kind, actor, action, ...})`** — metadata ledger; add `kind:"liaison"`.
- **Shim env-flag tool gating** (`buildShimMcpConfig`) — tools are exposed per-agent via
  env flags (`CONSULT=1`, `ATTACH_FILES=1`, …). Peer tools gate behind a new `PEERING=1`.
- **`access.consultableBy`** per-agent allowlist — mirror it as `access.peerableBy` for
  which remote callers may reach a given local agent.

## Approach

**Chosen: HTTP peer endpoint (Approach A)** — reuse the hub's existing HMAC-verified
HTTP listener (`webhookListener.ts`) and its orchestrator dispatch (`deliverToAgent`),
adding a `/peer/*` route family, an outbound poster with a small durable spool, new shim
tools, and a peer registry in config.

Two refinements borrow the good parts of the alternatives without their weight:

1. **Async "ask" via callback, not a held connection.** `ask_peer` sends the request
   plus a `replyTo` callback URL; the remote hub ACKs `202` instantly, dispatches to its
   agent, and POSTs the answer *back* when that agent's turn completes. No HTTP connection
   is held for the (potentially multi-minute) remote turn.
2. **Durable notify spool.** Outbound notifies queue in `stateDir` with bounded
   retry/backoff → dead-letter, so a momentarily-down peer does not silently drop a message.
   Not a broker — just resilience.

### Alternatives considered

- **B — Persistent hub↔hub WebSocket link.** Lower latency and natural async, but
  reconnect/backoff/heartbeat/multiplexing/correlation is a lot of moving parts and test
  surface for **2 peers at low volume**. Rejected as overkill for v1.
- **C — Shared message bus (Redis/NATS over WireGuard).** Durable and replayable, but
  introduces a **shared broker both VPSs depend on** — couples two systems meant to be
  independent, raises a "whose VPS hosts it / what happens when it's down" question, and
  leaks infra into the public engine. Rejected.

## Design

### Concepts & addressing

- **Peer** — another switchboard hub at a known WireGuard address; entry in the static
  config registry.
- **Address** — `peer:agent` (e.g. `peer-staging:agent-b`). The `peer` half resolves
  locally via config (→ baseUrl + secret); the `agent` half resolves on the **remote**
  hub against its existing agent registry. Unknown peer or unknown agent → structured error.
- **Verbs:**
  - `notify_peer(target, text)` — fire-and-forget; spooled + retried; no reply.
  - `ask_peer(target, text, timeoutMs?)` — request/reply; resolves with the remote
    agent's reply text or a structured timeout/error.

### Config

Engine stays generic. `hub.config.json` gains a `peering` block (placeholder example
ships in the engine; real values live in the operator's private config):

```jsonc
"peering": {
  "enabled": false,                 // ships dark; flip per-hub
  "listenPath": "/peer",            // mounted on the EXISTING webhookPort listener — no new WG port
  "selfName": "peer-prod",         // this hub's identity to peers
  "askTimeoutMs": 300000,           // default ask_peer timeout (5 min)
  "mirrorChannelId": null,          // optional Discord mirror channel; null = silent
  "dedupeWindowMs": 600000,         // corrId/ts replay-dedupe window (10 min)
  "maxClockSkewMs": 120000,         // reject stale/future ts beyond this
  "ratePerPeerPerMin": 120,         // optional inbound rate cap per peer; 0 = off
  "notifyRetry": { "maxAttempts": 5, "baseDelayMs": 2000 },
  "peers": [
    { "name": "peer-staging", "baseUrl": "http://127.0.0.1:8787", "secretEnv": "PEER_STAGING_SECRET" }
  ]
}
```

- **Per-peer** shared secret in env (`secretEnv`), never a single global secret and never
  committed.
- `selfName` tells the remote side who is calling so it can pick the right secret for the
  return leg.
- Reuses `webhookPort`; no extra port to expose across WireGuard.

### Wire protocol

HMAC-authenticated HTTP, reusing the webhook listener's header scheme. Three inbound
routes under `listenPath`:

| Route | Body | Response |
|---|---|---|
| `POST /peer/notify` | `{ from, to, corrId, kind:"notify", text, ts }` | `200 {ok:true}` |
| `POST /peer/ask`    | `{ from, to, corrId, kind:"ask", text, replyTo, ts }` | `202 {accepted:true}` (immediate) |
| `POST /peer/reply`  | `{ from, to, corrId, kind:"reply", text, ts }` | `200 {ok:true}` |

Headers on every request:

- `X-Switchboard-Peer: <selfName of sender>`
- `X-Switchboard-Signature: sha256=<hmac(peerSecret, rawBody)>`

Verification: look up the secret for the **named** sending peer; recompute HMAC over the
raw body; constant-time compare. Unknown peer name or bad signature → `401` +
`liaison.rejected` event. `corrId` (uuid) + `ts` give replay protection: reject a `corrId`
already seen within `dedupeWindowMs`; reject `ts` outside `maxClockSkewMs`.

### Flow — notify

1. Agent calls `notify_peer("peer-staging:agent-b", text)`. Shim → hub.
2. Hub resolves `peer:agent` → peer baseUrl + secret. Unknown → structured error (no spool).
3. Append `liaison.out.notify`. Enqueue to the outbound spool (file under `stateDir`).
4. Spool worker POSTs `/peer/notify` with HMAC. `2xx` → mark sent. Failure → retry with
   exponential backoff up to `maxAttempts`, then dead-letter + `liaison.deadletter`.
5. Remote hub verifies → appends `liaison.in.notify` → dispatches `text` to local agent
   `to` via the orchestrator as a normal inbound, **tagged `source=peer`** (so the agent
   knows the provenance). No reply path.

### Flow — ask

1. Agent calls `ask_peer("peer-staging:agent-b", text)`. Shim → hub.
2. Hub resolves target, mints `corrId`, registers a pending promise in an in-memory
   `pendingAsks` map keyed by `corrId` with an `askTimeoutMs` timer. Append `liaison.out.ask`.
3. Hub POSTs `/peer/ask` with `replyTo = {selfBaseUrl}/peer/reply` + HMAC; expects `202`.
   A non-202 / connection error fails the tool call fast with a structured error.
4. Remote hub verifies → appends `liaison.in.ask` → **opens a real local consult**
   (`ConsultRegistry.open`) with the named local agent as target and a `resolve` that
   POSTs the answer to `replyTo`; delivers `text` to that agent on the consult's virtual
   channel via `deliverToAgent`. When the agent answers, the **existing** consult-settle
   path (`onAgentReply` → `consultRegistry.settle`, using `consultAnswerFromReply` which
   serializes a card answer to title+body) fires the `resolve` → the remote hub POSTs the
   answer to `replyTo` `/peer/reply` (HMAC) → appends `liaison.out.reply`.
5. Caller hub's `/peer/reply` verifies → matches `corrId` in the pending-ask registry →
   resolves it → the `ask_peer` tool returns the reply text to the asking agent. Append
   `liaison.in.reply`. Clear the timer.
6. **Timeout:** the remote-side local consult has its own `sweepExpired` timeout (returns
   a timeout note, still POSTed back); the caller-side pending-ask also times out after
   `askTimeoutMs` → resolves the tool with a structured timeout error +
   `liaison.ask.timeout`. A reply arriving after the caller timed out is logged + dropped.

**Resolved (was flagged):** no fragile turn-correlation and **no `reply_peer` tool** are
needed. Because the remote side runs a *real local consult*, the existing
`consultAnswerFromReply` already captures the agent's answer (including when it answers
with a card) and the existing settle path returns it — we simply POST that answer back.
The stream-json transport's card-suppression of end-of-turn text (`streamJson.ts:205`) is
exactly why we reuse the consult path instead of trying to scrape the result turn.

### Visibility: two records per event

Every liaison event is recorded in **two** places, to honor the engine's existing
metadata-only audit invariant while still giving the future web UI full message text:

**1. Metadata → the existing `AuditLog`** as `kind:"liaison"` (no bodies; secrets
redacted; threads via `corr=corrId`):

```jsonc
{ "kind":"liaison", "actor":"agent:agent-a", "action":"notify|ask|reply|deadletter|timeout|rejected",
  "target":"peer-staging:agent-b", "outcome":"ok|deny|error|pending", "corr":"<corrId>",
  "detail": { "dir":"out|in", "bytes":1234 } }
```

**2. Full transcript → a separate `{stateDir}/liaison.log.jsonl`** (the surface the web
UI consumes for bodies), append-only, schema `v:1`:

```jsonc
{
  "v": 1,
  "ts": "2026-06-30T12:00:00.000Z",
  "dir": "out" | "in",
  "kind": "notify" | "ask" | "reply" | "deadletter" | "timeout" | "rejected",
  "corrId": "…",
  "peer": "peer-staging",
  "localAgent": "agent-a",        // the agent on THIS hub (sender for out, recipient for in)
  "remoteAgent": "agent-b",    // the agent on the peer hub
  "text": "…",                // full message body — lives here, NOT in AuditLog
  "bytes": 1234,
  "ok": true,
  "error": null
}
```

- Bodies live **only** in `liaison.log.jsonl` (in `stateDir`, the private home of session
  files + sockets — same protection). The metadata-only `AuditLog` is never given bodies,
  preserving its invariant.
- Transcript schema is **versioned** (`v:1`) so the UI can evolve against it.
- If `mirrorChannelId` is set, additionally post a one-line embed per exchange to that
  Discord channel. Off (null) by default → silent.

### Shim tools

Registered in `shim/server.ts` alongside `post_card` etc., **only present when
`peering.enabled`** on this hub and only able to target configured peers:

- `notify_peer(target: string, text: string)` → `{ queued: true, corrId }`
- `ask_peer(target: string, text: string, timeoutMs?: number)`
  → `{ text }` on success, or `{ error: true, reason: "timeout"|"rejected"|"unknown_peer"|"unknown_agent"|"peer_unreachable" }`

(No `reply_peer` tool — the remote side reuses the local consult path to capture answers.)

### Failure modes & guards

- Peer down → notify spools + retries then dead-letters; ask fast-fails at POST or
  eventually times out.
- Unknown peer / unknown agent → structured error, no spool.
- Bad/missing HMAC or unknown peer name inbound → `401` + `liaison.rejected`.
- Replay → dedupe by `corrId` within `dedupeWindowMs`; stale `ts` rejected.
- Storm guard → optional `ratePerPeerPerMin` inbound cap per peer; over cap → reject + log.
- `enabled:false` (default) → shim tools absent and `/peer/*` routes return `404`. Ships
  dark; enabled per-hub.

## Testing

`bun test`, tests beside source; all unit-level against an **in-process fake peer**
(an ephemeral HTTP server) — no real second VPS required for CI:

- HMAC sign/verify roundtrip; reject bad signature, unknown peer, stale `ts`.
- Notify spool: success; retry-then-success; dead-letter after `maxAttempts`.
- Ask: happy path (`corrId` match resolves the promise); timeout path; late-reply dropped.
- Route handlers: `/peer/ask` returns `202`; dispatch invoked with a `source=peer`-tagged
  inbound; `/peer/reply` resolves the right pending entry.
- Replay dedupe window; inbound rate cap.
- Config gating: `peering.enabled:false` → tools and routes inert.

Real cross-VPS verification via a manual `scripts/smoke-peer.ts` (mirrors the existing
`scripts/smoke-streamjson.ts` pattern): point two local hub configs at each other over
loopback and exercise notify + ask end-to-end.

`bun run typecheck` must be clean before PR.

## Rollout

- **Flag:** `peering.enabled` (config, per-hub). Ships dark; enabled on each hub
  independently once its peers + secrets are configured.
- **Rollback:** set `peering.enabled:false` on the affected hub (no global restart), or
  revert the feature SHA.

## Public-repo hygiene

switchboard is **public**. The engine ships only generic placeholders (`peer-staging`,
`127.0.0.1`, `PEER_*_SECRET`). Real peer names, WireGuard IPs, and secrets live in
the operator's private config / env and are never committed to this repo.

## Open questions

All resolved during planning by reading the code:

1. **Ask turn-correlation** — RESOLVED: reuse the existing `ConsultRegistry` on the remote
   side (no `reply_peer` tool, no turn scraping). See the ask flow above.
2. **Audit bodies** — RESOLVED: the existing `AuditLog` is metadata-only by invariant, so
   bodies go in a *separate* `liaison.log.jsonl`; metadata goes in `AuditLog`
   (`kind:"liaison"`).
