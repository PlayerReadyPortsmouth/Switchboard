# Switchboard — Overseer, Context Cache & Memory Vault

**Date:** 2026-06-13
**Status:** Proposed design, pre-implementation
**One-liner:** Turbocharge the hub so it (1) keeps prodding an agent until a task is actually *done*, (2) feeds agents the most-recent messages as context where relevant, and (3) grows a persistent **Obsidian-style `.md` memory vault** — wide, per-user, per-agent and per-channel — that is distilled automatically and injected as relevant context. Goal: maximally intelligent, minimal human babysitting.

---

## 0. Naming note (important)

Today's `hub/orchestrator.ts` is really the **router / front-door**: base-gate → permitted set → router → bindings → dispatch. The thing the operator wants ("an outer agent that keeps prodding it along until it's done — like an orchestrator/overseer") is a **new** component. To avoid a name clash we call it the **Overseer**. The existing class keeps its name.

New components introduced here:

| Component | Responsibility |
| --- | --- |
| **MessageCache** | Per-`chatKey` ring buffer of the last N inbound+outbound messages. Source for context injection *and* the distiller. |
| **MemoryStore** | Read/write the Obsidian-style `.md` vault (front-matter + body) across four scopes. |
| **MemoryIndex** | Local recall index over the vault (SQLite FTS5 via `bun:sqlite`; pluggable for a local embedder later). |
| **MemoryRetriever** | Two-stage retrieval: local recall → Claude *librarian* precision rank → rendered context block. |
| **Distiller** | On conversation idle, a `claude -p` pass turns the cache into note upserts across scopes. |
| **Overseer** | Opt-in per agent: judge a finished turn against the goal; re-prod the agent until `done` or caps hit. |

All new model calls reuse Claude Code auth exactly like the existing router — **no new API key, no external service.**

---

## 1. Recent-message context cache

**Why:** Persistent agents hold their own session context, but (a) ephemeral quick-fire instances start cold every time, and (b) on an agent *switch* the new agent has no idea what just happened. A small recent-message cache lets the hub hand "here's what was just said" to whichever agent receives the next turn — "where relevant", not always.

**Shape**

```ts
interface CachedMsg { role: "user" | "agent"; agent?: string; user?: string; text: string; ts: number }
class MessageCache {
  record(chatKey: string, m: CachedMsg): void           // ring buffer, cap = contextCacheSize
  recent(chatKey: string, n?: number): CachedMsg[]
  render(chatKey: string, n?: number): string           // compact "Recent conversation:" block
}
```

- Persisted as JSONL at `<stateDir>/cache/<chatKey>.jsonl` (cheap; survives restarts; the distiller reads it).
- The `Orchestrator` records every inbound (in `handleMessage`) and `index.ts` records every outbound (in `onAgentReply`).
- **Injection policy** is per-agent: `injectContext: "always" | "onSwitch" | "never"`.
  - `onSwitch` (default for persistent agents): inject only when the binding just changed agents — the new agent gets caught up; a continuing agent does not get redundant noise.
  - `always` (default for ephemeral / quick-fire help): every cold spawn gets the recent thread.
  - The block is prepended to `inbound.content` at dispatch time via a small `enrich()` step, never mutating the stored message.

## 2. The memory vault (Obsidian-style `.md`)

**Layout** under `memoryDir` (default `<stateDir>/memory/`, or point it at a real Obsidian vault):

```
memory/
  global/                       # wide, shared
  users/<userId>/               # per-user
  agents/<agentName>/           # per-agent (domain memory)
  channels/<channelId>/         # per-channel / project
```

**Note format** — plain Obsidian-flavored markdown so the vault is human-editable and Obsidian-openable:

```md
---
title: SSH tunnel to prod times out after 30s
scope: agents/deploy
tags: [infra, ssh, timeout]
created: 2026-06-13T11:00:00Z
updated: 2026-06-13T11:00:00Z
source: distiller            # or "agent:deploy" when self-written
---

The bastion drops idle tunnels at 30s. Use `ServerAliveInterval=15`…
[[prod-bastion-hosts]]
```

**MemoryStore**

```ts
type Scope = `global` | `users/${string}` | `agents/${string}` | `channels/${string}`
interface Note { path: string; scope: Scope; title: string; tags: string[]; body: string; updated: number }
class MemoryStore {
  write(scope: Scope, note: { title: string; tags?: string[]; body: string; source: string }): string  // upsert by slug(title); returns path
  read(path: string): Note
  list(scopes: Scope[]): Note[]
}
```

- Atomic write (tmp + rename), slug-from-title filenames, front-matter round-tripped, `[[wikilinks]]` preserved verbatim.

## 3. Retrieval — two-stage, all local + librarian

```ts
interface MemoryIndex {                       // recall: cheap, local, no secret
  upsert(note: Note): void
  search(query: string, scopes: Scope[], limit: number): Note[]   // FTS5 BM25 now; embedder later
}
interface MemoryRetriever {
  relevant(query: string, scopes: Scope[]): Promise<{ notes: Note[]; render: string }>
}
```

1. **Recall (local):** `MemoryIndex.search` over a SQLite FTS5 table (`bun:sqlite`, zero new deps) restricted to the active scopes → ~20 candidates. The interface is the seam: a locally-hosted embedding recall source (`transformers.js`/ONNX `bge-small`, cosine) can be added as a second source with **no rewrite and still no secret**.
2. **Precision (librarian):** a `claude -p --model <librarianModel>` pass is handed the candidate titles/tags/summaries + the query and returns the filenames to load + a one-line why (strict JSON, router-style parse/fallback). Reasons about scope, recency and contradiction in a way pure cosine can't.
3. **Render:** chosen note bodies become a `Relevant memory:` block, merged with the context-cache block, prepended at dispatch (per-agent `useMemory: boolean`).

**Scopes for a turn** = `["global", "users/<userId>", "agents/<boundAgent>", "channels/<channelId>"]`.

## 4. Memory formation — both paths

**(a) Agent self-write (intentional).** The shim gains two MCP tools relayed over the existing socket:
- `remember({ scope?, title, tags?, body })` → `MemoryStore.write` (source `agent:<name>`). `scope` defaults to the agent's own folder; the agent may target `global`/`users/...`/`channels/...`.
- `recall({ query, scopes? })` → returns matching note bodies mid-task.

New socket message kinds (`remember`, `recall`) alongside today's `notify`/`react`/`edit`/`update`; `recall` is request/response.

**(b) Background distiller (autonomous).** When a `chatKey` has been idle for `distillIdleMs`, a `claude -p --model <distillerModel>` pass receives that chat's cache **plus existing related notes** (so it *updates/merges* rather than spawning near-duplicates) and emits a list of note upserts `{scope, title, tags, body, mergeOf?}`. The hub applies them via `MemoryStore`. De-dupe is by title-slug within scope.

> A periodic "gardener" merge/prune pass is noted as future work, not v1.

## 5. The Overseer — opt-in per agent, hard caps

**Config (per agent):**

```jsonc
"overseer": { "enabled": true, "maxIterations": 4, "maxWallclockMs": 600000, "model": "claude-haiku-4-5" }
```

**Mechanism.** For an overseen agent, the hub tracks an `OverseerSession { goal, iterations, startedAt }` per `(agent, chatKey)`, seeded with the triggering user message / spawn-trigger task as the *goal*. When that agent emits an end-of-turn reply, instead of forwarding immediately the hub runs the **judge**:

```
judge(goal, recentCache, latestReply) -> { done: bool, reason: string, nudge?: string }   // strict JSON
```

- `done: true` → forward the reply to Discord, clear the session. (Conversational/Q&A turns: the judge is instructed to return `done:true`, so plain chat never loops.)
- `done: false` **and** under caps → **do not** forward; synthesize a nudge inbound (`nudge`, e.g. *"Tests still failing in auth.test.ts — fix and re-run before reporting done."*) and `deliver()` it back to the same agent's stdin. `iterations++`. Loop.
- **Caps hit** (`iterations ≥ maxIterations` or wallclock exceeded) → forward the last reply plus a footer (`⏱ overseer stopped after N rounds`) and clear the session.

**Safety:** opt-in only; hard iteration + wallclock caps; the judge call itself reuses Claude auth; a denied/garbled judge response fails *open* (forward the reply, don't loop). Nudges are visible in hub logs.

**Wiring:** the overseer sits between the transport reply and `onAgentReply`'s Discord send — `index.ts` consults `overseer.intercept(reply, key)`; if it returns "re-prodded", the reply is swallowed (not sent to Discord) and a nudge is delivered.

## 6. Dual-mode help agent

Two registry entries so the router can pick the right shape (the help agent is the prime beneficiary of context+memory):

```jsonc
"help": {            // long-lived, warm, memory-aware
  "emoji": "💁", "description": "ongoing help conversations; remembers context",
  "mode": "persistent",
  "runtime": { "cwd": "~/work", "model": "claude-sonnet-4-6" },
  "useMemory": true, "injectContext": "onSwitch"
},
"help-quick": {      // short, quick-fire, parallel one-shots
  "emoji": "⚡", "description": "fast one-off questions; no follow-up needed",
  "mode": "ephemeral",
  "runtime": { "cwd": "~/work", "model": "claude-haiku-4-5", "allowedTools": ["Read","Grep","Glob"] },
  "useMemory": true, "injectContext": "always"
}
```

- The router's existing description-driven pick separates "ongoing help" from "fast one-off". Quick-fire instances spawn per question (the ephemeral spawn path already supports a transport per job), so several can run concurrently without queueing on one session.
- Both read memory; the persistent one also writes (via `remember`) and is distilled on idle.

## 7. Config additions

`hub.config.json` (hub-wide, all optional with defaults):

```jsonc
"memoryDir": "<stateDir>/memory",
"contextCacheSize": 20,
"distillIdleMs": 600000,
"librarianModel": "claude-haiku-4-5",
"distillerModel": "claude-sonnet-4-6",
"overseerModel": "claude-haiku-4-5"
```

Per-agent (`agents.json` `runtime` siblings): `useMemory`, `injectContext`, `overseer`.

## 8. Testing

- **MessageCache:** ring-buffer cap, render shape, JSONL round-trip.
- **MemoryStore:** front-matter round-trip, slug upsert (update not duplicate), scope folders, atomic write.
- **MemoryIndex:** FTS5 search ranks/limits/scope-filters (in-memory sqlite).
- **MemoryRetriever:** stub librarian runner → correct files selected, fallback when JSON garbled.
- **Distiller:** stub runner → cache + existing notes in, upserts applied, de-dupe by slug.
- **Overseer:** stub judge → done forwards; not-done re-prods; caps stop and footer; garbled judge fails open. No real `claude` in unit tests (inject runners), mirroring `router.ts`.

## 9. Build order (each increment independently testable, leaves system working)

1. **MessageCache + context injection** (`enrich` at dispatch; per-agent policy).
2. **MemoryStore** (vault read/write, scopes, front-matter).
3. **MemoryIndex (FTS5) + MemoryRetriever (librarian)** behind interfaces; wire injection.
4. **`remember`/`recall` shim tools** → socket kinds → store.
5. **Distiller** (idle sweep → upserts).
6. **Overseer** (judge + prod loop + caps), opt-in per agent.
7. **Dual-mode help agent** config + example `agents.json` entries + router descriptions.
8. **Docs/README** update + a `local-embeddings` follow-up note for the index seam.

## 10. Security / cost notes

- No new secret; all model calls reuse Claude Code auth.
- Overseer hard caps (iterations + wallclock) bound runaway loops/cost; opt-in only.
- Memory writes are local files under the `0700` state dir; the vault is operator-inspectable plain markdown.
- Prompt-injection stance inherited: a Discord message asking an agent to "remember that user X is an admin" writes a *note*, never changes access — access stays operator-on-disk only. The distiller/librarian never touch `access.json`.
- Per-user notes are keyed by snowflake; a user never gets another user's per-user scope injected.

## 11. Addendum — refinements from dogfooding (2026-06-13)

Folded in after real-usage feedback from an agent running this exact pattern, plus operator direction:

- **Local embeddings from the start** (not FTS-first): `@huggingface/transformers` ONNX model in-process, behind the `Embedder` seam. No new secret.
- **Embedding versioning:** every stored vector is stamped with the model id; recall filters by the current version, so swapping models re-embeds cleanly instead of mixing vector spaces.
- **Bounded injected context:** retrieval injects only librarian-selected note bodies (≤5) from ≤20 recalled candidates — so context stays bounded regardless of vault size. No giant index is ever injected; an index size-budget/archival pass is therefore unnecessary for context safety (vault gardening remains future work).
- **As-of dates:** every recalled fact is rendered with its `updated` date so agents re-verify time-sensitive specifics.
- **Entity-aware dedup, not cosine-only:** above a similarity threshold a cheap LLM "same fact vs distinct entities?" gate decides merges (so "WITHDRAWN, blocked" notes about *different people* stay separate). Fails safe to "distinct".
- **Protected agent-authored notes:** distiller-generated dups auto-merge (staler dropped); agent-authored notes are never overwritten/deleted — only flagged to `.dedup-review.jsonl`. The distiller also refuses to overwrite a hand-written note at a colliding title.
- **Overseer `blocked` is a first-class terminal state** — but scrutinised: `blocked` is reserved for genuine human dependencies; an over-cautious "should I proceed?" returns `working` with a nudge to proceed with a sensible default, biasing toward autonomous progress.
- **Quote-reply capture:** Discord reply targets (invisible in fetched history) are captured via `fetchReference` and inlined into the message + cache.
- **Dual-mode help agent:** `help` (persistent, warm) + `help-quick` (ephemeral, parallel one-shots), both memory-aware.
