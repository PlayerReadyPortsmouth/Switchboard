# Switchboard — Design

**Date:** 2026-06-02
**Status:** Approved design, pre-implementation
**One-liner:** Turn the official Claude Code Discord plugin (strictly 1 bot ↔ 1 session) into a **hub** that fans one Discord bot out to many Claude Code agents — each with its own setup, behind a small Claude router and per-role/per-user access control.

---

## 1. Motivation & the constraint that shapes everything

The official `discord` plugin is an MCP **channel** server (`server.ts`, Bun + discord.js). It holds the bot token, owns the Discord gateway websocket, does all access control (`access.json`), and is spawned **as a child of one `claude --channels …` session**. Inbound DMs become `notifications/claude/channel` notifications injected into that single session; the session replies with `reply`/`react`/`edit_message` tools. It is strictly **1 bot ↔ 1 Claude session**.

We want **1 bot ↔ many Claude agents**, each with a different setup (cwd, model, MCP servers, tools, system prompt), with a small router deciding which agent a message reaches, and with access gated by Discord **roles and user IDs**.

The hard constraint: **Discord allows only one gateway connection per bot token.** Running N `claude --channels` sessions with the same token is impossible — the second login disconnects the first. Therefore the architecture must be a **single hub process owning the gateway**, with N Claude agents connected to it, plus a router. The existing `server.ts` is ~90% of that hub already.

## 2. Goals / Non-goals

**Goals (v1):**
- One hub process owns the token + gateway + access control.
- A registry of agents, each declaring its **mode** (`persistent` | `ephemeral`), setup, and access rules.
- A **router** (`claude -p --model claude-haiku-4-5`, reusing Claude Code auth) that picks an agent from the caller's *permitted* set.
- **Sticky routing with confident auto-switch**: a conversation stays bound to its agent; the router overrides only on a high-confidence topic change. Explicit switch commands too.
- **Access by Discord roles and user IDs**, resolved even in DMs via guild-member lookup.
- **Agent identity tagging** on every reply (`**🔬 research** · …`).
- Both **persistent** (live `claude --channels` via shim) and **ephemeral** (headless `claude -p --resume`) agents.

**Non-goals (v1):**
- Process supervision / auto-restart of crashed persistent agents (documented follow-up; agents are launched via a provided script).
- Webhook personas / distinct avatars per agent (prefix-tag identity only for v1).
- Voice, slash-command registration beyond simple `!`-prefixed control commands.
- A web dashboard. Config is files on disk.

## 3. Topology

```
                    Discord (one bot token, one gateway)
                              │
              ┌───────────────▼────────────────┐
              │              HUB                │   the only process with the token
              │  gateway · access · router      │
              │  bindings · tagging · sockets   │
              └───┬─────────────┬───────────────┘
        unix socket │           │ spawn (claude -p --resume)
        ┌───────────▼──┐   ┌────▼─────────────┐
        │ persistent    │   │ ephemeral        │
        │ agents        │   │ workers          │
        │ (claude       │   │ (headless,       │
        │  --channels   │   │  per-conversation│
        │  → shim)      │   │  resumed by id)  │
        └───────────────┘   └──────────────────┘
   research / coding (live)   quick Q&A (spawned)
```

One hub. Persistent agents are long-lived `claude --channels` sessions, each connected to the hub through a small **shim** that speaks Claude Code's native channel protocol on one side and a Unix socket on the other. Ephemeral agents are headless `claude -p` spawns the hub runs per conversation and resumes by session id.

## 4. Components

| Component | Runtime | Responsibility |
| --- | --- | --- |
| **Hub** | Bun process, one per bot | Owns gateway + token, base access gate, role/user resolution, router invocation, bindings, transport dispatch, reply tagging + chunking, permission relay. |
| **Channel shim** | MCP server, one per persistent agent (child of that agent's `claude --channels`) | Speaks `claude/channel` protocol toward CC; relays to/from the hub over the Unix socket. Mostly lifted from today's `server.ts`. |
| **Router** | `claude -p --model claude-haiku-4-5` invoked by the hub | Classifies a message to one agent from the caller's permitted set. Returns strict JSON. |
| **Headless worker** | `claude -p --resume` spawned by the hub | Runs an ephemeral agent's turn; isolated, resumable session per conversation. |

## 5. Data flow (one inbound message)

1. Gateway receives the Discord message (`messageCreate`).
2. **Base gate** (reused from today's plugin): is this sender paired/allowlisted at all? Drops strangers/spam. Pairing flow preserved.
3. **Resolve caller** → look the user up as a **guild member across `guildIds`** to read their roles. Roles resolve even in DMs as long as the user shares a configured guild. *(Requires the Server Members privileged intent.)*
4. **Permitted set** = agents whose `access.roles` / `access.users` / `"*"` match the caller.
5. **Control commands** intercept first: `!agents`, `!switch <name>`, `!who`, `!reset` (see §8).
6. **Router**: hub shells `claude -p --model claude-haiku-4-5` with the message, the *permitted* agent list (name + description), and the currently-bound agent. Returns `{agent, confidence, switch}`. **Sticky bias:** keep the current binding unless `agent ≠ current && confidence ≥ switchThreshold` (default `0.7`). No current binding → take the top pick. Router failure/unparseable → fall back to current binding, else `defaultAgent`, else first permitted; never hard-fail a message.
7. **Dispatch** via the bound agent's transport (§6).
8. Reply(s) come back through the transport → hub **prepends the agent tag** (`**🔬 research** · …`, `tagStyle: prefix|embed`) → chunks with the existing ≤2000-char logic → sends to Discord, threading the first chunk under the inbound message.
9. **Permission relay** (persistent agents only, §7): shim forwards a `permission_request` → hub namespaces the request-id by agent → sends Allow/Deny buttons (and the `y/n <code>` text path) to the allowlisted user → routes the answer back to the originating agent's shim.

## 6. The two transports (one interface)

```ts
interface AgentTransport {
  readonly name: string
  deliver(chatKey: string, inbound: InboundMessage): void   // hand a routed message to the agent
  onReply(cb: (reply: AgentReply) => void): void            // agent → hub (reply/react/edit/permission_request)
  isAvailable(): boolean
}
```

### 6a. `ChannelShimTransport` — persistent agents
- The hub runs a **Unix-domain socket server**. Each persistent agent's shim connects and registers `{ agentName }`.
- Messages cross the socket as the **same shapes** Claude Code's channel protocol already uses (`notifications/claude/channel` inbound; `reply`/`react`/`edit_message`/`download_attachment`/`fetch_messages`/`permission_request`/`permission` outbound). The shim is therefore almost entirely lifted from today's `server.ts` — discord.js calls are replaced by socket writes; access control and the gateway are removed (they live in the hub).
- **One persistent agent = one shared CC session, multiplexed by `chat_id`** — exactly how today's plugin serves multiple allowlisted DMs from a single session. The agent sees `chat_id`/`user`/`user_id` on each inbound and replies to the right chat.
- Framing: newline-delimited JSON. Auth: socket file lives under `~/.switchboard/` with `0700`; the shim is handed the socket path + a per-agent registration token via env by `start-agent.sh`.

### 6b. `HeadlessTransport` — ephemeral agents
- Per `chatKey`, the hub runs `claude -p --output-format json [--resume <sessionId>]` with the agent's `cwd`, `--model`, `--allowedTools`, and appended system prompt. It captures the JSON result, emits it as a single `reply`, and stores the returned session id in the binding for next time.
- **Each conversation is its own isolated, resumable session.** No interactive permission relay: ephemeral agents run with a fixed tool allowlist and a non-interactive permission posture (e.g. read-only tools or `--permission-mode` such that no prompt is raised). This is what keeps them cheap and safe to spawn.
- A spawn that exceeds `ephemeralTimeoutMs` is killed; the hub apologizes and keeps the session id for a retry.

## 7. Permission relay (persistent only)

Mirrors today's plugin, with one addition: the hub maps `request_id → originating agent`, so a single user can have concurrent permission prompts from multiple agents without ambiguity. The hub sends the Allow/Deny button row (and accepts the strict `y/n <code>` text reply) to every `allowFrom` user, then forwards `notifications/claude/channel/permission` back to **that agent's shim only**. Group channels are excluded from permission prompts (same security stance as upstream: only explicitly-paired users answer permission prompts).

## 8. Control commands

Bypass the router; only the caller's permitted set is ever shown or selectable.

| Command | Effect |
| --- | --- |
| `!agents` | List the agents this caller may use (emoji, name, one-line description, which is currently bound). |
| `!switch <name>` | Force-bind to `<name>` if permitted; else explain. |
| `!who` | Show the currently-bound agent for this conversation. |
| `!reset` | Clear the binding; the next message is routed fresh. |

## 9. Config — two files

`config/hub.config.json`
```jsonc
{
  "botTokenEnv": "DISCORD_BOT_TOKEN",      // token still comes from .env, never committed
  "guildIds": ["…"],                        // for role resolution (incl. for DM senders)
  "socketPath": "~/.switchboard/hub.sock",
  "stateDir": "~/.switchboard",             // bindings.json, access.json, inbox/, approved/
  "routerModel": "claude-haiku-4-5",
  "switchThreshold": 0.7,
  "defaultAgent": "qa",                     // fallback when routing is ambiguous/fails
  "ephemeralTimeoutMs": 120000,
  "tagStyle": "prefix",                     // prefix | embed
  "chatKeyScope": "user"                    // user | channel  (guild binding granularity)
}
```

`config/agents.json`
```jsonc
{
  "research": {
    "emoji": "🔬", "description": "web research, deep multi-source dives",
    "mode": "persistent",
    "access": { "roles": ["dev", "admin"], "users": [] },
    "runtime": { "cwd": "~/work/research", "model": "claude-sonnet-4-6",
                 "claudeArgs": ["--mcp-config", "…"] }
  },
  "deploy": {
    "emoji": "🚀", "description": "prod deploys, pm2, ssh ops",
    "mode": "persistent",
    "access": { "roles": ["admin"], "users": ["184695…"] },
    "runtime": { "cwd": "~/work/infra" }
  },
  "qa": {
    "emoji": "💡", "description": "quick code & general questions",
    "mode": "ephemeral",
    "access": { "roles": ["*"] },
    "runtime": { "cwd": "~/work", "model": "claude-haiku-4-5",
                 "allowedTools": ["Read", "Grep", "Glob"] }
  }
}
```

Access semantics: a caller is permitted an agent if their resolved roles intersect `access.roles`, OR their user id ∈ `access.users`, OR `access.roles` contains `"*"`. The base gate (pairing/allowlist) still applies first — `"*"` means "any *paired* user," not "the public."

## 10. State, persistence & edge cases

- **Bindings** persisted to `<stateDir>/bindings.json`: `chatKey → { agent, sessionId?, lastActive }`. `chatKey` = `dm:<userId>` or (guild) `guild:<channelId>:<userId>` when `chatKeyScope: user`, or `guild:<channelId>` when `channel`. `sessionId` is set only for ephemeral agents (to `--resume`). Persistent agents hold their own context in the live session, so the binding records only the agent name.
- **Permitted set shrinks mid-conversation** (role revoked) → re-checked every message. If the bound agent is no longer permitted, drop the binding and route fresh over the new set.
- **Router failure / unparseable JSON** → sticky binding, else `defaultAgent`, else first permitted. Never hard-fail.
- **Persistent agent offline** (no shim connected) → hub replies "🔬 research is offline right now" and suggests `!agents`. Restart is manual in v1.
- **Ephemeral spawn timeout** → kill, apologize, retain session id for retry.
- **access.json corruption** → same self-heal as upstream (rename aside, start fresh).

## 11. Project layout & tech

Bun + TypeScript + discord.js v14 + `@modelcontextprotocol/sdk` (shim). The `claude` CLI provides the router and ephemeral workers (reusing Claude Code auth — no separate API key). Transport between hub and shims is a Unix-domain socket with newline-framed JSON.

```
Switchboard/
  hub/
    index.ts            # entry: load config, start gateway + socket server, wire transports
    gateway.ts          # discord.js client; inbound parse, base gate, outbound tag + chunk
    access.ts           # base pairing/allowlist + role/user → permitted-set resolution
    router.ts           # claude -p haiku classifier + JSON parsing/fallback
    bindings.ts         # sticky session store + auto-switch policy + control commands
    permissions.ts      # request_id ↔ agent namespacing for relay
    transports/
      index.ts          # AgentTransport interface + registry
      channelShim.ts    # persistent: unix socket server, channel protocol
      headless.ts       # ephemeral: claude -p --resume
  shim/
    server.ts           # per-persistent-agent MCP channel server → unix socket
  config/
    hub.config.json
    agents.json
  scripts/
    start-agent.sh      # launches a persistent agent's `claude --channels` with env (AGENT_NAME, HUB_SOCKET, token)
  tests/
  package.json  tsconfig.json  README.md  .gitignore
```

## 12. Testing

- **Unit:** access resolution (roles + users + `"*"` → permitted set); sticky/auto-switch policy (given `{current, agent, confidence}` → stay/switch); tag + chunk; router-JSON parse & fallback.
- **Integration:** a stub `claude` binary on `PATH` returning canned JSON for router and ephemeral turns; a mocked discord.js client; an in-memory socket pair for the shim. Assert: inbound → correct transport dispatched; reply correctly tagged + chunked; permission round-trip reaches the right agent.
- **Manual E2E:** real bot with the three example agents; DM + guild channel; trigger a persistent-agent permission prompt; trigger a confident auto-switch; revoke a role mid-conversation and confirm re-route.

## 13. Security notes

- Token only ever from `.env` (git-ignored); never in `agents.json`/`hub.config.json`.
- Base pairing/allowlist gate runs **before** any routing — strangers never reach the router or any agent.
- `"*"` access = any *paired* user, not the public; gated by Discord's own "shared server" + Public Bot toggle as the outer perimeter.
- Permission prompts go only to explicitly-paired `allowFrom` users; never to group-channel members.
- Prompt-injection stance inherited from upstream: a Discord message asking the agent to "approve a pairing" / "add me to an agent" must be refused — access is edited by the operator on disk, never by agent action.
- Socket file under `0700` state dir; per-agent registration token prevents a stray local process from impersonating an agent.

## 14. Build order (increments)

1. **Hub skeleton + gateway split** — lift `server.ts` into the hub; one hard-coded persistent agent via shim over the socket; prove a DM round-trips through hub → shim → CC → back. (No router yet; single agent.)
2. **Registry + access** — `agents.json`, role/user resolution, permitted set, `!agents`/`!who`.
3. **Router + bindings** — Haiku classifier, sticky + auto-switch, `!switch`/`!reset`.
4. **Ephemeral transport** — headless `claude -p --resume`, isolated sessions, timeout handling.
5. **Tagging + permission relay polish** — per-agent tags, namespaced permission relay for persistent agents.
6. **Hardening + docs** — edge cases (§10), README, `start-agent.sh`, E2E pass.

Each increment is independently testable and leaves the system working.
