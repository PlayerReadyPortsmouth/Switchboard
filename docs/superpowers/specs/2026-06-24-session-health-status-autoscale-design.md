# Switchboard — Session Health, Live Status Board & Agent Auto-Scaling

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Stop persistent agents drowning in their own context, make what the hub is doing *visible* in a live Discord embed, and let a hot agent **scale out** into replicas under load — all driven by two new signals the hub currently throws away: per-turn **token usage** (how full each context is) and per-agent **turn state** (busy / queue depth).

---

## 0. Motivation & the missing signals

Two facts about today's hub drive this whole design:

1. **A persistent agent is one long-lived `claude` process whose context grows unbounded.** There is no compaction, no token tracking, nothing watching a window fill until the CLI silently auto-compacts (lossy) or errors. The overseer actually *amplifies* this — it runs an extra judge call per turn and prods the agent into *more* turns, bounded only by iteration/wallclock caps, never by tokens.
2. **The Claude CLI already reports usage we discard.** Every stream-json `result` event carries `usage` (input / cache-read / cache-creation / output tokens), `num_turns`, `duration_ms`, and `total_cost_usd`. `parseStreamEvent` (`hub/transports/streamJsonFraming.ts:15`) reads only `ev.result` text and drops the rest.

Capturing that usage gives a live **context-fill estimate**; tracking turn boundaries gives **busy/idle + queue depth**. Those two signals are the foundation that the governor, the status board, *and* auto-scaling all consume. Build the signals once; three features fall out.

The reset *action* also already exists: `resetAgentSession()` (`hub/index.ts:317`) drops an agent's session file and respawns it fresh — today fired only by the manual `clearReaction` emoji. The governor just needs to drive it automatically.

New components introduced here:

| Component | Responsibility |
| --- | --- |
| **UsageMeter** | Parse `usage`/cost from each stream-json `result`; expose a live context-fill estimate per agent (and per replica). Foundation. |
| **TurnGate** | Per persistent agent: one-turn-in-flight gate + bounded inbound queue. Emits `busy` / `queueDepth` / `lastTurnMs`. |
| **SessionGovernor** | Watch context fill; soft-nudge the agent to checkpoint to memory, then hard auto-compact via `resetAgentSession`. Evolves the Overseer wiring. |
| **StatusRegistry** | Central in-memory snapshot of hub state: persistent agents, overseer/governor activity, router decisions, ephemeral agents. |
| **StatusBoard** | Render the registry to a single live Discord **embed**, pinned to a status channel, edited on change + heartbeat. |
| **AgentPool** | Replica pool behind a logical persistent agent: scale out under sustained queue pressure, idle replicas back down, conversations stay sticky to a replica. |

All new model calls reuse Claude Code auth exactly like the router/overseer — **no new API key, no external service.** Every new behaviour is **opt-in per agent or per hub**, defaulting off, so current behaviour is unchanged until configured.

---

## 1. UsageMeter — capture what we already emit (foundation)

**Why first:** zero behaviour change, tiny surface, and every later feature depends on it.

**Parse.** Extend the `result` stream event and parser:

```ts
interface TurnUsage {
  inputTokens: number          // ev.usage.input_tokens
  cacheReadTokens: number      // ev.usage.cache_read_input_tokens
  cacheCreationTokens: number  // ev.usage.cache_creation_input_tokens
  outputTokens: number         // ev.usage.output_tokens
  numTurns?: number            // ev.num_turns
  costUsd?: number             // ev.total_cost_usd
  durationMs?: number          // ev.duration_ms
}
type StreamEvent =
  | { kind: "result"; text: string; usage?: TurnUsage }
  | { kind: "assistant" }
  | { kind: "init"; sessionId: string }
```

- **Context-fill estimate.** The prompt sent on the last turn ≈ the conversation's current size:
  `contextTokens = inputTokens + cacheReadTokens + cacheCreationTokens`.
  `fillPct = contextTokens / contextWindow(model)`.
- **Window per model** from a small hub map with a default: `contextWindows: { "claude-sonnet-4-6": 200000, "default": 200000 }`.
- **Surface.** `StreamJsonTransport` stores `lastUsage` and exposes `contextTokens(): number` + `fillPct(model): number`, and forwards usage on the reply (`AgentReply` gains optional `usage`) so `onAgentReply` can record it into the StatusRegistry and feed the governor.

> **Field-name verification:** exact `usage` keys vary across CLI versions. Read every field defensively (missing → 0/undefined) and confirm against a real `claude` using the existing `scripts/smoke-streamjson.ts` harness before relying on thresholds. The parser must never throw on an unexpected shape.

**Tests:** parse a real-shaped `result` line → correct `TurnUsage`; missing/garbled `usage` → `usage: undefined`, text still extracted; `fillPct` math + window lookup + default fallback.

---

## 2. TurnGate — one turn in flight, bounded queue

**Why:** today `deliver()` writes straight to an agent's stdin (`streamJson.ts:150`). A burst of messages all land mid-turn; nothing knows the agent is busy. We need turn boundaries both to stop pile-ups *and* to produce the load signal scaling/status need.

**Mechanism (per persistent transport):**
- A **turn starts** on `deliver`, **ends** on the next `result` event. Track `busy: boolean`.
- While `busy`, new inbounds enter a bounded FIFO `queue` (cap `maxQueueDepth`, default 8). On `result`, dequeue and deliver the next.
- **Optional coalescing:** consecutive queued messages from the *same user in the same conversation* may be folded into one delivery (config `coalesceBurst`, default off) to cut redundant turns.
- **Overflow:** past the cap, reply to the user with a soft "busy, queued" notice rather than dropping silently (and this is exactly the pressure signal AgentPool watches).
- Emits: `busy`, `queueDepth`, `lastTurnMs`. Ephemeral/one-shot agents are **not** gated (they're single-turn by construction).

**Tests:** sequential delivers run one-at-a-time; a second deliver while busy queues; `result` drains the queue in order; cap enforced; coalescing merges same-conv burst; signals reported.

---

## 3. SessionGovernor — checkpoint, then compact

**Why:** keep a persistent agent's context bounded without losing what it knows. Opt-in per agent.

**Config (per agent `runtime`):**
```jsonc
"sessionGovernor": { "enabled": true, "softPct": 0.75, "hardPct": 0.90, "strategy": "restart" }
```

**Mechanism.** On each finished turn, read `fillPct` from the UsageMeter for that agent:

- **Soft (`fillPct ≥ softPct`)** — inject a one-shot *checkpoint nudge* (a synthesized system message via the existing `deliverToAgent` path): *"You're at ~N% context. Persist anything important with the `remember` tool, wrap up the current step, and avoid starting large new file reads."* Debounced so it fires once per crossing, not every turn. This leans on the **memory vault that already exists** — so a later reset loses nothing durable.
- **Hard (`fillPct ≥ hardPct`)** — orchestrated **auto-compaction**:
  1. deliver *"Write a ≤200-word handoff summary of the current task state and any next steps, then stop."*;
  2. capture that reply; persist it to the memory vault (agent scope) **and** the `messageCache` for this conversation;
  3. call `resetAgentSession()` (existing primitive — fresh session, bounded context);
  4. the next dispatch's `enrich()` seeds the fresh session with that handoff (reuses the existing memory + context-cache injection path).
- **`strategy`** selects the compaction mechanism: `"restart"` (default — the checkpoint+`resetAgentSession` flow above; deterministic, reuses existing code) or `"cli"` (send `/compact` to stdin where the CLI supports it; preserves the session id but depends on CLI behaviour — treated as experimental).

**Interaction with the Overseer.** The governor runs in the same finished-turn intercept the overseer already owns (`overseer.intercept`, wired at `index.ts:215`). When a governor compaction is in progress for an agent, the overseer **suppresses prodding** for that turn (don't push more work into a session being reset). This is the bound that replaces the explicit "overseer token budget" idea — the governor caps context globally, so the prod loop can't run a window to overflow.

**Safety:** opt-in; the handoff/compaction adds one model turn but saves far more by bounding context; reset reuses the audited existing primitive; a failed/garbled handoff falls back to a plain `resetAgentSession` with a logged warning (never a stuck session).

**Tests (injected seams, no real `claude`):** soft crossing emits exactly one checkpoint nudge (debounced); hard crossing runs handoff → persist → reset → seed in order; failed handoff still resets; governor-active suppresses an overseer prod; disabled agent → no-op.

---

## 4. StatusRegistry + StatusBoard — the live channel embed

**Why:** make the hub legible. One pinned, self-updating embed showing every moving part.

**StatusRegistry** — a single in-memory snapshot, updated by hooks already on the hot path (no polling of subprocesses):

```ts
interface AgentStatus {
  name: string; emoji: string; mode: "persistent" | "ephemeral"
  alive: boolean; busy: boolean; queueDepth: number          // TurnGate
  fillPct: number; costUsdSession: number                    // UsageMeter
  boundConversations: number; replicas: number               // bindings / AgentPool
  lastActivityMs: number
}
interface OverseerStatus { agent: string; goal: string; round: number; max: number; state: "prodding" | "compacting" }
interface RouterEvent { ts: number; conv: string; chosen: string; confidence: number; switched: boolean }
interface EphemeralStatus { jobId: string; task: string; ageMs: number; idleInMs: number }
```

Feeds, all from existing seams:
- **Persistent agents** — `alive` from the transport; `busy`/`queueDepth` from TurnGate; `fillPct`/cost from UsageMeter; `boundConversations` from `BindingStore`; `replicas` from AgentPool.
- **Overseer / governor** — from `Overseer.sessions` (goal, round, caps) plus a `compacting` flag from the governor.
- **Router (the Haiku resolver)** — push a `RouterEvent` each time `route()` returns a decision (rolling window of the last ~10, plus a routes/10-min rate).
- **Ephemeral agents** — from the spawn path: jobId, interpolated task summary, age, idle-timeout countdown.

**StatusBoard** — renders the registry to a Discord embed, posts once to `statusChannelId`, then **edits that same message** (reuses `gateway` card edit + `CardRegistry`). Updated on a debounced state-change **and** a heartbeat (`statusRefreshMs`, default 15 s). Edits are throttled to ≤1 per ~5 s to stay clear of Discord rate limits (coalesce intervening changes).

Sketch:
```
📡 Switchboard — live                                   updated 12:04:31
Persistent
  🤖 assistant   ● busy   ctx 62%   q:2   3 convs   ×2 replicas
  💁 help        ○ idle   ctx 18%   q:0   1 conv
Overseer
  assistant → "re-run auth tests" (round 2/4)
Router (haiku)   last: #ops → assistant (0.91)   · 14 routes / 10m
Ephemeral
  ⚡ a1b2  "deploy preview"  0:38   (idle in 4:22)
```

This is a **read-only** consumer of §1–§2 (and §5) — it ships safely once those signals exist, and is independently useful even before the governor/pool.

**Tests:** registry update reducers (agent up/down/busy, router event ring, ephemeral add/expire); renderer snapshot for a known registry; edit-throttle coalesces rapid updates into one edit.

---

## 5. AgentPool — auto-scale a hot agent into replicas

**Why:** one busy persistent agent serializes everything behind it. Under sustained load, spin up additional **replicas** of the same logical agent to serve *different* conversations in parallel.

**Model.** A logical persistent agent maps to **1..N replicas**, each its own `StreamJsonTransport` with its own session/context. Replicas are named `assistant`, `assistant#2`, `assistant#3` for display.

**Routing & stickiness.** Bindings carry the replica: `chatKey → { agent, replicaId, sessionId }`.
- A conversation already bound to a replica **always** returns to it (context continuity — replicas do **not** share context).
- A *new/unbound* conversation during overflow is assigned to the least-loaded live replica, or triggers a scale-up. Continuity for a fresh replica comes from the **memory vault + messageCache `enrich()`** that already runs at dispatch — no shared process context needed.

**Scale-up.** Trigger when pressure is *sustained*, not spiky: `every live replica busy` AND `total queueDepth ≥ scaleUpQueue` for ≥ `scaleUpSustainMs`. Spawn one replica (respecting `max`). Cooldown between spawns.

**Scale-down.** A non-primary replica with **no bound active conversations**, idle ≥ `replicaIdleMs`, is closed (always keep `min`, default the primary). Bound conversations are never force-migrated.

**Config (per agent `runtime`):**
```jsonc
"pool": { "min": 1, "max": 3, "scaleUpQueue": 2, "scaleUpSustainMs": 30000, "replicaIdleMs": 600000, "isolateCwd": false }
```

**Working directory.** By default replicas share the agent's `cwd` (fine for read-mostly agents). For agents that **write**, set `isolateCwd: true` to give each replica its own git worktree (reusing the existing `spawnTrigger` worktree pattern) so parallel replicas don't clobber each other.

**Scope & risk.** This is the most invasive change — it touches the Dispatcher (N transports per name), `BindingStore` (replica id + per-replica session files), and the orchestrator's dispatch path. It ships **last**, opt-in per agent, with a hard `max` cap so scaling can never run away. With `pool` absent, an agent behaves exactly as today.

**Tests:** binding round-trips replicaId; sticky conversation returns to its replica; sustained-pressure predicate (busy + queue + duration) triggers exactly one scale-up under cooldown; idle non-primary replica scales down while primary persists; bound conv never migrated; `max` cap respected.

---

## 6. Config additions

`hub.config.json` (hub-wide, optional, defaults shown):
```jsonc
"statusChannelId": "<channel id>",          // live status embed location (absent ⇒ board off)
"statusRefreshMs": 15000,
"contextWindows": { "default": 200000 }     // per-model overrides keyed by model id
```

Per-agent (`agents.json` `runtime` siblings, all optional):
```jsonc
"sessionGovernor": { "enabled": true, "softPct": 0.75, "hardPct": 0.90, "strategy": "restart" },
"maxQueueDepth": 8,
"coalesceBurst": false,
"pool": { "min": 1, "max": 3, "scaleUpQueue": 2, "scaleUpSustainMs": 30000, "replicaIdleMs": 600000, "isolateCwd": false }
```

---

## 7. Build order (each increment independently shippable, leaves the system working)

1. **UsageMeter** — capture `usage`/cost from `result`; surface `contextTokens`/`fillPct`; record into replies. *No behaviour change.*
2. **TurnGate** — in-flight gate + bounded queue + busy/queue signals (persistent agents).
3. **SessionGovernor** — soft checkpoint-nudge → hard compact/reset, opt-in; suppress overseer prod while compacting.
4. **StatusRegistry + StatusBoard** — live embed; read-only consumer of 1–2 (and 5 when present).
5. **AgentPool** — replica scale-out/in, opt-in; consumes 2's signals; touches dispatcher/bindings/orchestrator.
6. **Docs/README** + a `!usage` / `!health` command surfacing per-agent tokens/cost/context% (trivial on top of 1).

Increments 1, 2, 4 are low-risk and independently valuable even if 3 and 5 are deferred.

---

## 8. Security / cost notes

- **No new secret** — every model call (handoff, future judge) reuses Claude Code auth; replicas spawn the same way persistent agents already do.
- **Bounded everything** — governor thresholds bound context (and therefore per-turn cost); AgentPool has a hard `max`; TurnGate has a queue cap; StatusBoard edits are throttled.
- **Governor cost** — a handoff summary is one extra model turn at the *hard* threshold only; it pays for itself by preventing the much larger cost of a maximally-full window every subsequent turn.
- **Status embed is read-only** and posts to a single operator channel; it surfaces task summaries and routing — keep it in an operator-visible channel, not a user-facing one (it reveals which agent handled what).
- **Replica isolation** — `isolateCwd` worktrees prevent parallel write clobbering; without it, replicas are assumed read-mostly on a shared cwd.
- **Prompt-injection stance inherited** — a synthesized governor/handoff message is a *system* nudge to the agent; it never touches `access.json` or pairing. Auto-scaling changes *which process* serves a conversation, never *who is allowed* to reach it (access is still resolved per message, upstream of the pool).

---

## 9. Open design questions (for sign-off)

1. **Auto-scaling stickiness** — proposed: bound conversations never migrate (context continuity); only *new* conversations load-balance/trigger scale-up. Alternative: migrate by seeding a replica from the memory vault + handoff (more balancing, risk of context loss). Default = no-migrate. **OK?**
2. **Shared vs. isolated cwd for replicas** — default `isolateCwd: false` (shared, read-mostly). Agents that write probably want `true`. Should isolation default *on* for any agent whose tools include `Write`/`Edit`/`Bash`? (Safer, but heavier.)
3. **Compaction strategy** — default `"restart"` (deterministic, reuses `resetAgentSession`) vs. `"cli"` (`/compact`, preserves session id but CLI-version-dependent). Keep `"restart"` as the shipped default and treat `"cli"` as experimental? 
4. **Status board placement** — one global board in `statusChannelId`, vs. also an on-demand `!status` ephemeral render in any channel. Start with the single pinned board?
