# Switchboard

One Discord bot, many Claude Code agents.

Switchboard extends the official Claude Code Discord plugin (which is strictly **1 bot ↔ 1 session**) into a **hub** that fans a single Discord bot out to many Claude Code agents — each with its own working directory, model, tools, and MCP setup. A small Claude router (`claude -p --model claude-haiku-4-5`, reusing your Claude Code auth) decides which agent each message reaches, conversations stay stickily bound to an agent with confident auto-switching, and access is gated per Discord **role and user ID**.

- **Persistent agents** — long-lived `claude -p --input-format stream-json` sessions (research, coding) the hub owns directly: it writes inbound messages to the agent's stdin and reads replies from its stdout. Cards/react/edit come through a thin MCP **shim**.
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

> **Status:** implemented. All unit tests pass (`bun test`) and `bun run typecheck` is clean. The agent transport runs on the documented stream-json protocol (the earlier experimental `--channels` mechanism was removed when current Claude CLIs dropped its `command:` form); the stdin→reply + MCP-card round-trip is proven against a real `claude` via `scripts/smoke-streamjson.ts`. Manual full Discord end-to-end (a live bot in a guild) is the remaining check.

## Why a hub?

Discord allows only one gateway connection per bot token, so you can't run N agent sessions on one token. Switchboard runs a single **hub** process that owns the token and gateway and routes each message to an agent behind it.

- The **hub** owns the bot token + Discord gateway, runs the base gate (role/user access), the Haiku router, sticky bindings, and the orchestrator that dispatches to agents.
- **Persistent** agents are long-lived `claude -p --input-format stream-json` processes the hub spawns and owns: inbound → the agent's stdin, replies ← its stdout. The agent's MCP **shim** (registered via `--mcp-config`) relays `post_card`/`react`/`edit` back to the hub over a local socket.
- **Ephemeral** agents are the same kind of session spawned on demand (e.g. by a spawn trigger), kept alive for any card → button-click loop, and torn down when the process exits.

## Layout

```
hub/         the one process that owns the bot token + gateway + router
shim/        per-agent MCP server for post_card/react/edit (hub ↔ agent over a socket)
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
- **`audit`** — `{ enabled?, file?, kinds?, redactEnv?, maxBytes?, keepFiles? }`. One append-only ledger (`<stateDir>/audit.jsonl`) of every governed effect — `route`, `spawn`, `exec`, `outbound`, `session`, `access`, `event` (and `approval`/`card` as those land), each row `{ ts, kind, actor, action, target?, chat?, outcome, detail?, cost?, corr? }`. **Metadata only** (no message bodies); secrets in `detail` are redacted. Off unless `enabled`; a per-agent `runtime.audit: false` opts an agent out. Optional `kinds[]` allowlist, `redactEnv[]` extra secrets, and size-based rotation (`maxBytes` → `audit-<ts>.jsonl`, oldest pruned to `keepFiles`). Operators query it with **`!audit [kind|actor <a>|chat <c>] [n]`** and **`!audit cost`** (a rollup).
- **`deployApproverUserId`** — only this Discord user may press buttons in the `deploy:` namespace.
- **`approvals`** — `{ enabled?, channelId?, approvers?, ttlMs? }`. Human-in-the-loop gate: a `requireApproval` effect (today, an `outboundWebhooks[]` route) **parks instead of firing** and posts an **Approve / Deny** card; only a configured `approver` (default the deploy approver) may resolve it, and the effect runs **only on grant** — deny, a `ttlMs` timeout, or a hub restart all leave it unfired (fail-closed). Every step (`request`/`grant`/`deny`/`expire`) is an `approval` audit event threaded by `corr`. Off unless `enabled`; with it off, `requireApproval` is inert.

## Memory, context & the overseer

These make the hub more autonomous. All extra model calls reuse **Claude Code auth** (the router/librarian/distiller/judge are `claude -p` passes) and the embedder is a **local in-process model** — there is **no new API key or external service**.

**Recent-message context.** The hub keeps a per-conversation ring buffer (`contextCacheSize`, default 20), persisted as JSONL under `<stateDir>/cache/`. It injects a compact "recent conversation" block into a turn per the agent's `injectContext` policy: `onSwitch` (default — catch a newly-bound agent up), `always` (every cold ephemeral spawn), or `never`. Quote-replies are captured and inlined too (Discord reply references don't appear in fetched history).

**Memory vault.** An Obsidian-style `.md` note vault under `memoryDir` (default `<stateDir>/memory/`), with four scopes as folders: `global/`, `users/<id>/`, `agents/<name>/`, `channels/<id>/`. Notes are plain markdown with YAML front-matter (`title, scope, tags, created, updated, source`) and `[[wikilinks]]` — human- and Obsidian-editable. Agents with `useMemory: true` get relevant notes injected each turn, each stamped with an **as-of date** so stale specifics get re-verified.

- **Retrieval is two-stage and local by default.** A local sentence-transformer (`@huggingface/transformers`, default `Xenova/all-MiniLM-L6-v2`, loaded lazily) embeds notes into a scope-filtered cosine index; a small Claude **librarian** then ranks the recalled candidates for precision and scope/recency. Only the librarian-selected note bodies are injected (≤5), and recall is capped at ~20 candidates — so **injected context stays bounded regardless of vault size**. Each vector is stamped with the embedding-model version, so swapping models re-embeds cleanly instead of mixing vector spaces.
- **Hosted backend (optional).** The recall index and embedder both sit behind interfaces, selected by `memory` in `hub.config.json`: `index: "local" | "qdrant"` and `embedder: "local" | "openai"`. **Qdrant** (`memory.qdrant: { url, apiKeyEnv?, collection? }`) provides a hosted/self-hosted vector store; the embedder can target any **OpenAI-compatible `/embeddings` endpoint** (`memory.openai: { baseUrl, apiKeyEnv?, model }`) — OpenAI, Together, or a self-hosted TEI/Ollama. Keys come only from the named env var. Default is fully local, no secrets.
- **Formation is two-way.** Agents write/read explicitly via the shim's `remember` / `recall` tools (scope defaults to the agent's own folder), **and** a background **distiller** turns an idle conversation (`distillIdleMs`) into note upserts — non-blocking, never on the hot path.
- **Dedup is entity-aware and conservative.** After any write, a background pass finds same-scope near-duplicates and gates a merge on an LLM "same fact, or distinct facts about different entities?" check — it **never merges on cosine alone**, and fails safe to "distinct" on uncertainty. Distiller-generated dups auto-merge (the staler note is dropped); **agent-authored notes are sacred** — never overwritten or deleted, only flagged to `<memoryDir>/.dedup-review.jsonl` for human review. The distiller also refuses to overwrite a hand-written note at a colliding title.

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

**Agent auto-scaling** (`runtime.pool: { min?, max?, scaleUpQueue?, scaleUpSustainMs?, replicaIdleMs?, isolateCwd? }`). A hot agent is backed by 1..N replicas: conversations stick to a replica (context continuity), new ones load-balance, and **sustained** queue pressure (all replicas busy + queue over threshold, held for `scaleUpSustainMs`) spins up another replica up to `max`; idle, unbound spares retire down to `min`. *v1 boundary:* card interactions and session resets act on the primary replica, so don't combine `pool` with `sessionGovernor` on the same agent.

## Audit log

One append-only ledger of every governed effect the hub performs — the single answer to "what has this hub done, and on whose say-so?" It generalizes the outbound delivery log and is the keystone the gated-action catalog, metrics, and future surfaces write into. Off unless `audit.enabled`. See [`docs/superpowers/specs/2026-06-24-audit-log-design.md`](docs/superpowers/specs/2026-06-24-audit-log-design.md).

Each governed effect appends one row to `<stateDir>/audit.jsonl`: the **router pick** (`route`), **ephemeral spawns** (`spawn`), **direct-command exec** (`exec`), **outbound deliveries** (`outbound`, with status/attempts), **session reset/compact + checkpoint** (`session`), **access denials** (`access`), and **hub lifecycle events** (`event`, e.g. `schedule.fired`) — `approval`/`card` join as those features land. A row is `{ ts, kind, actor ("user:<id>" | "agent:<name>" | "hub"), action, target?, chat?, outcome, detail?, cost?, corr? }` — **metadata only**, secrets redacted, never message text. `record()` never throws, so the ledger can't break a turn; it rotates at `maxBytes` (keeping `keepFiles`). Query it (operator-only, same gate as `!status`) with `!audit`, `!audit <kind>`, `!audit actor <a>`, `!audit chat <c>`, or `!audit cost`.

## Gated actions & approvals

Human-in-the-loop for the dangerous stuff. A governed effect marked `requireApproval` doesn't fire — it **parks**, posts an **Approve / Deny** card, and runs only when an authorized operator clicks Approve. Off unless `approvals.enabled`. See [`docs/superpowers/specs/2026-06-24-gated-action-catalog-design.md`](docs/superpowers/specs/2026-06-24-gated-action-catalog-design.md).

The held effect (today, an outbound webhook delivery) is kept in an in-memory `ApprovalRegistry` until resolved. Only configured `approvers` (default `deployApproverUserId`) may press the buttons — enforced at the notify-button gate, so an agent has no path to self-approve. Resolution is **single-shot** (a double-click can't fire twice) and **fail-closed**: deny, a `ttlMs` timeout (a periodic sweep auto-denies), or a hub restart all leave the effect unfired. The card is edited in place to Approved / Denied / Expired. Every step — `request` → `grant`/`deny`/`expire` → the eventual delivery — is an `approval`/`outbound` audit event threaded by the same `corr`, so `!audit` reconstructs exactly who approved what. The registry is generic, so `exec` and other effects can adopt the same gate next.

## Metrics & health

Point Grafana or a load balancer at the hub. Set `metricsPort` and the hub serves two GET endpoints (off when unset). See [`docs/superpowers/specs/2026-06-24-metrics-health-design.md`](docs/superpowers/specs/2026-06-24-metrics-health-design.md).

- **`GET /metrics`** — Prometheus text exposition, *projected from* the live `StatusRegistry` snapshot and the audit summary (no new instrumentation): per-agent `switchboard_agent_{alive,busy,queue_depth,context_fill_ratio,cost_usd,replicas}`, plus `switchboard_{route_rate_10m,ephemerals_active,overseers_active,pending_approvals,uptime_seconds}` and `switchboard_ledger_{events,outcomes,cost_usd}` (gauges over the current `audit.jsonl` window).
- **`GET /health`** (and `/healthz`) — JSON `{ status, uptimeSec, agents[], pendingApprovals, routeRate10m }`, returning **503 `degraded`** when agents exist but none are alive (a real load-balancer readiness signal), else **200 `ok`**.
- **`!metrics`** — the same health rollup in chat (operator-only, like `!status`).

The endpoint is unauthenticated (the Prometheus norm) and serves only aggregated, non-secret numbers — no message content, no secrets, no per-user data; bind it on a private network.

## Status of features

**Working** (covered by the passing unit tests + the real-CLI smoke check):

- Message routing through the hub, with the **base gate** (role + user-id access control).
- Per-agent access by Discord **role** and **user id**.
- **Control commands** (e.g. forcing/switching the bound agent).
- **Haiku router** (`claude -p --model claude-haiku-4-5`) with **sticky** bindings and confident **auto-switching** above the configured threshold.
- **stream-json agent transport** (`StreamJsonTransport`): the hub spawns each agent as a `claude -p --input-format stream-json` session, delivers inbound on stdin, and emits each turn's `result` as the reply. Proven against a real `claude` by `scripts/smoke-streamjson.ts`.
- **MCP shim relay**: agents post cards / react / edit via the shim (registered with `--mcp-config`), forwarded to the hub over a socket.
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
- **Overseer** (`overseer.ts`): opt-in keep-prodding-until-done loop with `done`/`working`/`blocked` verdicts, autonomy bias, and iteration/wallclock caps.

**Known gaps:**

- **Manual full Discord end-to-end** (a live bot in a guild) is the remaining check; the transport itself is proven via the smoke script.
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
