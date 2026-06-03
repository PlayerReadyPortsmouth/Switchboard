# Design: stream-json agent transport (replacing `--channels`)

**Date:** 2026-06-03
**Status:** approved (design), pending implementation plan

## Problem

The hub talks to its Claude Code agents through the experimental
`claude --channels "command:<shim>"` mechanism: a persistent agent is a
`claude --channels` session whose channel server is the Switchboard shim
(`ChannelShimTransport`), and ephemeral agents are one-shot `claude -p`
spawns (`HeadlessTransport`).

**This no longer works with the current Claude CLI.** Verified on claude
2.1.81 and 2.1.161:

- `--channels` only accepts `plugin:<name>@<marketplace>` or `server:<name>`
  entries now. The `command:<cmd>` form the engine relies on is **rejected**.
- Using `--channels server:<name>` (shim registered as an MCP server) the shim
  *connects and registers*, but a delivered channel message produces no agent
  turn: the `notifications/claude/channel` protocol the shim speaks no longer
  drives the agent. The engine's Discord E2E was never actually proven, and CLI
  changes have since broken it.

## Goal

Drive agents through the **documented headless streaming protocol** instead of
the experimental channels feature, with no loss of capability (rich cards,
gated buttons, persistent + ephemeral agents), and minimal churn to the rest of
the hub (router, gateway, deploy gate, scheduler, webhook/command wiring).

## Proven foundation

A real-CLI smoke test (claude 2.1.161) confirmed the full round-trip works:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --mcp-config <file> --strict-mcp-config \
  --dangerously-skip-permissions \
  --model <model> --append-system-prompt <prompt>
```

- **Inbound:** writing `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}\n`
  to **stdin** triggers a turn. Keeping stdin **open** keeps the session alive.
- **Reply:** each turn ends with a `{"type":"result","result":"<text>"}` event on
  **stdout** — this is the agent's user-facing reply.
- **Cards/tools:** the shim, registered as a **normal MCP server** via
  `--mcp-config`, exposes `post_card`/`react`/`edit`; the agent's tool calls are
  forwarded to the hub over the **existing Unix socket** (unchanged wire framing).
  Verified: the agent called `mcp__switchboard-shim__post_card` and the card
  arrived over the socket, while the turn's `result` arrived on stdout.

## Architecture

### New: `StreamJsonTransport` (`hub/transports/streamJson.ts`)

Implements the existing `AgentTransport` interface and owns one agent process.

- **Spawns** `claude -p --input-format stream-json --output-format stream-json
  --verbose --mcp-config <generated> --strict-mcp-config
  --dangerously-skip-permissions [--model …] [--append-system-prompt …]
  [claudeArgs…]` with `cwd = runtime.cwd` and env
  `{ …process.env, HUB_SOCKET, AGENT_NAME }`.
- **Generates** a per-agent MCP config file registering the shim
  (`{ command, args:[shim], env:{ HUB_SOCKET, AGENT_NAME } }`).
- **Owns a Unix-socket server** (the shim connects back to it) for tool-call
  relay — the inbound *tool* direction is identical to today's shim socket; the
  transport emits `notify`/`react`/`edit` `AgentReply`s from it.
- **`deliver(chatKey, inbound)`** → writes a stream-json user message to stdin.
  Tracks the inbound's `chatId` as the "pending reply target".
- **`sendInteraction(customId, userId)`** → writes a stream-json user message to
  stdin (a tagged `[interaction] custom_id=… user_id=…` text the agent prompt
  understands). Replaces the old shim `interaction_result` channel notification.
- **Reads stdout** newline-delimited JSON; on a `result` event, emits a `reply`
  `AgentReply` to the pending chat target.
- **`isAvailable()`** → process spawned and not exited.
- **Teardown:** `close()` ends stdin, kills the process, removes the socket and
  generated MCP config.

### Simplified: `shim/server.ts`

Becomes a plain stdio MCP server exposing `post_card`/`react`/`edit` (and,
optionally retained, `reply`), forwarding each tool call to the hub over the
socket exactly as today. The channel-specific paths — the inbound channel
notification, the `permission_request` relay, and the `interaction_result`
notification — are removed: inbound and interactions now arrive via the agent's
stdin (owned by the transport), not the shim. The shim's socket connection
becomes effectively one-way (shim → hub tool calls); it still sends `register`
on connect so the transport knows the agent is wired.

### Replaced

`ChannelShimTransport` and `HeadlessTransport` are both superseded by
`StreamJsonTransport`. Consequences:

- **Persistent agents** = one `StreamJsonTransport` started at hub boot.
- **Ephemeral agents** (spawn-trigger workers) = a `StreamJsonTransport` keyed
  by `jobId`, with the trigger task delivered as the first stdin message, kept
  alive for any card → interaction loop, torn down on idle or process exit. An
  optional `teardownCommand` on `SpawnTrigger` (interpolated like
  `setupCommand`) lets a consumer clean up (e.g. remove a worktree).
- This **subsumes the old "ephemeral agents can't post cards" gap**: every agent
  is now a full session with the shim MCP, so spawned workers post cards and
  receive button clicks like any persistent agent.

### Permissions

Agents run with `--dangerously-skip-permissions` — they are first-party agents
on first-party infrastructure. The **only** gate is the existing button-level
authorization in `gateway.ts`: `deploy:*` customIds are restricted to
`deployApproverUserId`. A worker that performs a release does the release step
only *after* it receives the (gated) interaction message on its stdin. The
shim's permission-relay machinery and `gateway.sendPermissionPrompt` are no
longer exercised by these agents (left in place but dormant).

### Unchanged

`gateway.ts` (Discord I/O, card building, `parseNotifyCustomId`, deploy gate) —
except `onNotifyButton` now routes the click to the owning transport's
`sendInteraction()` instead of a shim `sendInteractionResult()`. `notifyRouter`,
`deployGate`, `scheduler`, `webhookListener`, the orchestrator/router, and the
`HubConfig`/`AgentRegistry` config schema are all unchanged. Existing deployment
configs keep working (`runtime.model`/`appendSystemPrompt`/`allowedTools`/
`claudeArgs` are all still honoured; `allowedTools` is informational under
skip-permissions).

## Wire formats

- **stdin user message:** `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prefix> <body>"}]}}`
- **stdin interaction message:** same envelope, text = `[interaction] custom_id=<id> user_id=<uid>`
- **stdout reply event:** `{"type":"result","subtype":"success","result":"<text>",…}` → reply text
- **socket (shim → hub):** unchanged `{ t:"notify", chatId, card, correlationId }` / `{ t:"react"|"edit", … }`

## Routing replies & interactions across agents

`notifyRouter` already maps a card's button `customId`s → an agent key. The hub
keeps a registry of live transports by key (persistent name, or `jobId` for
workers); a button click resolves `customId → key → transport.sendInteraction`.
Reply attribution: stream-json turns are sequential per process, so the
transport attributes a `result` to the `chatId` of the most-recently-delivered
inbound for that agent.

## Testing

- **Pure/unit (bun test):** stdout event parsing (`result`/`assistant`/ignore
  noise), stdin message framing (`deliver`/`sendInteraction` envelopes), MCP
  config generation, teardown idempotence, and the spawn argv builder. The
  process and socket I/O sit behind injected seams (a spawn function + the
  socket transport) so the transport logic is unit-testable without a real CLI.
- **Integration (manual, scripted):** the proven smoke test promoted to a
  repeatable `scripts/` check — spawn a real `claude` stream-json agent, deliver
  a message, assert a stdout reply and a socket-relayed card.

## Out of scope

No changes to Discord intents, the base/role gate, the router, or the public
config schema. No backward-compatibility shim for the dead `--channels command:`
form — it is removed.

## Risks

- **CLI drift:** stream-json is documented and stable (the SDK uses it), so far
  lower risk than the experimental channels protocol.
- **Reply attribution under interleaving:** sequential turns make this safe in
  practice; if an agent is delivered two inbounds before replying, replies map
  to delivery order. Acceptable for the hub's one-channel-per-agent usage.
