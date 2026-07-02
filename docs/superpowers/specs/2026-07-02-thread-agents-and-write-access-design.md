# Per-Thread Dev-Agent Instances, ReadyApp Write Access, and Engine Docs — Design

**Goal:** Let a Discord channel bound to an agent (e.g. `dev-agent`) spawn an
independent, isolated instance of that agent per Discord *thread* — each
thread behaves like its own `claude` session with its own context, files,
and conversation history, the way separate tmux panes each run an
independent Claude Code session today. Separately, grant `dev-agent`
production write access to ReadyApp via a scoped MCP key. Finally, once both
land, produce full reference documentation for the Switchboard engine under
`/docs`.

Three independent phases, built in order (each phase's own spec/plan, this
doc covers the design for all three so they're considered together):

- **Phase A** — per-thread agent instances (`Switchboard` engine repo)
- **Phase B** — `dev-agent` → ReadyApp write access (`ReadyApp` repo + prod config)
- **Phase C** — `/docs` engine documentation (`Switchboard` engine repo, after A lands)

---

## Phase A: Per-thread dev-agent instances

### Current state (for reference)

- `HubConfig.channelAgents: ChannelAgent[]` (`hub/types.ts`) pins exactly one
  agent to one Discord channel id. `orchestrator.ts` resolves the pinned
  agent via `resolvePinnedAgent(inbound.chatId, hub.channelAgents)`, where
  `inbound.chatId` is `msg.channelId` (`gateway.ts`).
- `StreamJsonTransport` runs one long-lived `claude -p --input-format
  stream-json` process **per agent name**, with `--resume <sessionId>`
  support; the session id is persisted to `<stateDir>/<agentName>.session`.
- `BindingStore` (`hub/bindings.ts`) maps a `chatKey` to `{ agent, sessionId,
  lastActive }` in a JSON file.
- `ReplicaPool` (`hub/agentPool.ts`) is the closest existing precedent: a
  `sticky: Map<chatKey, replica>` pinning a conversation to one of N
  anonymous pre-started replica processes. It is *not* per-thread — replicas
  aren't isolated by working directory and aren't spawned on demand per
  Discord thread.
- Today, a message posted inside a Discord thread carries the **thread's
  own** channel id, not its parent's. Since that id never appears in
  `channelAgents`, thread messages currently fall through to the default
  agent — silently and unintentionally. There is no existing behavior to
  preserve here.

### Config schema

Two-level toggle, following the existing `trace` / `attachments` /
`outboundAttachments` sub-object convention on `HubConfig`:

```ts
// hub/types.ts
export interface ChannelAgent {
  channelId: string;
  agent: string;
  clearReaction?: string;
  threaded?: boolean; // NEW — threads under this channel get their own agent instance
}

export interface ThreadAgentsConfig {
  enabled: boolean;                      // global kill switch
  idleTimeoutMinutes: number;             // default 60 — suspend (not destroy) after this much inactivity
  maxConcurrentInstancesPerChannel: number; // default 5 — cap live processes per parent channel
}

export interface HubConfig {
  // ...existing fields
  threadAgents?: ThreadAgentsConfig;
}
```

- `threadAgents.enabled: false` (or the section absent) disables the feature
  hub-wide regardless of any per-channel `threaded` flags — matches the
  fail-closed pattern used elsewhere (e.g. `trace.enabled`).
- `channelAgents[].threaded: true` opts a specific channel↔agent pairing in.
  A channel with no `threaded` flag (or `false`) keeps today's behavior:
  thread messages fall through to the default agent.
- Both fields are picked up automatically by the existing generic hub-config
  JSON tree editor (`hub/web.ts`, `hubConfigDraft.ts`) — no new UI code
  needed to *edit* the toggle. `configReload.ts`'s `classifyAgentChange`
  needs one addition: flipping `threaded` or `threadAgents.*` is additive
  (doesn't require restarting the channel's own shared agent process), so it
  should classify as a soft/no-restart config change.

### Routing

New resolution step in the gateway/orchestrator path, before falling back to
the default agent:

1. On inbound message, check `msg.channel.isThread()`.
2. If true, resolve `msg.channel.parentId`.
3. Look up `parentId` in `channelAgents`. If found and `threaded: true`,
   route to the **per-thread instance path** below instead of the channel's
   normal pinned-agent process. If `threaded` is absent/false, preserve
   current behavior (fall through to default agent — unchanged).
4. If `msg.channel.isThread()` is false, resolution is unchanged from today.

The thread's own channel id becomes the natural per-thread key — no new id
scheme needed. This can extend `BindingStore`/a new parallel store keyed by
thread id rather than reusing the channel-level `chatKey` used for
non-threaded pinned agents, so per-thread state doesn't collide with the
parent channel's own binding.

### Process & workspace isolation

Each thread gets, lazily, on its first inbound message:

- **A dedicated process** — not multiplexed through the channel's shared
  long-lived agent process. One `claude` process per active thread instance.
- **A dedicated git worktree**, created via `git worktree add` from the
  agent's configured `runtime.cwd`, at a path like
  `<runtime.cwd>/.threads/<threadId>` — the same isolation mechanism this
  system's own `Agent` tool uses for `isolation: "worktree"`. This is what
  makes concurrent threads safe to edit conflicting files: each has its own
  checkout.
- **A dedicated session file** at `<stateDir>/<agentName>.thread-
  <threadId>.session`, independent of the channel's own `<agentName>.session`.

### Lifecycle

Per your answer: suspend-and-resume, not destroy-and-recreate.

| Trigger | Action |
|---|---|
| No new message for `idleTimeoutMinutes` | Kill the process only (SIGTERM). Worktree and session file are left on disk. |
| New message arrives in a suspended (idle-killed but not archived) thread | Respawn a process with `--resume <savedSessionId>` in the existing worktree — conversation continues with full context, no user-visible discontinuity. |
| Discord thread archived or deleted (`threadUpdate`/`threadDelete` events) | Hard cleanup: kill the process if running, `git worktree remove` the thread's worktree, delete the session file, delete any per-thread binding state. |
| Worktree has uncommitted changes at hard-cleanup time | Do **not** silently discard: reply in-thread (if still reachable) or log a warning, and skip the `git worktree remove` step so the work isn't lost. Leaves an orphaned worktree for manual recovery — acceptable since this should be rare, and losing uncommitted dev work silently is worse. |
| Live process count for a parent channel reaches `maxConcurrentInstancesPerChannel` | Reject the new thread's first message with a reply asking the user to close/let an existing thread go idle first, rather than queuing or silently evicting another thread's live process. |

### Error handling

- Worktree creation failure (dirty base repo state, disk space, path
  collision) → reply in-thread with the error, do not spawn a process, do
  not create partial state.
- Process crash mid-conversation → surfaced the same way the existing
  channel-agent error path already surfaces crashes (reuse, don't
  reinvent).

### Testing

- Routing: thread message with a `threaded: true` parent resolves to the
  per-thread path; thread message with `threaded` absent/false preserves
  today's fallthrough behavior; non-thread messages are unaffected.
- Lifecycle: idle timeout suspends (process killed, files retained);
  a subsequent message resumes via `--resume` in the same worktree; archive
  event triggers full cleanup; cleanup is skipped (with a warning) when the
  worktree is dirty.
- Concurrency cap: the `maxConcurrentInstancesPerChannel + 1`th thread gets
  the rejection reply, not a spawned process.

---

## Phase B: `dev-agent` → ReadyApp write access

### What exists already (no new infrastructure needed)

ReadyApp already has exactly the mechanism this needs:

- `ApiKey` Prisma table (`name, prefix, hash, scopes[], type, createdBy,
  lastUsedAt, revokedAt`).
- `x-mcp-token` header, checked in `apps/api/src/auth.ts`, resolves to a
  scoped identity (as opposed to `x-api-key`/`MCP_SERVICE_KEY`, which is
  hardcoded read-only).
- Domain-bundle scopes in `apps/api/src/lib/scopePermissions.ts`
  (`SCOPE_PERMISSIONS`), e.g. `sessions:write` →
  `["sessions.create", "sessions.update"]`, with `:write` auto-implying the
  matching `:read`.
- Every MCP write tool already goes through a preview → confirm two-step
  (30s token) — an existing safety net that applies automatically to any
  new key, no extra work.
- Audit attribution is automatic: a generated key's caller identity becomes
  `entraOid`/`authSubject` = `apikey:dev-agent`, distinct from human staff
  OIDs, visible via `get_audit_log`.

### What this phase actually does

1. **Provision one new `ApiKey`** — `name: "dev-agent"`, `type: "SERVICE"`,
   `scopes: ["sessions:write", "boards:write", "tickets:write",
   "notifications:write"]`. Created via `POST /admin/api-keys`
   (`apps/api/src/routes/apiKeys.ts`), which requires `apikeys.manage` and
   Entra auth — an `apikey:`-authed caller cannot create its own keys, by
   design, and this design doesn't try to work around that.
   - Explicitly **excluded**: `billing:*`, `safeguarding:*`, `admin:*` —
     financial and child-safety-sensitive domains stay out of dev-agent's
     reach unless a real, specific need shows up later.
2. **Wire the one-time plaintext token** into `dev-agent`'s Switchboard
   runtime config as its MCP server's `x-mcp-token` — the same mechanism
   Switchboard's existing (read-only, shared-key) ReadyApp MCP access
   already uses, just a dedicated key/scope-set for this agent rather than
   reusing the shared one.
3. **Shared across threads** — Phase A's per-thread instances all use the
   same `dev-agent` config, hence the same MCP token. The write identity in
   ReadyApp's audit log is per-*agent*, not per-thread; a thread's writes
   are still attributable to "dev-agent" collectively, not to a specific
   thread. (If per-thread attribution is ever needed, that's a separate,
   later enhancement — not required for this phase.)

### Safety note

Actually creating and installing the production key is a real,
hard-to-reverse action against live business data. It will be executed as
an explicit, confirmed step during implementation — not something that
happens automatically as part of a build/deploy script.

---

## Phase C: `/docs` engine documentation

Scope: document the Switchboard **engine** (this repo) — its config schema
and architecture — with sanitized example configs. Real deployed secrets,
channel/guild ids, and prompts live in the private `ready-switchboard`
config repo and are out of scope; only the *shape* of config is documented
here, via placeholder values.

Sequenced after Phase A lands, so the config reference documents the final
state (including `threadAgents`/`threaded`) rather than needing a rewrite.

Files, all under `Switchboard/docs/`:

- **`README.md`** — index and quick orientation, links to the rest.
- **`architecture.md`** — gateway → orchestrator → transports →
  agentPool/bindings → web dashboard, in prose, including where per-thread
  routing and worktree isolation (Phase A) fit into that flow.
- **`configuration.md`** — full field-by-field reference for `HubConfig` and
  `AgentConfig`: every field, type, default, and purpose. Written directly
  against `hub/types.ts` as the source of truth (not regenerated/inferred)
  so it can't silently drift from the real schema. Covers every existing
  toggle (`trace`, `attachments`, `outboundAttachments`, `channelAgents`,
  `threadAgents`, etc.).
- **`examples/`** — a handful of complete, sanitized `hub.config.json` +
  `agents.json` pairs: single persistent agent, ephemeral agent, replica
  pool, and the new per-thread dev-agent setup.
- **`discord-commands.md`** — the `!`-command reference (`!reload`,
  `!doctor`, `!hard`, `!memory browse/forget/delete`, `!tools`, etc.).
- **`deployment.md`** — env vars, state dir layout, how to actually run/
  deploy the hub process.
- **`web-dashboard.md`** — the web command panel: approvals, live channel
  chat, timeline drill-down, hub-config and agent-config JSON editors.

No new runtime code — this phase is pure documentation authorship, so it
has no error-handling/testing section of its own beyond normal doc review
(cross-check every documented field actually exists in `hub/types.ts`,
every example config actually parses).

---

## Sequencing & dependencies

Phase A → Phase C (docs need the final config shape). Phase B is
independent of A and C and can happen in parallel or in either order,
though A gives Phase B's `dev-agent` more to do (operate across several
concurrent threads) once both are live.

## Non-goals

- Per-thread ReadyApp write attribution (Phase B writes are attributed to
  `dev-agent` as a whole, not to the originating thread).
- Widening ReadyApp scopes beyond `sessions/boards/tickets/notifications`
  — out of scope for this design; a future need would get its own scoping
  conversation.
- Documenting `ready-switchboard`'s actual deployed secrets/config in
  `/docs` (Phase C covers the engine's schema only).
