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
- **`commands[]`** — `{ match, agent, channelId, message, allowlistOnly? }`. An inbound chat message whose trimmed content equals `match` delivers `message` to `agent`@`channelId`; if `allowlistOnly`, only base-gate-allowlisted users may trigger it.
- **`spawnTriggers[]`** — `{ pattern, agent, taskTemplate, setupCommand?, teardownCommand? }`. When any agent's outbound text matches the regex `pattern`, an ephemeral `agent` is spawned with task = `taskTemplate` interpolated (`$1`,`$2`… = capture groups, `$jobId` = a generated id). If `setupCommand` is set, it runs first as a shell command (same interpolation) — e.g. to create a worktree; if `teardownCommand` is set, it runs after the spawned agent's process exits — e.g. to remove that worktree.
- **`deployApproverUserId`** — only this Discord user may press buttons in the `deploy:` namespace.

## Memory, context & the overseer

These make the hub more autonomous. All extra model calls reuse **Claude Code auth** (the router/librarian/distiller/judge are `claude -p` passes) and the embedder is a **local in-process model** — there is **no new API key or external service**.

**Recent-message context.** The hub keeps a per-conversation ring buffer (`contextCacheSize`, default 20), persisted as JSONL under `<stateDir>/cache/`. It injects a compact "recent conversation" block into a turn per the agent's `injectContext` policy: `onSwitch` (default — catch a newly-bound agent up), `always` (every cold ephemeral spawn), or `never`. Quote-replies are captured and inlined too (Discord reply references don't appear in fetched history).

**Memory vault.** An Obsidian-style `.md` note vault under `memoryDir` (default `<stateDir>/memory/`), with four scopes as folders: `global/`, `users/<id>/`, `agents/<name>/`, `channels/<id>/`. Notes are plain markdown with YAML front-matter (`title, scope, tags, created, updated, source`) and `[[wikilinks]]` — human- and Obsidian-editable. Agents with `useMemory: true` get relevant notes injected each turn, each stamped with an **as-of date** so stale specifics get re-verified.

- **Retrieval is two-stage and fully local.** A local sentence-transformer (`@huggingface/transformers`, default `Xenova/all-MiniLM-L6-v2`, loaded lazily) embeds notes into a scope-filtered cosine index; a small Claude **librarian** then ranks the recalled candidates for precision and scope/recency. Only the librarian-selected note bodies are injected (≤5), and recall is capped at ~20 candidates — so **injected context stays bounded regardless of vault size**. Each vector is stamped with the embedding-model version, so swapping models re-embeds cleanly instead of mixing vector spaces.
- **Formation is two-way.** Agents write/read explicitly via the shim's `remember` / `recall` tools (scope defaults to the agent's own folder), **and** a background **distiller** turns an idle conversation (`distillIdleMs`) into note upserts — non-blocking, never on the hot path.
- **Dedup is entity-aware and conservative.** After any write, a background pass finds same-scope near-duplicates and gates a merge on an LLM "same fact, or distinct facts about different entities?" check — it **never merges on cosine alone**, and fails safe to "distinct" on uncertainty. Distiller-generated dups auto-merge (the staler note is dropped); **agent-authored notes are sacred** — never overwritten or deleted, only flagged to `<memoryDir>/.dedup-review.jsonl` for human review. The distiller also refuses to overwrite a hand-written note at a colliding title.

**The overseer.** An opt-in per-agent loop (`runtime.overseer: { enabled, maxIterations?, maxWallclockMs?, model? }`). On each finished turn, a judge scores the agent's reply against the goal and returns `done` / `working` / `blocked`:

- `done` → ship the reply (plain chat and Q&A always resolve here, so it never loops on conversation).
- `working` → swallow the intermediate reply and re-prod the agent with a specific nudge, until done or the iteration/wallclock caps are hit (then it ships the last reply with a footer).
- `blocked` → ship the reply (the question to the human) and stop. The judge reserves `blocked` for **genuine** human dependencies (irreversible/destructive actions, missing info only a human has, high-stakes ambiguous calls); if the agent is merely being over-cautious it returns `working` with a nudge to **proceed with a sensible default** — biasing toward autonomous progress.

Caps + fail-open (a garbled judge ships the reply rather than looping) bound cost and runaway loops. The example `help` (persistent, warm) and `help-quick` (ephemeral, parallel one-shots) agents in `config/agents.example.json` show the dual-mode help pattern; `worker` shows an `overseer` block.

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
- **Recent-message context cache** + per-agent `injectContext` policy; quote-reply capture.
- **Memory vault** (`MemoryStore`/`MemoryRetriever`): four-scope Obsidian-style notes, local-embedding recall + Claude librarian, `remember`/`recall` shim tools, background distiller, and entity-aware dedup with protected agent-authored notes.
- **Overseer** (`overseer.ts`): opt-in keep-prodding-until-done loop with `done`/`working`/`blocked` verdicts, autonomy bias, and iteration/wallclock caps.

**Known gaps:**

- **Manual full Discord end-to-end** (a live bot in a guild) is the remaining check; the transport itself is proven via the smoke script.
- **Idle GC of spawned workers**: workers are torn down when their process exits; a long-idle-but-alive worker is not yet reaped on a timer.
- **Local embedder runtime**: the embedding model downloads on first run and needs the `@huggingface/transformers` native runtime; until it's warmed, memory recall is empty (writes/distillation still work and index as soon as the model loads). The retrieval index is behind an interface, so an external/hosted vector backend can be slotted in without touching the retriever.
- **Vault gardening**: a periodic merge/prune ("gardener") pass over the whole vault is future work; dedup currently runs per-write.

## Docs

- Spec: [`docs/superpowers/specs/2026-06-02-switchboard-design.md`](docs/superpowers/specs/2026-06-02-switchboard-design.md)
- Plan: [`docs/superpowers/plans/2026-06-02-switchboard.md`](docs/superpowers/plans/2026-06-02-switchboard.md)
- stream-json transport — Spec: [`docs/superpowers/specs/2026-06-03-streamjson-transport-design.md`](docs/superpowers/specs/2026-06-03-streamjson-transport-design.md), Plan: [`docs/superpowers/plans/2026-06-03-streamjson-transport.md`](docs/superpowers/plans/2026-06-03-streamjson-transport.md)
- Overseer & memory — Spec: [`docs/superpowers/specs/2026-06-13-overseer-memory-design.md`](docs/superpowers/specs/2026-06-13-overseer-memory-design.md), Plan: [`docs/superpowers/plans/2026-06-13-overseer-memory.md`](docs/superpowers/plans/2026-06-13-overseer-memory.md)
