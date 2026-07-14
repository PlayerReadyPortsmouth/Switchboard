# Codex Agent Provider Design

**Date:** 2026-07-14

**Status:** Approved

## Goal

Add Codex as an opt-in runtime provider for configured Switchboard agent
sessions while preserving Claude as the default provider and retaining Claude
for the router, librarian, distiller, and overseer.

The first release must preserve the existing Discord-facing behavior: sticky
agent conversations, bounded turn queues, cards and modal interactions, tool
observability, attachments, consults, share links, session resume, and terminal
turn outcomes.

## Scope

This phase covers only explicitly configured agent transports. It does not
replace the hub's internal Claude model calls, expose provider selection at the
hub level, or migrate existing Claude agents automatically.

Codex is dark by default. Existing agent configurations without a `provider`
field remain byte-for-byte equivalent in behavior and continue to use Claude.

## Architecture

`AgentRuntime.provider` selects either the existing `StreamJsonTransport` or a
new `CodexAppServerTransport`. The field is optional and defaults to `claude`.
Both transports implement the existing `AgentTransport` contract and the
additional methods consumed by replica pools, status reporting, interactions,
and session governance.

Each Codex agent or replica owns one long-lived
`codex app-server --listen stdio://` process and one Codex thread. Switchboard
communicates with app-server using its newline-delimited JSON-RPC protocol.
Agent processes remain isolated: each receives its own working directory,
session file, MCP shim configuration, socket, and feature-gate environment.

The existing Switchboard shim remains the agent-facing tool surface. Codex
starts it as a standard STDIO MCP server configured with the same `HUB_SOCKET`,
`AGENT_NAME`, `CONSULT`, `ATTACH_FILES`, `PUBLISH_LINK`, `PEERING`, and
`RECEIPTS` values currently supplied to Claude.

## Configuration

The runtime configuration gains these fields:

```ts
export interface AgentRuntime {
  provider?: "claude" | "codex"
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access"
  codexArgs?: string[]
}
```

`provider` defaults to `claude`. `codexSandbox` defaults to
`danger-full-access`, matching Switchboard's existing full-trust Claude
execution model. Codex turns use approval policy `never`; Switchboard's access
controls, feature gates, approval registry, and audit log remain the governing
boundary. Operators may select `workspace-write` or `read-only` per Codex
agent.

`codexArgs` contains advanced Codex/app-server CLI overrides and is never
interpreted as Claude arguments. Existing `claudeArgs` remains unchanged.

Provider, model, working-directory, Codex sandbox, Codex arguments, resume, and
system-instruction changes are spawn-affecting. A hard reload respawns a
non-pooled persistent agent; pooled agents require a full restart under the
existing reload rules.

Claude and Codex use distinct persisted session filenames. Switching a
configured provider can never feed a Claude session ID to Codex or a Codex
thread ID to Claude.

The project pins `@openai/codex` to an exact version. This supplies a
project-local, platform-specific Codex CLI rather than depending on the Windows
Store executable or an unversioned global installation.

## Startup and Session Lifecycle

Startup occurs in this order:

1. Start the per-agent shim socket listener.
2. Spawn Codex app-server over stdio with per-agent MCP configuration.
3. Send `initialize` and wait for its response.
4. Send the `initialized` notification.
5. Resume the persisted Codex thread when one exists; otherwise start a thread.
6. Persist the returned thread ID and mark the transport available.

Thread start/resume supplies the configured model, working directory, sandbox,
and approval policy. If a persisted thread cannot resume, the transport clears
the stale ID and retries exactly once with `thread/start`. Initialization, MCP
startup, or fresh-thread failure leaves the transport unavailable and reports
the error.

App-server process exit marks the transport unavailable and fails the active
and queued turns exactly once. Switchboard does not introduce an independent
automatic restart policy in this phase; existing hard reload, pool, and process
supervision behavior remains authoritative.

## Turn Data Flow

`deliver()` continues to use `TurnGate`. When a queued inbound becomes active,
the transport sends `turn/start` with the inbound text and current thread ID.
Only one turn runs per agent replica.

The transport correlates JSON-RPC responses by request ID and maps app-server
notifications as follows:

- Agent-message deltas are accumulated into the final textual reply.
- MCP and command item lifecycle events feed existing tool-use/tool-result
  observability callbacks.
- Token-usage notifications update `lastUsageInfo()` and context-fill reporting
  using defensive field parsing.
- `turn/completed` emits the accumulated reply, emits one completed outcome,
  resets per-turn state, and releases the next queued inbound.
- Failed or interrupted turns emit one failed outcome and release the queue.

If the shim posts or updates a card during a turn, the transport suppresses the
final text reply exactly as the Claude transport does. Reactions, edits,
attachments, consults, peer operations, and share links continue through the
existing shim socket callbacks.

Button clicks and modal submissions remain tagged `[interaction]` text. They
are queued as ordinary Codex turns and preserve the originating user and modal
fields.

## Instructions

The Discord modal/card guidance currently appended to Claude's system prompt
is reused for Codex. The transport combines that guidance with the configured
`appendSystemPrompt` and supplies it as Codex developer instructions when the
thread is created or resumed. This keeps provider behavior aligned without
requiring project files to carry Switchboard-specific instructions.

## Protocol and Error Handling

App-server stdout is reserved for JSONL protocol messages; stderr remains a
diagnostic stream. Malformed lines, unknown notifications, and responses for
unknown request IDs are reported defensively and do not crash the hub.

Every outbound request has one pending correlation entry. A response resolves
or rejects it exactly once. Transport close and process exit reject outstanding
requests and terminalize queued work without unhandled promise rejections.

Codex turns are configured with approval policy `never`. If app-server still
sends an unexpected approval or elicitation request, Switchboard explicitly
declines it so the turn cannot hang indefinitely.

No message bodies, MCP environment values, authentication material, or raw
configuration secrets are written to diagnostic output.

## Testing

Unit tests use injected process and socket seams; they do not require Discord,
network access, or real model calls.

Coverage includes:

- app-server argv and MCP configuration construction;
- JSON-RPC framing and response correlation;
- initialization and initialized handshake;
- fresh thread start and persisted thread resume;
- stale-thread fallback exactly once;
- queued turns, overflow, replies, and terminal outcomes;
- agent-message accumulation and card suppression;
- tool lifecycle and defensive token-usage parsing;
- interactions and modal fields;
- malformed protocol frames and unexpected approval requests;
- process exit, pending-request rejection, and idempotent close;
- provider/config validation, defaults, and reload classification;
- provider selection proving Claude remains the default;
- distinct Claude and Codex session paths.

A real-CLI smoke script starts the pinned app-server binary, performs the
handshake, creates a thread, runs a small turn, observes streamed completion,
and resumes the thread. Live Discord/shim behavior is verified separately in a
production-style Linux environment because it requires configured Discord
credentials and Unix-domain sockets.

The completion gate is:

```text
bun run typecheck
bun test
bun run scripts/smoke-codex-app-server.ts
```

The smoke command may be reported as externally blocked only when Codex
authentication or network access is unavailable. Unit tests and typecheck must
still pass.

## Rollout and Rollback

No existing agent changes provider automatically. Canary rollout consists of
setting `runtime.provider` to `codex` on one non-default agent and performing a
hard reload. The default agent remains Claude until live behavior is verified.

Rollback is configuration-only: restore `provider` to `claude` and hard reload
the agent. Provider-specific session files remain separate and may be retained
for a later re-enable.
