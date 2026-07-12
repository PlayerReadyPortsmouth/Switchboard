# Switchboard

One Discord bot, many Claude Code agents.

Switchboard extends the official Claude Code Discord plugin (which is strictly **1 bot ↔ 1 session**) into a **hub** that fans a single Discord bot out to many Claude Code agents — each with its own working directory, model, tools, and MCP setup. A small Claude router (`claude -p --model claude-haiku-4-5`, reusing your Claude Code auth) decides which agent each message reaches, conversations stay stickily bound to an agent with confident auto-switching, and access is gated per Discord **role and user ID**.

- **Persistent agents** — long-lived `claude -p --input-format stream-json` sessions (research, coding) the hub owns directly: it writes inbound messages to the agent's stdin and reads replies from its stdout. Rich interactions — cards, **modal forms**, reactions, **file attachments**, **share links**, memory, inter-agent consult — come through a thin MCP **shim** (see [Rich interactions](#rich-interactions--cards-modals-files--links)).
- **Ephemeral agents** — the same stream-json session spawned on demand per task (e.g. via a spawn trigger), torn down when it exits.

On top of the router, the hub adds a small set of **config-driven integration primitives** — all optional, all generic, all defined as arrays in `config/hub.config.json`:

- **Webhook → agent cards** — one HTTP listener (`webhookPort`) fans out by path; each route HMAC-verifies an inbound POST and delivers the body to an agent, which can reply with a rich **card** (embed + buttons).
- **Gated button actions** — agents post cards whose buttons route back to the originating agent when clicked (the `NotifyRouter`); only base-gate-allowlisted users may press buttons.
- **Approver-only deploy gate** — buttons in the `deploy:` namespace can only be pressed by a single configured approver (`deployApproverUserId`).
- **Daily scheduler** — fire a message to an agent at a chosen UTC hour, once per day.
- **Config-driven ephemeral spawning** — when any agent's outbound text matches a configured regex, spawn an ephemeral agent with an interpolated task (and an optional setup shell step, e.g. to create a worktree).

On top of routing, the hub also grows **intelligence with minimal human babysitting**:

- **Recent-message context** — a per-conversation cache the hub injects (where relevant) so a cold/just-switched agent is caught up on what was just said.
- **Memory vault** — an Obsidian-style `.md` note vault (global / per-user / per-agent / per-channel) that agents read via relevant-context injection and write via `remember`/`recall` tools, plus a background **distiller** that turns idle conversations into notes automatically. Retrieval is **fully local** (an in-process embedding model for recall + a small Claude *librarian* for precision) — no extra API key.
- **Overseer** — an opt-in "outer agent" that judges each finished turn against the goal and keeps **prodding the agent until the task is actually done**, bounded by hard iteration/wallclock caps.

> **Status:** implemented. All unit tests pass (`bun test`) and `bun run typecheck` is clean. The agent transport runs on the documented stream-json protocol (the earlier experimental `--channels` mechanism was removed when current Claude CLIs dropped its `command:` form); the stdin→reply + MCP-card round-trip is proven against a real `claude` via `scripts/smoke-streamjson.ts`. It also runs end-to-end as a live bot in a guild (in production).

## Why a hub?

Discord allows only one gateway connection per bot token, so you can't run N agent sessions on one token. Switchboard runs a single **hub** process that owns the token and gateway and routes each message to an agent behind it.

- The **hub** owns the bot token + Discord gateway, runs the base gate (role/user access), the Haiku router, sticky bindings, and the orchestrator that dispatches to agents.
- **Persistent** agents are long-lived `claude -p --input-format stream-json` processes the hub spawns and owns: inbound → the agent's stdin, replies ← its stdout. The agent's MCP **shim** (registered via `--mcp-config`) relays `post_card`/`react`/`edit` back to the hub over a local socket.
- **Ephemeral** agents are the same kind of session spawned on demand (e.g. by a spawn trigger), kept alive for any card → button-click loop, and torn down when the process exits.

## Layout

```
hub/         the one process that owns the bot token + gateway + router
shim/        per-agent MCP server exposing the agent toolset — cards/modals, react/edit, memory, files, links (hub ↔ agent over a socket)
config/      hub.config.json + agents.json (the agent registry)
scripts/     smoke-streamjson.ts — real-CLI transport check; pair.ts — approve a paired user
docs/        superpowers/ spec + plan
```

## Setup

**Prerequisites**

- [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
- The `claude` CLI on your `PATH` (the hub reuses your existing Claude Code auth).

**Steps**

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create the state dir and your bot token (kept out of git):

   ```bash
   mkdir -p ~/.switchboard
   printf 'DISCORD_BOT_TOKEN=...\n' > ~/.switchboard/.env
   chmod 600 ~/.switchboard/.env
   ```

3. **Copy the example registry** — this is required. `hub/config.ts` reads `config/agents.json`, which is git-ignored and not shipped:

   ```bash
   cp config/agents.example.json config/agents.json
   ```

   Then edit `config/agents.json` to define your agents (cwd, model, mode, tools, role/user access).

4. Set `guildIds` in `config/hub.config.json` to your server's guild id (needed for role resolution). On the Discord bot, enable the **Server Members** and **Message Content** privileged intents.

5. Run the hub:

   ```bash
   bun run hub
   ```

6. **Pairing.** The first DM from a new user returns a pairing **code**. Approve it from the host machine:

   ```bash
   bun run scripts/pair.ts <code>
   ```

   The hub then DMs the user a confirmation that they're paired.

7. **Agents start themselves.** The hub spawns each persistent agent (from
   `config/agents.json`) at boot and spawns ephemeral agents on demand — there is
   no separate launch step. To verify the agent transport against a real `claude`:

   ```bash
   bun run scripts/smoke-streamjson.ts   # expects: reply + card round-trip
   ```

## Integration config

These optional arrays in `config/hub.config.json` wire the hub to the outside world. See `config/hub.config.json` for a fully-placeholder example.

- **`webhooks[]`** — `{ path, secretEnv, agent, channelId, prefix? }`. A single HTTP listener on `webhookPort` routes by `path`; each POST is HMAC-verified against `process.env[secretEnv]` (header `X-Switchboard-Signature: sha256=…`) and the body is delivered as `"{prefix} {rawBody}"` to `agent`, scoped to `channelId`.
- **`schedules[]`** — `{ id, hourUtc, agent, channelId, message }`. Delivers `message` to `agent`@`channelId` daily at `hourUtc` (UTC), once per `id` per day.
- **`commands[]`** — `{ match, agent, channelId, message, allowlistOnly? }`. An inbound chat message whose trimmed content equals `match` delivers `message` to `agent`@`channelId`; if `allowlistOnly`, only base-gate-allowlisted users may trigger it. *(Tier A: keyword → agent.)*
- **`directCommands[]`** — `{ match, exec, render?, template?, cardTitle?, formatAgent?, allowlistOnly? }`. A keyword (exact, or a prefix with trailing args → `$args`/`$1`…) runs dedicated code — `exec: { type: "shell", command }` or `{ type: "http", url, method?, headers?, secretEnv?, bodyTemplate? }` — and formats the result with no model in the loop: `template` interpolates `$args`/`$N` and `{{json.path}}`, rendered as `text` or a `card`. Set `formatAgent` to instead hand the raw result to an agent to format/reply (the Tier B+A bridge). *(Tier B: keyword → dedicated code → formatted output.)*
- **`spawnTriggers[]`** — `{ pattern, agent, taskTemplate, setupCommand?, teardownCommand? }`. When any agent's outbound text matches the regex `pattern`, an ephemeral `agent` is spawned with task = `taskTemplate` interpolated (`$1`,`$2`… = capture groups, `$jobId` = a generated id). If `setupCommand` is set, it runs first as a shell command (same interpolation) — e.g. to create a worktree; if `teardownCommand` is set, it runs after the spawned agent's process exits — e.g. to remove that worktree.
- **`outboundWebhooks[]`** — `{ id, url, pattern?, secretEnv?, method?, headers?, template?, consume?, requireApproval? }`. The hub POSTs to external systems. A route fires three ways: agent outbound text matching `pattern` (`$1`,`$2`… interpolate into `template`); the **`post_webhook`** MCP tool, which an agent calls with a route **`id`** (never a URL — the hub holds the destination + secret, closing the SSRF/exfiltration hole); or a hub **event** whose name equals a route `id` (e.g. `schedule.fired`). Delivery is signed (`X-Switchboard-Signature` over `<ts>.<body>` when `secretEnv` is set), retried with backoff, idempotency-keyed, logged to `<stateDir>/outbound-log.jsonl`, and dead-lettered to `<stateDir>/outbound-dead.jsonl` on exhaustion. Optional `outboundAllowedHosts[]` (destination allowlist) and `outboundRetries` (default 3). A route with `requireApproval: true` is gated behind a human Approve/Deny card when the `approvals` subsystem is on (see below).
- **`audit`** — `{ enabled?, file?, kinds?, redactEnv?, maxBytes?, keepFiles? }`. One append-only ledger (`<stateDir>/audit.jsonl`) of every governed effect — `route`, `spawn`, `exec`, `outbound`, `session`, `access`, `event`, `approval`, `consult` (and `card` as that lands), each row `{ ts, kind, actor, action, target?, chat?, outcome, detail?, cost?, corr? }`. **Metadata only** (no message bodies); secrets in `detail` are redacted. Off unless `enabled`; a per-agent `runtime.audit: false` opts an agent out. Optional `kinds[]` allowlist, `redactEnv[]` extra secrets, and size-based rotation (`maxBytes` → `audit-<ts>.jsonl`, oldest pruned to `keepFiles`). Operators query it with **`!audit [kind|actor <a>|chat <c>] [n]`** and **`!audit cost`** (a rollup).
- **`deployApproverUserId`** — only this Discord user may press buttons in the `deploy:` namespace.
- **`approvals`** — `{ enabled?, channelId?, approvers?, ttlMs? }`. Human-in-the-loop gate: a `requireApproval` effect (today, an `outboundWebhooks[]` route) **parks instead of firing** and posts an **Approve / Deny** card; only a configured `approver` (default the deploy approver) may resolve it, and the effect runs **only on grant** — deny, a `ttlMs` timeout, or a hub restart all leave it unfired (fail-closed). Every step (`request`/`grant`/`deny`/`expire`) is an `approval` audit event threaded by `corr`. Off unless `enabled`; with it off, `requireApproval` is inert.
- **`consult`** — `{ enabled?, timeoutMs? }`. Inter-agent consult: exposes an **`ask_agent`** MCP tool so one agent can ask another (by name) a question and get its reply back. An agent is consultable only if its `access.consultableBy` lists the requester (or `"*"`); a self-consult is always denied. Each consult is a `consult` audit event. Off unless `enabled` (with it off the tool isn't even exposed).

### Cross-VPS peering

A hub can reach agents running on a **separate hub instance** (on another host or loopback) via the `peering` config block. Off by default (`enabled: false`); when on, the hub registers `/peer/notify`, `/peer/ask`, and `/peer/reply` HTTP routes and exposes two additional MCP tools to agents.

**Config block** (`config/hub.config.json`):

```jsonc
"peering": {
  "enabled": false,
  "listenPath": "/peer",          // route prefix for inbound peer traffic
  "selfName": "hub-a",            // this hub's identity as seen by peers
  "selfBaseUrl": "http://127.0.0.1:8787",  // reachable base URL for this hub (used as ask replyTo)
  "askTimeoutMs": 300000,         // how long to wait for a reply to an ask (ms)
  "mirrorChannelId": null,        // optional Discord channel to mirror all liaison messages
  "dedupeWindowMs": 600000,       // corrId dedup window (ms)
  "maxClockSkewMs": 120000,       // max tolerated clock skew between hubs (ms)
  "ratePerPeerPerMin": 120,       // max inbound requests per peer per minute (0 = unlimited)
  "notifyRetry": { "maxAttempts": 5, "baseDelayMs": 2000 },
  "peers": [
    { "name": "hub-b", "baseUrl": "http://127.0.0.1:8788", "secretEnv": "PEER_HUB_B_SECRET" }
  ]
}
```

Each entry in `peers[]` is `{ name, baseUrl, secretEnv }`. `secretEnv` names an environment variable that holds the **shared HMAC secret** for that peer — the secret is never written to config, only the env var name. Both hubs must configure each other as peers with the same secret; a mismatch produces a 401 and an `onRejected` log entry.

**Addressing a peer's agent** uses `peer:agent` notation — e.g. `hub-b:researcher`. The hub splits on the first `:` to identify the target peer and agent name.

**Agent tools** (exposed only when `peering.enabled`):

- **`notify_peer`** — fire-and-forget: sends a `notify` envelope to a named target (`"hub-b:researcher"`). The message is spooled for durable delivery with HMAC signing, clock-skew checking, corrId dedup, and per-peer rate limiting on the receiving side. The calling agent does not wait for a reply.
- **`ask_peer`** — request/reply: sends an `ask` envelope and waits up to `askTimeoutMs` for the remote agent's reply, which comes back as a `reply` envelope POSTed to this hub's `/peer/reply` route. The reply text is returned to the calling agent as the tool result. Both tools are additionally gated by the **target agent's `access.peerableBy`** allowlist on the remote hub (the remote hub enforces this; the local hub enforces `peering.enabled`).

**Logging:** message bodies are written to `<stateDir>/liaison.log.jsonl` (one JSON line per envelope, including text). Only **metadata** (peer name, corrId, kind, outcome) goes to the audit ledger as `kind: "liaison"` rows — no message text in the audit log.

**Security:** all peer-to-peer HTTP traffic is signed with HMAC-SHA256 (`X-Switchboard-Signature: sha256=<hex>`) using the per-peer shared secret. The receiver verifies the signature, checks the timestamp against `maxClockSkewMs`, and deduplicates by `corrId` within `dedupeWindowMs`. Rejected envelopes (bad signature, unknown peer, stale timestamp, duplicate, rate-exceeded) are logged and return 4xx — they are never delivered. Run hubs behind a private network or VPN tunnel; `peering` does not add transport encryption on top of HTTP.

## Rich interactions — cards, modals, files & links

Beyond plain chat, an agent drives Discord through its MCP **shim** (registered via `--mcp-config`, relayed to the hub over a local socket). The full agent-facing tool surface:

| Tool | What it does |
|------|--------------|
| `post_card` / `update_card` | Post a rich **card** (embed + fields + buttons), then edit it **in place** by `correlation_id` — one card per task, updated as work progresses. |
| `react` / `edit_message` | Add an emoji reaction; edit a plain message the bot already sent. |
| `remember` / `recall` | Write and read the memory vault (see below). |
| `finish` | Signal the turn/task is complete (tears down an ephemeral session; just ends the turn for a persistent agent). |
| `post_webhook` | Fire a pre-configured **outbound webhook** by route `id` — never a URL (the hub holds the destination + secret). |
| `ask_agent` | Consult another agent by name and get its reply back. *Gated — only when `consult.enabled`.* |
| `attach_file` | **Attach a file the agent produced** (a `.md`/`.pdf`/`.csv` report) to a Discord message. *Gated — `hub.outboundAttachments.enabled`.* |
| `publish_link` | **Publish a file to a gated URL** for artifacts too big or unviewable as a Discord attachment. *Gated — `hub.shareLinks.enabled`.* |

**Modals (popup forms).** Any card button can carry a `modal` spec, so clicking it opens a native Discord **popup form** (up to 5 short/paragraph inputs). The user's answers return to the agent as a single `[interaction] custom_id=… fields={…}` message — the right way to gather several answers at once instead of a back-and-forth of prose questions. Discord caps a modal at 5 fields; for more, an agent uses several buttons (each opening its own ≤5-field modal) and correlates the replies by `custom_id`. (A modal can only open from a button click, and cannot open in response to another modal's submission.)

**Inbound attachments** (`hub.attachments.enabled`). When a user uploads files with a message, the hub downloads them under `<stateDir>/attachments/` (size-capped, `maxBytes` default 10 MB) and folds their local paths into the turn, so the agent can `Read` them. Off → byte-identical to before (paths simply aren't injected).

**Outbound attachments — `attach_file`** (`hub.outboundAttachments.enabled`). An agent writes a file into its **per-agent outbox** and attaches it by relative path. The hub validates with **realpath containment** (no `..`/symlink-target escape; the agent identity is taken from the socket connection, never a tool arg, so one agent can't name another's outbox), size-caps it, reads it into a `Buffer` before handing it to discord.js (closing a TOCTOU swap window), and audits the real delivery outcome. Containment forces an explicit, audited copy into the outbox — it is **not** a sandbox against a hostile agent's own host access, so enable it only for agents you trust on the box; the genuine defenses are agent trust, the audit trail, and an optional extension allowlist.

**Share links — `publish_link`** (`hub.shareLinks`). For artifacts too large or unviewable as a Discord attachment (PDF statements, rendered HTML mockups, large CSVs, long markdown reports), an agent publishes the file to a configured **artifacts directory** alongside a **`.sbmd` metadata sidecar** that tells a renderer how to present it — `download`, `page` (live HTML), or `view` (pretty PDF/markdown/CSV table) — and gets back a **gated URL**. The renderer is **decoupled and pluggable**: Switchboard only drops the file + sidecar atomically into the shared location (with realpath containment and a TTL); a **separate service you point it at** (`shareLinks.raHost`) reads the `.sbmd` and serves the artifact behind your own access control. A periodic sweep expires artifacts past `defaultTtlDays` (default 30). Off unless `shareLinks.enabled`.

## Memory, context & the overseer

These make the hub more autonomous. All extra model calls reuse **Claude Code auth** (the router/librarian/distiller/judge are `claude -p` passes) and the embedder is a **local in-process model** — there is **no new API key or external service**.

**Recent-message context.** The hub keeps a per-conversation ring buffer (`contextCacheSize`, default 20), persisted as JSONL under `<stateDir>/cache/`. It injects a compact "recent conversation" block into a turn per the agent's `injectContext` policy: `onSwitch` (default — catch a newly-bound agent up), `always` (every cold ephemeral spawn), or `never`. Quote-replies are captured and inlined too (Discord reply references don't appear in fetched history).

**Memory vault.** An Obsidian-style `.md` note vault under `memoryDir` (default `<stateDir>/memory/`), with four scopes as folders: `global/`, `users/<id>/`, `agents/<name>/`, `channels/<id>/`. Notes are plain markdown with YAML front-matter (`title, scope, tags, created, updated, source`) and `[[wikilinks]]` — human- and Obsidian-editable. Agents with `useMemory: true` get relevant notes injected each turn, each stamped with an **as-of date** so stale specifics get re-verified.

- **Retrieval is two-stage and local by default.** A local sentence-transformer (`@huggingface/transformers`, default `Xenova/all-MiniLM-L6-v2`, loaded lazily) embeds notes into a scope-filtered cosine index; a small Claude **librarian** then ranks the recalled candidates for precision and scope/recency. Only the librarian-selected note bodies are injected (≤5), and recall is capped at ~20 candidates — so **injected context stays bounded regardless of vault size**. Each vector is stamped with the embedding-model version, so swapping models re-embeds cleanly instead of mixing vector spaces.
- **Hosted backend (optional).** The recall index and embedder both sit behind interfaces, selected by `memory` in `hub.config.json`: `index: "local" | "qdrant"` and `embedder: "local" | "openai"`. **Qdrant** (`memory.qdrant: { url, apiKeyEnv?, collection? }`) provides a hosted/self-hosted vector store; the embedder can target any **OpenAI-compatible `/embeddings` endpoint** (`memory.openai: { baseUrl, apiKeyEnv?, model }`) — OpenAI, Together, or a self-hosted TEI/Ollama. Keys come only from the named env var. Default is fully local, no secrets.
- **Formation is two-way.** Agents write/read explicitly via the shim's `remember` / `recall` tools (scope defaults to the agent's own folder), **and** a background **distiller** turns an idle conversation (`distillIdleMs`) into note upserts — non-blocking, never on the hot path.
- **Dedup is entity-aware and conservative.** After any write, a background pass finds same-scope near-duplicates and gates a merge on an LLM "same fact, or distinct facts about different entities?" check — it **never merges on cosine alone**, and fails safe to "distinct" on uncertainty. Distiller-generated dups auto-merge (the staler note is dropped); **agent-authored notes are sacred** — never overwritten or deleted, only flagged to `<memoryDir>/.dedup-review.jsonl` for human review. The distiller also refuses to overwrite a hand-written note at a colliding title.

**Operator vault control.** A human can inspect and prune what agents have written: **`!memory browse [scope]`** pages the vault as cards (title, scope, tags, age, snippet, with paginated next/prev), **`!memory forget <id>`** archives a note, and **`!memory delete <id>`** removes it — operator-gated (same gate as `!status`). *(v1: global scope.)*

**Access-weighting & the gardener.** Each note tracks usage (an `.access.json` sidecar — hits when a note is actually injected/recalled), with an exponentially-decayed importance so once-hot notes cool. When `gardener` is enabled, recall is re-ranked by importance and the top notes for the active scopes are **injected proactively** (a "hot set") so load-bearing facts surface without an explicit `recall`. A periodic background **gardener** then does whole-vault hygiene: cross-scope dedup, staleness flags, and **budgeted archival** of cold distiller notes (reversible; agent-authored notes are never archived/deleted, only flagged). Config: `gardener: { enabled, importanceWeight, hotSetSize, decayHalfLifeMs, staleAfterMs, archiveAfterMs, scopeBudget }`; off by default (access hits are still recorded so the signal is ready when you enable it). See [`docs/superpowers/specs/2026-06-13-vault-gardener-design.md`](docs/superpowers/specs/2026-06-13-vault-gardener-design.md).

**The overseer.** An opt-in per-agent loop (`runtime.overseer: { enabled, maxIterations?, maxWallclockMs?, model? }`). On each finished turn, a judge scores the agent's reply against the goal and returns `done` / `working` / `blocked`:

- `done` → ship the reply (plain chat and Q&A always resolve here, so it never loops on conversation).
- `working` → swallow the intermediate reply and re-prod the agent with a specific nudge, until done or the iteration/wallclock caps are hit (then it ships the last reply with a footer).
- `blocked` → ship the reply (the question to the human) and stop. The judge reserves `blocked` for **genuine** human dependencies (irreversible/destructive actions, missing info only a human has, high-stakes ambiguous calls); if the agent is merely being over-cautious it returns `working` with a nudge to **proceed with a sensible default** — biasing toward autonomous progress.

Caps + fail-open (a garbled judge ships the reply rather than looping) bound cost and runaway loops. The example `help` (persistent, warm) and `help-quick` (ephemeral, parallel one-shots) agents in `config/agents.example.json` show the dual-mode help pattern; `worker` shows an `overseer` block.

## Session health, live status & scaling

Persistent agents are long-lived `claude` processes whose context grows unbounded. These features keep them healthy and make the hub legible. They're driven by a signal the CLI already emits and the hub used to discard: each turn's **token usage** (input + cache tokens ≈ how full the context window is). All opt-in; off until configured. See [`docs/superpowers/specs/2026-06-24-session-health-status-autoscale-design.md`](docs/superpowers/specs/2026-06-24-session-health-status-autoscale-design.md).

**Usage capture.** `parseStreamEvent` now reads `usage`/`num_turns`/`total_cost_usd` off each `result`; the transport exposes `contextTokens()` / `fillPct(windows)`. Context windows per model come from `contextWindows` (a `{ "<model>": tokens, "default": 200000 }` map).

**Turn gate.** Each persistent agent runs **one turn in flight at a time**; a burst queues behind it (cap `runtime.maxQueueDepth`, default 8; optional `runtime.coalesceBurst` folds a same-conversation burst into one turn). This stops messages piling onto stdin mid-turn (which misroutes replies), and produces the busy / queue-depth load signal the board and pool read. Overflow tells the user to resend rather than dropping silently.

**Session governor** (`runtime.sessionGovernor: { enabled, softPct?, hardPct?, strategy? }`). On each turn it reads the context fill: at `softPct` (default 0.75) it nudges the agent once to checkpoint important state via `remember`; at `hardPct` (default 0.90) it auto-compacts — asks for a ≤200-word handoff, persists it, resets the session (the existing fresh-session path), and seeds the new session with the handoff so continuity holds. Bounds context (and per-turn cost) without losing vault-persisted knowledge.

**Live status board** (`statusChannelId`, `statusRefreshMs` default 15s). One self-editing embed showing every persistent agent (alive / busy / context% / queue / cost / replica count), what the overseer/governor is doing, the Haiku router's recent picks + rate, and live ephemeral agents. Edits are throttled to ≤1 / 5s. Allowlisted users can also pull it on demand with `!status` (aliases `!usage`, `!health`).

**Tool observability.** The board also surfaces each agent's **live tool activity** (a ⚙ marker while a tool call is in flight, ⚠ on a tool error), and the hub keeps a per-agent **tool-usage tally** from the stream. **`!tools`** posts the breakdown — which tools each agent has used and how often — so you can see what the fleet is actually doing, not just that it's busy.

**Agent auto-scaling** (`runtime.pool: { min?, max?, scaleUpQueue?, scaleUpSustainMs?, replicaIdleMs?, isolateCwd? }`). A hot agent is backed by 1..N replicas: conversations stick to a replica (context continuity), new ones load-balance, and **sustained** queue pressure (all replicas busy + queue over threshold, held for `scaleUpSustainMs`) spins up another replica up to `max`; idle, unbound spares retire down to `min`. *v1 boundary:* card interactions and session resets act on the primary replica, so don't combine `pool` with `sessionGovernor` on the same agent.

## Audit log

One append-only ledger of every governed effect the hub performs — the single answer to "what has this hub done, and on whose say-so?" It generalizes the outbound delivery log and is the keystone the gated-action catalog, metrics, and future surfaces write into. Off unless `audit.enabled`. See [`docs/superpowers/specs/2026-06-24-audit-log-design.md`](docs/superpowers/specs/2026-06-24-audit-log-design.md).

Each governed effect appends one row to `<stateDir>/audit.jsonl`: the **router pick** (`route`), **ephemeral spawns** (`spawn`), **direct-command exec** (`exec`), **outbound deliveries** (`outbound`, with status/attempts), **session reset/compact + checkpoint** (`session`), **access denials** (`access`), and **hub lifecycle events** (`event`, e.g. `schedule.fired`), plus **approval decisions** (`approval`) and **inter-agent consults** (`consult`) — `card` joins as that feature lands. A row is `{ ts, kind, actor ("user:<id>" | "agent:<name>" | "hub"), action, target?, chat?, outcome, detail?, cost?, corr? }` — **metadata only**, secrets redacted, never message text. `record()` never throws, so the ledger can't break a turn; it rotates at `maxBytes` (keeping `keepFiles`). Query it (operator-only, same gate as `!status`) with `!audit`, `!audit <kind>`, `!audit actor <a>`, `!audit chat <c>`, or `!audit cost`.

**Replay / time-travel** — `!replay <chat-id|corr-id> [scan]` reconstructs the full effect-chain for a conversation (or a single multi-step action) from the ledger: an ordered timeline with `corr`-linked steps grouped, so "an approval was requested → a human granted it 28s later → the webhook fired" reads as one action. Reads a wide ledger window (so a busy log doesn't bury the conversation) and chunks long output under Discord's limit. Pure projection over the same `audit.jsonl` (current window), operator-gated. This is where the `corr` threading pays off as forensics.

## Gated actions & approvals

Human-in-the-loop for the dangerous stuff. A governed effect marked `requireApproval` doesn't fire — it **parks**, posts an **Approve / Deny** card, and runs only when an authorized operator clicks Approve. Off unless `approvals.enabled`. See [`docs/superpowers/specs/2026-06-24-gated-action-catalog-design.md`](docs/superpowers/specs/2026-06-24-gated-action-catalog-design.md).

The held effect (today, an outbound webhook delivery) is kept in an in-memory `ApprovalRegistry` until resolved. Only configured `approvers` (default `deployApproverUserId`) may press the buttons — enforced at the notify-button gate, so an agent has no path to self-approve. Resolution is **single-shot** (a double-click can't fire twice) and **fail-closed**: deny, a `ttlMs` timeout (a periodic sweep auto-denies), or a hub restart all leave the effect unfired. The card is edited in place to Approved / Denied / Expired. Every step — `request` → `grant`/`deny`/`expire` → the eventual delivery — is an `approval`/`outbound` audit event threaded by the same `corr`, so `!audit` reconstructs exactly who approved what. The registry is generic, so `exec` and other effects can adopt the same gate next.

## Metrics & health

Point Grafana or a load balancer at the hub. Set `metricsPort` and the hub serves two GET endpoints (off when unset). See [`docs/superpowers/specs/2026-06-24-metrics-health-design.md`](docs/superpowers/specs/2026-06-24-metrics-health-design.md).

- **`GET /metrics`** — Prometheus text exposition, *projected from* the live `StatusRegistry` snapshot and the audit summary (no new instrumentation): per-agent `switchboard_agent_{alive,busy,queue_depth,context_fill_ratio,cost_usd,replicas}`, plus `switchboard_{route_rate_10m,ephemerals_active,overseers_active,pending_approvals,uptime_seconds}` and `switchboard_ledger_{events,outcomes,cost_usd}` (gauges over the current `audit.jsonl` window).
- **`GET /health`** (and `/healthz`) — JSON `{ status, uptimeSec, agents[], pendingApprovals, routeRate10m }`, returning **503 `degraded`** when agents exist but none are alive (a real load-balancer readiness signal), else **200 `ok`**.
- **`!metrics`** — the same health rollup in chat (operator-only, like `!status`).

The endpoint is unauthenticated (the Prometheus norm) and serves only aggregated, non-secret numbers — no message content, no secrets, no per-user data. It binds **loopback (`127.0.0.1`) by default**; set `metricsHost: "0.0.0.0"` (or a specific interface) to expose it for a remote scraper.

## Inter-agent consult

Agents aren't islands. With `consult.enabled`, each agent gets an **`ask_agent`** tool: it names another agent and a question, and the hub runs that agent and returns its reply text into the tool call — so a coding agent can ask the ops agent "is prod healthy?" and use the answer mid-turn. See [`docs/superpowers/specs/2026-06-24-inter-agent-consult-design.md`](docs/superpowers/specs/2026-06-24-inter-agent-consult-design.md).

Built on the same request/response seam as `recall`: the target runs on a virtual `consult:<id>` channel, its reply (text or a card) is intercepted before Discord and returned to the caller. **Governed** — an agent answers only if its `access.consultableBy` permits the requester (`"*"` = any; self-consult always denied); the tool is exposed only when `consult.enabled`. **Bounded** — the caller waits up to `timeoutMs` (then gets a timeout note), and every consult (`ask`/`answer`/`deny`/`timeout`) is a `consult` audit event threaded by `corr`. *Boundaries:* the call is synchronous (the caller holds its turn while waiting) and runs in the target's shared session; a mutual cycle is broken by the timeout. **Treat `consultableBy` as a data-flow grant, not just availability** — the target's raw reply is handed to the requester, so prefer an explicit agent allowlist over `"*"` (which lets any agent, including a prompt-injected one, consult that agent).

## Web dashboard

Point a browser at the hub and watch it work. Set `webPort` and the hub serves a single self-contained page (off when unset). See [`docs/superpowers/specs/2026-06-24-web-dashboard-design.md`](docs/superpowers/specs/2026-06-24-web-dashboard-design.md).

The canonical conversation API is documented in [`docs/architecture/conversations.md`](docs/architecture/conversations.md); its approved cross-platform direction is in the [`standalone web-client and transport architecture`](docs/superpowers/specs/2026-07-12-standalone-web-client-and-transport-architecture-design.md). Canonical web messages now run through the selected agent and ordinary text mirrors through durable transport deliveries. Discord is optional at startup, so a web-only hub remains fully agent-backed. Discord commands and rich cards/interactions continue on the compatibility path; workspace rich-card parity is deferred.

- **`GET /`** — a read-only dashboard (vanilla JS, no build step) that polls `/api/status` every 3 s and renders the agent fleet (alive/busy, context-fill bar, queue, cost, replicas), hub health + uptime, the ledger summary, and a recent-activity feed.
- **`GET /api/status`** — the JSON the page consumes, projected from the same `StatusSnapshot` + audit data as `!status`/`!audit`/`/metrics` (its readiness flag matches `/health`).

Read-only and unauthenticated like `/metrics` — it serves only the already-public status/audit **metadata** (no message content, no secrets, no write actions), and binds **loopback (`127.0.0.1`) by default** (`webHost: "0.0.0.0"` to expose). This is deliberately the read-only slice of "web support"; a bidirectional web chat would mean abstracting the Discord-coupled gateway, a separate effort.

## Workflows / missions

A team of agents, not one. A **mission** runs a declarative `workflows[]` pipeline — each step runs a named agent with a templated prompt, and each step's output feeds the next — kicked off with **`!run <id> [input]`** (operator-only). See [`docs/superpowers/specs/2026-06-24-agent-workflows-design.md`](docs/superpowers/specs/2026-06-24-agent-workflows-design.md).

Each step runs on a hidden `mission:<id>` channel — the same run-and-capture primitive as `ask_agent`: the step's reply (text or card, via `consultAnswerFromReply`) is intercepted before Discord and fed into the next step's prompt (`{{input}}` = the run input, `{{steps.<id>}}` = a prior step's output). A **live progress card** updates per step (⏳ → 🔄 → ✅/❌), the final output is posted, and every hop (`start`/`step`/`done`/`error`) is a `mission` audit event threaded by run id. **Off unless `workflow.enabled`.** A stuck step (unavailable agent or `stepTimeoutMs`) fails the run rather than hanging; steps target persistent agents and run sequentially (ephemeral-per-step isolation and DAG/parallel steps are the documented next steps). `!workflows` lists what's configured.

```jsonc
"workflow": { "enabled": true, "stepTimeoutMs": 120000 },
"workflows": [{ "id": "ship-feature", "steps": [
  { "id": "research",  "agent": "research",  "prompt": "Research how to {{input}}." },
  { "id": "implement", "agent": "assistant", "prompt": "Using:\n{{steps.research}}\nImplement {{input}}." },
  { "id": "review",    "agent": "help",      "prompt": "Review:\n{{steps.implement}}" }
]}]
```

## Status of features

**Working** (covered by the passing unit tests + the real-CLI smoke check):

- Message routing through the hub, with the **base gate** (role + user-id access control).
- Per-agent access by Discord **role** and **user id**.
- **Control commands** (e.g. forcing/switching the bound agent).
- **Haiku router** (`claude -p --model claude-haiku-4-5`) with **sticky** bindings and confident **auto-switching** above the configured threshold.
- **stream-json agent transport** (`StreamJsonTransport`): the hub spawns each agent as a `claude -p --input-format stream-json` session, delivers inbound on stdin, and emits each turn's `result` as the reply. Proven against a real `claude` by `scripts/smoke-streamjson.ts`.
- **MCP shim relay**: agents drive Discord via the shim (registered with `--mcp-config`, forwarded to the hub over a socket) — `post_card`/`update_card`, `react`/`edit_message`, `remember`/`recall`, `finish`, `post_webhook`, and the gated `ask_agent`/`attach_file`/`publish_link`.
- **Card modals** (`hub/modal.ts`): a card button can carry a `modal` spec → Discord popup form (≤5 inputs); submitted fields return to the agent as a tagged `[interaction] … fields={…}` message. The button handler always acknowledges, so a click never shows "interaction failed".
- **Inbound attachments** (`hub/attachments.ts`): user file uploads are downloaded under `<stateDir>/attachments/` (size-capped) and their paths folded into the turn for the agent to `Read`. Off unless `hub.attachments.enabled`.
- **Outbound attachments** (`attach_file` + `hub/outboxAttach.ts`): an agent attaches a produced file from its per-agent outbox — realpath containment, size cap, Buffer-before-handoff (TOCTOU-hardened), delivery audited. Off unless `hub.outboundAttachments.enabled`.
- **Share links** (`publish_link` + `hub/publishLink.ts`): an agent publishes a file + a `.sbmd` metadata sidecar to a shared artifacts dir (atomic, realpath-contained, TTL-swept) for a decoupled renderer to serve as a gated URL. Off unless `hub.shareLinks.enabled`.
- **Tool observability** (`hub/toolUsageRegistry.ts`/`toolBoard.ts`): live per-agent tool activity (⚙/⚠) on the status board + a per-agent usage tally, surfaced on demand with `!tools`.
- **Operator vault control** (`!memory browse/forget/delete`): paged card UI to inspect, archive, and delete vault notes; operator-gated.
- **Open tool permissions** (agents run `--dangerously-skip-permissions`); the only gate is the approver-only `deploy:` button namespace.
- Message **tagging + chunking** (Discord 2000-char limit) and agent-prefix tagging.
- **Bindings persistence** (sticky conversation → agent state survives restarts).
- **Pairing CLI** (`scripts/pair.ts`) — approving a code now sends the user a Discord confirmation message (via the hub's approved-dir poller).
- **Webhook → agent cards** (`webhooks[]`): HMAC-verified inbound POSTs delivered to an agent, which can post rich cards (embed + buttons).
- **Gated button actions** (`NotifyRouter`): card-button clicks route back to the originating agent via its stdin; only allowlisted users may press, and the **`deploy:` namespace is approver-only** (`deployApproverUserId`).
- **Daily scheduler** (`schedules[]`): UTC-hour message delivery to an agent, once per day per schedule id.
- **Config-driven ephemeral spawning** (`spawnTriggers[]`): an outbound-text regex spawns an ephemeral agent with an interpolated task, optional setup + teardown shell steps; spawned agents post cards and receive button clicks like any agent.
- **Outbound webhooks** (`outbound.ts`/`outboundDelivery.ts`): the hub POSTs to external systems via named routes — fired by agent-text regex, the `post_webhook` MCP tool (named-route-only, no agent-supplied URLs), or hub events (`schedule.fired`). Signed, retried with backoff, idempotency-keyed, logged, and dead-lettered.
- **Recent-message context cache** + per-agent `injectContext` policy; quote-reply capture.
- **Memory vault** (`MemoryStore`/`MemoryRetriever`): four-scope Obsidian-style notes, recall via a local-embedding OR hosted (Qdrant + OpenAI-compatible) backend + Claude librarian, `remember`/`recall` shim tools, background distiller, and entity-aware dedup with protected agent-authored notes.
- **Access-weighting & gardener** (`accessStore.ts`/`gardener.ts`): decayed usage importance, importance-weighted recall + proactive hot-set injection, and a periodic whole-vault dedup/stale/archival pass (opt-in via `gardener`).
- **Session health, status & scaling** (`usage.ts`/`turnGate.ts`/`sessionGovernor.ts`/`statusRegistry.ts`/`statusBoard.ts`/`agentPool.ts`): per-turn token/cost capture, a one-turn-in-flight queue gate, context-window governance (checkpoint → auto-compact), a live self-editing status embed (+ `!status`), and opt-in replica auto-scaling for a hot agent.
- **Audit log** (`audit.ts`/`auditLog.ts`/`auditCommand.ts`): one append-only `<stateDir>/audit.jsonl` ledger of every governed effect (route / spawn / exec / outbound / session / access / event), metadata-only with secret redaction, size-rotated, queryable via operator-only `!audit` (+ `!audit cost` rollup). Off unless `audit.enabled`; per-agent opt-out.
- **Gated actions & approvals** (`approval.ts`): a `requireApproval` effect parks for a human Approve/Deny card and fires only on an authorized approver's grant — fail-closed, single-shot, TTL-swept, audited end-to-end by `corr`. Off unless `approvals.enabled`.
- **Metrics & health** (`metrics.ts`/`metricsServer.ts`): a Prometheus `GET /metrics` scrape + `GET /health` probe (503 when no agent is alive) on `metricsPort`, projected from the live status snapshot + audit summary, plus a `!metrics` chat rollup. Off unless `metricsPort` is set.
- **Inter-agent consult** (`consult.ts`): an `ask_agent` tool lets one agent ask another (by name) and get its reply back, via the recall request/response seam on a virtual channel — governed by `access.consultableBy` (default deny, no self-consult), bounded by `timeoutMs`, audited as `consult`. Off unless `consult.enabled`.
- **Workflows / missions** (`workflow.ts`): declarative multi-step pipelines — each step runs an agent with a templated prompt, output feeding the next — run via `!run <id> [input]` on hidden mission channels, with a live progress card and per-step `mission` audit, threaded by run id. Off unless `workflow.enabled`.
- **Replay / time-travel** (`replay.ts`): `!replay <chat|corr> [scan]` reconstructs a conversation's (or one action's) effect-chain from the `corr`-threaded ledger — an ordered, grouped timeline, read from a wide window and chunked under Discord's limit. Pure projection over the audit log, operator-gated.
- **Web dashboard** (`web.ts`/`webServer.ts`): a read-only browser dashboard on `webPort` (`GET /` + a `/api/status` JSON feed) showing the live agent fleet, health, ledger summary, and recent activity — projected from the same snapshot + audit data, no gateway changes. Off unless `webPort` is set.
- **Overseer** (`overseer.ts`): opt-in keep-prodding-until-done loop with `done`/`working`/`blocked` verdicts, autonomy bias, and iteration/wallclock caps.

**Known gaps:**

- **Idle GC of spawned workers**: workers are torn down when their process exits; a long-idle-but-alive worker is not yet reaped on a timer.
- **Local embedder runtime**: the embedding model downloads on first run and needs the `@huggingface/transformers` native runtime; until it's warmed, memory recall is empty (writes/distillation still work and index as soon as the model loads). Or point `memory.embedder`/`memory.index` at a hosted backend (OpenAI-compatible embeddings + Qdrant) — see above.
- **Archived-note deep recall**: archived notes have their vector dropped, so they're excluded from recall (and browsable on disk under `<scope>/archive/`); searching archived notes on demand and auto-restoring on a hit is future work.

## Docs

- Spec: [`docs/superpowers/specs/2026-06-02-switchboard-design.md`](docs/superpowers/specs/2026-06-02-switchboard-design.md)
- Plan: [`docs/superpowers/plans/2026-06-02-switchboard.md`](docs/superpowers/plans/2026-06-02-switchboard.md)
- stream-json transport — Spec: [`docs/superpowers/specs/2026-06-03-streamjson-transport-design.md`](docs/superpowers/specs/2026-06-03-streamjson-transport-design.md), Plan: [`docs/superpowers/plans/2026-06-03-streamjson-transport.md`](docs/superpowers/plans/2026-06-03-streamjson-transport.md)
- Overseer & memory — Spec: [`docs/superpowers/specs/2026-06-13-overseer-memory-design.md`](docs/superpowers/specs/2026-06-13-overseer-memory-design.md), Plan: [`docs/superpowers/plans/2026-06-13-overseer-memory.md`](docs/superpowers/plans/2026-06-13-overseer-memory.md)
- Session health, status & scaling — Spec: [`docs/superpowers/specs/2026-06-24-session-health-status-autoscale-design.md`](docs/superpowers/specs/2026-06-24-session-health-status-autoscale-design.md)
- Outbound webhooks — Spec: [`docs/superpowers/specs/2026-06-24-outbound-webhooks-design.md`](docs/superpowers/specs/2026-06-24-outbound-webhooks-design.md)
- Audit log — Spec: [`docs/superpowers/specs/2026-06-24-audit-log-design.md`](docs/superpowers/specs/2026-06-24-audit-log-design.md)
- Gated action catalog — Spec: [`docs/superpowers/specs/2026-06-24-gated-action-catalog-design.md`](docs/superpowers/specs/2026-06-24-gated-action-catalog-design.md)
- Metrics & health — Spec: [`docs/superpowers/specs/2026-06-24-metrics-health-design.md`](docs/superpowers/specs/2026-06-24-metrics-health-design.md)
- Inter-agent consult — Spec: [`docs/superpowers/specs/2026-06-24-inter-agent-consult-design.md`](docs/superpowers/specs/2026-06-24-inter-agent-consult-design.md)
- Agent workflows / missions — Spec: [`docs/superpowers/specs/2026-06-24-agent-workflows-design.md`](docs/superpowers/specs/2026-06-24-agent-workflows-design.md)
- Replay / time-travel — Spec: [`docs/superpowers/specs/2026-06-24-replay-design.md`](docs/superpowers/specs/2026-06-24-replay-design.md)
- Web dashboard — Spec: [`docs/superpowers/specs/2026-06-24-web-dashboard-design.md`](docs/superpowers/specs/2026-06-24-web-dashboard-design.md)
- Canonical conversations — Architecture: [`docs/architecture/conversations.md`](docs/architecture/conversations.md), approved design: [`docs/superpowers/specs/2026-07-12-standalone-web-client-and-transport-architecture-design.md`](docs/superpowers/specs/2026-07-12-standalone-web-client-and-transport-architecture-design.md)
