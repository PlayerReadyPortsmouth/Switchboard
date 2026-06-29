# Memory Browse & Forget — Design

**Date:** 2026-06-28
**Status:** Approved (design), pending spec review → implementation plan

## Problem

The memory vault is write-mostly from Discord: agents `remember` notes and
`recall` them, but an operator has no way to **see what an agent has remembered**,
inspect a specific note, or **forget** one that is wrong, stale, or sensitive.
The `dedup.ts` rule is explicit — agent-authored notes are *"sacred — never
auto-merged or deleted, only flagged"* — which makes a deliberate **human
forget** the only sanctioned way to remove one.

The storage primitives already exist (`hub/memory/store.ts`): `list(scopes)`,
`read(path)`, `notePath`, `remove(path)` (hard delete), `archive(path)` /
`unarchive(path)` (reversible), plus vector + by-title search in the retriever.
So this feature is a **Discord surface over existing primitives**, not new
storage.

## Goal

An operator-only, card-driven way to browse, search, view, and forget vault
notes from Discord, with reversible-by-default forgetting and a deliberate
permanent delete.

Non-goals: editing note bodies from Discord (forget + re-remember covers it);
self-service access for non-operators (deferred — operator-only for v1);
bulk operations; a web UI.

## Global constraints

- **Feature flag, default off:** `hub.memoryBrowse.enabled`. When off, the
  `!memory` command is unregistered and behaviour is unchanged.
- **Operator-gated:** only configured operator user ids may invoke `!memory` or
  its buttons. Non-operators get a polite denial, audited as `deny`.
- **Destructive actions are audited:** every forget/delete writes an audit row
  (actor = operator, the note title + scope) so removals are traceable.
- **Pure renderers/orchestration** where possible, mirroring `statusBoard.ts`
  (pure render) — unit-testable without Discord.
- Discord card limit: ≤25 components per card → the list is paginated.

## Architecture

```
!memory [scope] | !memory search <q> | !memory archived
  → operator + flag gate                              [hub/index.ts]
  → memoryBrowse.list/search(scopes, query)           [hub/memoryBrowse.ts, new]
       (memoryStore.list / retriever search + byTitle)
  → renderListCard(page)                              [hub/memoryCard.ts, new, pure]
  → Discord card with per-note View / Forget + Prev/Next buttons

button: View   → renderDetailCard(note)
button: Forget → renderConfirmCard → confirm → memoryBrowse.forget(path)
                    = store.archive(path) + index.delete(path) + audit
button: Delete permanently → confirm → memoryBrowse.remove(path)
                    = store.remove(path) + index.delete(path) + audit
```

## Components

### 1. Orchestration — `hub/memoryBrowse.ts` (new)

The seam between the command/buttons and the store + index. Injectable deps
(store, index, audit) so it is testable without real I/O.

```
interface MemoryBrowseDeps {
  store: { list(scopes): Note[]; read(path): Note; archive(path): string; remove(path): void; notePath(scope,title): string }
  deindex: (path: string) => Promise<void> | void     // vector index delete
  audit: (action: "memory_forget" | "memory_delete", actor: string, detail: object) => void
}

list(scopes: Scope[]): NoteSummary[]                    // {path,title,scope,tags,source,updatedAt}
search(query: string, scopes: Scope[]): NoteSummary[]   // retriever vector + byTitle fallback
forget(path, actor): { ok: boolean; reason?: string }   // archive + deindex + audit
remove(path, actor): { ok: boolean; reason?: string }   // remove  + deindex + audit
```

- `forget`/`remove` first confirm the path still exists (`read` in a try) → if
  gone, `{ ok:false, reason:"missing" }` (the card shows "note no longer exists").
- De-index failure is caught and logged; the archive/remove + audit still
  proceed (a ghost vector entry is recoverable by a vault reindex; a half-done
  forget is worse).
- `search` reuses the existing retriever (vector with by-title fallback), so it
  works even when the embedder is cold.

### 2. Rendering — `hub/memoryCard.ts` (new, pure)

- `renderListCard(notes: NoteSummary[], page, scopeLabel): CardSpec` — one field
  per note (title · scope · age), ≤5 notes/page; each note an indexed **View** +
  **Forget** button; **Prev/Next** when paginated. `correlation_id` encodes the
  scope/page/query so button clicks reconstruct context.
- `renderDetailCard(note: Note): CardSpec` — title, scope, tags, source, age, and
  the body (truncated to the embed 4096 limit) + **Forget** / **Delete
  permanently** buttons.
- `renderConfirmCard(action, note): CardSpec` — "Archive '<title>'? / Permanently
  delete '<title>'? This cannot be undone." + **Confirm** / **Cancel**.
- Pure → unit-tested (pagination math, truncation, empty state, button ids).

### 3. Command + interaction wiring — `hub/index.ts` (modify)

- Register `!memory` (built-in command, like `!agents`/`!tools`), only when the
  flag is on. Parse `[scope]` / `search <q>` / `archived`.
- Operator gate: invoking user id ∈ `operatorIds` (seeded from
  `deployApproverUserId`), else a denial reply + audit `deny`.
- Button interactions (`View`/`Forget`/`Confirm`/`Delete`/`Prev`/`Next`) route
  through the existing interaction handler (the same path cards already use); the
  customId namespace is `mem:` to avoid clashing with `action:`/`deploy:`. Each
  interaction re-checks the operator gate (buttons are clickable by anyone in the
  channel).

### 4. Config — `hub/types.ts` / `hub/config.ts` (modify)

```jsonc
hub.memoryBrowse: {
  enabled: false,
  operatorIds: []        // user ids; if empty, falls back to [deployApproverUserId]
}
```

## Error handling

- Note already gone (archived/removed between list and action) → "note no longer
  exists", card refreshes; no throw.
- De-index failure → logged; archive/remove + audit still recorded.
- Non-operator clicking a button → denied + audit `deny`; card unchanged.
- Empty scope / no search hits → an empty-state card (`_no notes_`).
- Oversized body → truncated to the embed limit with `…`.

## Security / safety notes

- Operator-only across all scopes is intentional for v1; forgetting is a trusted,
  audited action.
- **Reversible by default:** Forget archives (recoverable via `unarchive`, and a
  later `!memory archived` view); only **Delete permanently** is irreversible, and
  it carries its own confirm. This honours the "agent notes are sacred" rule —
  removal is always a deliberate human act.
- Archived notes already drop out of `recall` (the retriever lists live scope
  dirs only); de-indexing closes the vector-search ghost gap.

## Testing

- **`memoryCard`:** list pagination (≤5/page, Prev/Next presence), detail render,
  confirm copy, truncation, empty state, button-id/correlation encoding.
- **`memoryBrowse`:** `list`/`search` return summaries for the right scopes;
  `forget` calls `archive` **and** `deindex` **and** `audit`; `remove` calls
  `remove` + `deindex` + `audit`; missing-note path → `{ok:false}`; de-index
  failure still archives + audits.
- **Operator gate:** non-operator denied (command and button paths), audited.
- Full suite + typecheck: no new failures/errors vs the known-green baseline
  (1 pre-existing test fail, 2 pre-existing tsc errors).

## Rollout

1. Land behind `memoryBrowse.enabled: false`.
2. Enable on the live hub (config + restart); set `operatorIds`.
3. Verify: `!memory global` lists; View expands; Forget archives (note leaves
   `recall`); `!memory archived` shows it; Delete permanently removes; a
   non-operator is denied; audit rows appear.
