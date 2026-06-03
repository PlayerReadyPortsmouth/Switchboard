# Switchboard

One Discord bot, many Claude Code agents.

Switchboard extends the official Claude Code Discord plugin (which is strictly **1 bot ↔ 1 session**) into a **hub** that fans a single Discord bot out to many Claude Code agents — each with its own working directory, model, tools, and MCP setup. A small Claude router (`claude -p --model claude-haiku-4-5`, reusing your Claude Code auth) decides which agent each message reaches, conversations stay stickily bound to an agent with confident auto-switching, and access is gated per Discord **role and user ID**.

- **Persistent agents** — long-lived `claude --channels` sessions (research, coding) connected to the hub through a thin channel shim. Native UX: reply/react/edit relay.
- **Ephemeral agents** — headless `claude -p --resume` workers spawned per conversation for quick Q&A, with a fixed tool allowlist.

On top of the router, the hub adds a small set of **config-driven integration primitives** — all optional, all generic, all defined as arrays in `config/hub.config.json`:

- **Webhook → agent cards** — one HTTP listener (`webhookPort`) fans out by path; each route HMAC-verifies an inbound POST and delivers the body to an agent, which can reply with a rich **card** (embed + buttons).
- **Gated button actions** — agents post cards whose buttons route back to the originating agent when clicked (the `NotifyRouter`); only base-gate-allowlisted users may press buttons.
- **Approver-only deploy gate** — buttons in the `deploy:` namespace can only be pressed by a single configured approver (`deployApproverUserId`).
- **Daily scheduler** — fire a message to an agent at a chosen UTC hour, once per day.
- **Config-driven ephemeral spawning** — when any agent's outbound text matches a configured regex, spawn an ephemeral agent with an interpolated task (and an optional setup shell step, e.g. to create a worktree).

> **Status:** implemented v1. All **95** unit tests pass (`bun test`) and `bun run typecheck` is clean. Manual Discord end-to-end testing is still **pending**. See the [Status of features](#status-of-features) section for what works and the known v1 gap.

## Why a hub?

Discord allows only one gateway connection per bot token, so you can't run N `claude --channels` sessions on one token. Switchboard runs a single **hub** process that owns the token and gateway and routes each message to an agent behind it.

- The **hub** owns the bot token + Discord gateway, runs the base gate (role/user access), the Haiku router, sticky bindings, and the orchestrator that dispatches to agents.
- **Persistent** agents are long-lived `claude --channels` processes that connect back to the hub over a local socket via a thin channel **shim**.
- **Ephemeral** agents are headless `claude -p --resume` workers spawned on demand per conversation, with a fixed tool allowlist, and torn down after an idle timeout.

## Layout

```
hub/         the one process that owns the bot token + gateway + router
shim/        per-persistent-agent channel server (hub ↔ claude --channels)
config/      hub.config.json + agents.json (the agent registry)
scripts/     start-agent.sh — launch a persistent agent; pair.ts — approve a paired user
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

7. **Persistent agents.** Once the hub is running, launch a persistent agent by name:

   ```bash
   scripts/start-agent.sh <agent-name>
   ```

## Integration config

These optional arrays in `config/hub.config.json` wire the hub to the outside world. See `config/hub.config.json` for a fully-placeholder example.

- **`webhooks[]`** — `{ path, secretEnv, agent, channelId, prefix? }`. A single HTTP listener on `webhookPort` routes by `path`; each POST is HMAC-verified against `process.env[secretEnv]` (header `X-Switchboard-Signature: sha256=…`) and the body is delivered as `"{prefix} {rawBody}"` to `agent`, scoped to `channelId`.
- **`schedules[]`** — `{ id, hourUtc, agent, channelId, message }`. Delivers `message` to `agent`@`channelId` daily at `hourUtc` (UTC), once per `id` per day.
- **`commands[]`** — `{ match, agent, channelId, message, allowlistOnly? }`. An inbound chat message whose trimmed content equals `match` delivers `message` to `agent`@`channelId`; if `allowlistOnly`, only base-gate-allowlisted users may trigger it.
- **`spawnTriggers[]`** — `{ pattern, agent, taskTemplate, setupCommand? }`. When any agent's outbound text matches the regex `pattern`, an ephemeral `agent` is spawned with task = `taskTemplate` interpolated (`$1`,`$2`… = capture groups, `$jobId` = a generated id). If `setupCommand` is set, it runs first as a shell command (same interpolation) — e.g. to create a worktree.
- **`deployApproverUserId`** — only this Discord user may press buttons in the `deploy:` namespace.

## Status of features

**Working in v1** (covered by the 95 passing unit tests):

- Message routing through the hub, with the **base gate** (role + user-id access control).
- Per-agent access by Discord **role** and **user id**.
- **Control commands** (e.g. forcing/switching the bound agent).
- **Haiku router** (`claude -p --model claude-haiku-4-5`) with **sticky** bindings and confident **auto-switching** above the configured threshold.
- **Ephemeral** agents: headless `claude -p` workers with a fixed tool allowlist and idle timeout.
- **Persistent** agents via the channel **shim**: reply / react / edit relay.
- **Interactive permission relay for persistent agents.** When a persistent agent hits a tool-approval prompt, the hub DMs the base-gate allowlist an Allow/Deny prompt (buttons, or a `y/n <code>` text reply); the answer routes back to the originating agent's shim. Wired end-to-end through `onPermissionRequest` → `PermissionRouter` in `hub/index.ts`.
- Message **tagging + chunking** (Discord 2000-char limit) and agent-prefix tagging.
- **Bindings persistence** (sticky conversation → agent state survives restarts).
- **Pairing CLI** (`scripts/pair.ts`) — approving a code now sends the user a Discord confirmation message (via the hub's approved-dir poller).
- **Webhook → agent cards** (`webhooks[]`): HMAC-verified inbound POSTs delivered to an agent, which can post rich cards (embed + buttons).
- **Gated button actions** (`NotifyRouter`): card-button clicks route back to the originating agent; only allowlisted users may press, and the **`deploy:` namespace is approver-only** (`deployApproverUserId`).
- **Daily scheduler** (`schedules[]`): UTC-hour message delivery to an agent, once per day per schedule id.
- **Config-driven ephemeral spawning** (`spawnTriggers[]`): an outbound-text regex spawns an ephemeral agent with an interpolated task and optional setup shell step.

**Known v1 gap:**

- **Manual Discord end-to-end testing is pending** — only unit tests have run so far.

## Docs

- Spec: [`docs/superpowers/specs/2026-06-02-switchboard-design.md`](docs/superpowers/specs/2026-06-02-switchboard-design.md)
- Plan: [`docs/superpowers/plans/2026-06-02-switchboard.md`](docs/superpowers/plans/2026-06-02-switchboard.md)
