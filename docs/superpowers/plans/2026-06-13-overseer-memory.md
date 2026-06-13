# Plan — Overseer, Context Cache & Memory Vault

**Spec:** [`../specs/2026-06-13-overseer-memory-design.md`](../specs/2026-06-13-overseer-memory-design.md)
**Branch:** `claude/switchboard-memory-system-rzkw57`

Each step compiles, passes `bun test` + `bun run typecheck`, and leaves the hub working. Model-calling code takes an injected runner (like `router.ts`) so unit tests use no real `claude`.

## Step 1 — MessageCache + context injection
- `hub/messageCache.ts`: ring buffer (cap `contextCacheSize`), JSONL persist at `<stateDir>/cache/<chatKey>.jsonl`, `record/recent/render`.
- `hub/enrich.ts`: `enrich(content, { contextBlock?, memoryBlock? })` — prepends blocks, pure.
- Wire: `Orchestrator.handleMessage` records inbound; `index.ts onAgentReply` records outbound; dispatch path applies `injectContext` policy (`always|onSwitch|never`), detecting "switch" from the prior binding.
- Types: `injectContext` on `AgentRuntime`; `contextCacheSize` on `HubConfig`.
- Tests: `tests/messageCache.test.ts`, `tests/enrich.test.ts`.

## Step 2 — MemoryStore
- `hub/memory/store.ts`: scopes, slug-from-title, YAML front-matter parse/serialize (tiny hand-rolled — no dep), atomic write, `write/read/list`.
- Types: `Scope`, `Note`; `memoryDir` on `HubConfig`.
- Tests: `tests/memoryStore.test.ts` (round-trip, upsert-not-duplicate, scope folders).

## Step 3 — MemoryIndex (FTS5) + MemoryRetriever (librarian)
- `hub/memory/index-fts.ts`: `bun:sqlite` FTS5 table, `upsert/search(query, scopes, limit)`; boot scan to populate.
- `hub/memory/retriever.ts`: `relevant()` → recall via index → librarian `claude -p` select (injected `ClaudeRunner`) → render block. Router-style JSON parse + fail-open fallback (recall order).
- `librarianModel` on `HubConfig`; `useMemory` on `AgentRuntime`. Wire retriever into the dispatch enrich step.
- Tests: `tests/memoryIndex.test.ts`, `tests/memoryRetriever.test.ts` (stub runner).

## Step 4 — `remember` / `recall` shim tools
- `shim/server.ts`: register `remember` + `recall` MCP tools; relay over socket (new `remember`/`recall` kinds; `recall` is request/response).
- `hub/transports/shimSocket.ts` + `streamJson.ts`: handle new kinds; `remember` → `MemoryStore.write`, `recall` → `MemoryIndex.search` reply.
- Tests: `shim/server.test.ts` additions; `tests/shimSocket.test.ts` additions.

## Step 5 — Distiller
- `hub/memory/distiller.ts`: `distill(chatKey)` = read cache + related notes → `claude -p` (injected runner) → parse upsert list → `MemoryStore.write` each (de-dupe by slug).
- `index.ts`: idle sweep (reuse the existing `setInterval` pattern) triggers `distill` after `distillIdleMs` of no activity per chatKey.
- `distillIdleMs`, `distillerModel` on `HubConfig`.
- Tests: `tests/distiller.test.ts` (stub runner, upsert application, de-dupe).

## Step 6 — Overseer
- `hub/overseer.ts`: `OverseerSession` map per `(agent, chatKey)`; `intercept(reply, key) -> "forward" | "reprodded"`; judge via injected runner; caps; footer on cap-stop; fail-open.
- Types: `overseer` block on `AgentRuntime`; `overseerModel` on `HubConfig`.
- `index.ts`: route overseen-agent replies through `overseer.intercept` before the Discord send; on `reprodded`, deliver the nudge to the agent and swallow the reply.
- Tests: `tests/overseer.test.ts` (done forwards; not-done re-prods; iteration + wallclock caps; garbled judge fails open).

## Step 7 — Dual-mode help agent
- `config/agents.example.json`: add `help` (persistent) + `help-quick` (ephemeral) with descriptions, `useMemory`, `injectContext`.
- Confirm router descriptions separate "ongoing" vs "one-off"; quick-fire uses the existing ephemeral spawn path (transport per job → concurrent).

## Step 8 — Docs
- README: new "Memory & Overseer" section + config reference; `config/hub.config.json` placeholder fields.
- Spec §3 follow-up: stub `MemoryIndex` embedder seam + a `docs/.../local-embeddings.md` note.

## Conventions
- No new runtime deps beyond `bun:sqlite` (built in). No new secret.
- Mirror existing style: injected runners, strict-JSON parse with fallback, atomic file writes, `.unref()` on timers, tests beside the unit's siblings under `tests/`.
