# Switchboard

One Discord bot, many Claude Code agents.

Switchboard extends the official Claude Code Discord plugin (which is strictly **1 bot ↔ 1 session**) into a **hub** that fans a single Discord bot out to many Claude Code agents — each with its own working directory, model, tools, and MCP setup. A small Claude router (`claude -p --model claude-haiku-4-5`, reusing your Claude Code auth) decides which agent each message reaches, conversations stay stickily bound to an agent with confident auto-switching, and access is gated per Discord **role and user ID**.

- **Persistent agents** — long-lived `claude --channels` sessions (research, coding) connected to the hub through a thin channel shim. Full native UX: typing indicators, permission Allow/Deny relay, progress edits.
- **Ephemeral agents** — headless `claude -p --resume` workers spawned per conversation for quick Q&A, with a fixed tool allowlist.

> **Status:** design approved, pre-implementation. See [`docs/superpowers/specs/2026-06-02-switchboard-design.md`](docs/superpowers/specs/2026-06-02-switchboard-design.md) for the full design.

## Why a hub?

Discord allows only one gateway connection per bot token, so you can't run N `claude --channels` sessions on one token. Switchboard runs a single hub process that owns the token and gateway, and routes to agents behind it.

## Layout

```
hub/         the one process that owns the bot token + gateway + router
shim/        per-persistent-agent channel server (hub ↔ claude --channels)
config/      hub.config.json + agents.json (the agent registry)
scripts/     start-agent.sh — launch a persistent agent
```
