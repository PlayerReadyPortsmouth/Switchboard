# Switchboard — Vault Gardener & Access-Weighted Memory

**Date:** 2026-06-13
**Status:** Proposed design, pre-implementation
**Depends on:** [`2026-06-13-overseer-memory-design.md`](2026-06-13-overseer-memory-design.md) (memory vault, retriever, dedup)
**One-liner:** Make memory *self-tending* — track how each note is used, let frequently/recently-used notes rise to the top (and surface proactively without an explicit recall), and run a periodic background **gardener** that merges, prunes, archives cold notes, and flags stale/conflicting facts — all without clobbering hand-written notes.

---

## 1. Motivation

The memory system retrieves on demand, but it doesn't yet learn *which notes matter*. Two gaps:

1. **No usage signal.** A note recalled 50× this week and one never touched since it was distilled rank purely by cosine. Importance should compound: useful memories should get easier to reach.
2. **No hygiene over time.** Notes rot (a path/flag named today is wrong in three weeks), near-duplicates accumulate beyond the per-write dedup, and cold notes bloat a scope. Today the only cleanup is per-write dedup.

The fix is a lightweight **access model** + an **access-weighted recall** + a periodic **gardener** that does the slow, whole-vault hygiene off the hot path.

## 2. Access model — `AccessStats`

Per-note usage stats, kept in a **sidecar** (not the note's front-matter — accessing a note must not rewrite it or bump its content `updated` date). Sidecar: `<memoryDir>/.access.json`, keyed by note path.

```ts
interface AccessStat {
  count: number          // total recall/injection hits
  lastAccessed: number   // epoch ms of the most recent hit
  score: number          // decayed importance (see §3)
  scoredAt: number       // when `score` was last decayed (for lazy decay)
}
interface AccessStore {
  hit(path: string, now?: number): void          // a note was injected/recalled
  importance(path: string, now?: number): number // 0..1, lazily decayed
  prune(paths: Set<string>): void                // drop stats for deleted notes
  coldest(scopePaths: string[], n: number): string[]
}
```

- **When is a hit recorded?** Whenever a note is actually *injected* into a turn (the librarian-selected set) or returned by an explicit `recall`. Recall candidates that are *not* selected do not count — selection is the signal.
- The Qdrant backend can mirror `count`/`lastAccessed` into the point payload so hosted deployments keep the signal server-side; the local sidecar remains the source of truth otherwise.

## 3. Importance & decay

Importance compounds frequency with recency, and **decays** so a once-hot note cools if it stops being used (prevents permanent entrenchment):

```
score ← score * 0.5^((now - scoredAt) / halfLife)     // lazy exponential decay on read/update
score ← score + 1                                       // on each hit
importance = 1 - 2^(-score)                             // squashed to 0..1
```

`halfLife` (`decayHalfLifeMs`, default ~14 days) is the only real knob. Decay is computed lazily on read (no timer needed for the score itself).

## 4. Access-weighted recall (the "rises to the top" behaviour)

The retriever blends similarity with importance when ranking recalled candidates:

```
rank = cosine + importanceWeight * importance(path)     // importanceWeight default ~0.15
```

So a slightly-less-similar but heavily-used note can outrank a cold exact-ish match — and the librarian still does final precision selection over the re-ranked candidates. `importanceWeight = 0` reproduces today's pure-cosine behaviour.

## 5. Proactive "hot set" (surfaced without asking)

Per the operator's ask: frequently-used memories should be injected **initially, without needing an explicit recall**. On each turn for a memory-using agent, alongside semantic recall, inject the top-`hotSetSize` (default 3) notes by `importance` within the turn's scopes — the conversation's *working set* — deduped against the semantically-recalled set. Budgeted and capped so it never blows context (it competes within the same ≤5 injected-notes budget; hot-set notes are added first, semantic recall fills the rest).

This is what makes the system feel like it "just knows" the load-bearing facts for a person/project without the agent issuing a `recall`.

## 6. The gardener pass

A periodic, **background, non-blocking** sweep (`gardener.intervalMs`, default ~6h; also runnable on demand). It never blocks message handling and never touches protected (agent-authored) notes destructively. Stages:

1. **Decay & prune stats** — refresh decayed scores; drop sidecar entries for notes that no longer exist.
2. **Whole-vault dedup** — the per-write dedup, but across the entire vault per scope (catches dups that arrived separately). Reuses the existing entity-gate; distiller dups auto-merge (keep most-recently-updated), protected dups only flag to `.dedup-review.jsonl`.
3. **Conflict resolution** — for near-duplicate notes the gate calls "same fact" but whose bodies disagree, prefer the most-recently-`updated`; flag the staler one (`> [!warning] possibly superseded by [[…]]`) rather than deleting (Skippy: notes rot; surface, don't silently drop).
4. **Staleness flagging** — notes whose `updated` is older than `staleAfterMs` and whose body references volatile specifics (paths, flags, versions) get a non-destructive "verify before trusting" flag. (The as-of date already nudges this at read time; the gardener makes it explicit in the note.)
5. **Archival under a size budget** — when a scope exceeds `scopeBudget` notes, move the coldest (low `importance`, not accessed within `archiveAfterMs`, **distiller-authored only**) to `<memoryDir>/<scope>/archive/`. Archived notes are excluded from default recall but remain searchable on an explicit deep `recall` (and restored — un-archived — if hit). Keeps the hot index small (Skippy: the injected index grows fast). Reversible; nothing is deleted.

**Sacred rule throughout:** agent-authored notes are never merged, archived, or deleted by the gardener — only flagged for human review.

## 7. Config

```jsonc
"gardener": {
  "enabled": true,
  "intervalMs": 21600000,        // 6h
  "importanceWeight": 0.15,      // recall boost from usage
  "hotSetSize": 3,               // proactively-injected working-set notes
  "decayHalfLifeMs": 1209600000, // 14d
  "staleAfterMs": 2592000000,    // 30d → staleness flag
  "archiveAfterMs": 7776000000,  // 90d cold → archive candidate
  "scopeBudget": 200             // notes per scope before archival kicks in
}
```

All optional; absent ⇒ gardener disabled and recall stays pure-cosine (today's behaviour). Access tracking itself is cheap and can be on even with the gardener off.

## 8. Components & wiring

| Component | Responsibility |
| --- | --- |
| `hub/memory/accessStore.ts` | `AccessStore` (sidecar JSON, lazy decay, importance, coldest). |
| `MemoryRetriever` | record hits on injected/recalled notes; blend importance into rank; assemble the hot set. |
| `hub/memory/gardener.ts` | the periodic pass (dedup/conflict/stale/archive), using `MemoryStore` + `MemoryIndex` + entity gate + `AccessStore`. |
| `index.ts` | construct `AccessStore`; pass to retriever; schedule the gardener on an `.unref()` interval (like the distiller sweep). |
| `MemoryStore` | add `archive(path)` / `unarchive(path)` (move within scope), and make `list`/recall scope walks skip `archive/` by default. |

Hosted backend: archival = a payload flag (`archived: true`) excluded by the search filter, rather than a folder move; access counts optionally mirrored to the payload.

## 9. Testing

- `accessStore`: hit increments + bumps `lastAccessed`; decay halves `score` after one half-life; `importance` ∈ [0,1) monotonic in score; `coldest` ordering; `prune`.
- recall blend: with `importanceWeight>0`, a frequently-hit lower-cosine note outranks a cold higher-cosine one; `importanceWeight=0` ⇒ identical to today.
- hot set: top-importance notes injected proactively, deduped against semantic hits, within the injection budget.
- gardener (injected entity-gate runner + tmp vault): whole-vault dedup merges distiller dups, flags protected dups; conflict flags staler; archival moves only cold distiller notes and respects `scopeBudget`; protected notes never moved/deleted; archived notes excluded from default recall, restored on hit.
- All model/network calls injected (no real `claude`/HTTP), mirroring existing tests.

## 10. Build order

1. `AccessStore` (sidecar + decay + importance) — pure, fully unit-tested.
2. Retriever records hits + importance-blended ranking (behind `importanceWeight`, default 0 → no behaviour change until enabled).
3. Proactive hot-set injection (budgeted).
4. `MemoryStore.archive`/`unarchive` + default recall skips `archive/`.
5. `gardener.ts` pass + scheduled wiring; whole-vault dedup → conflict → stale → archive.
6. Hosted-backend parity (payload `archived` filter + optional access mirroring).
7. Docs/README + config reference.

## 11. Risks & mitigations

- **Entrenchment** (popular notes never cool): exponential decay + the gardener's stale flags.
- **Sidecar/vault drift** (note deleted, stat orphaned): gardener `prune` step; importance of an unknown path = 0.
- **Over-aggressive archival**: budget + age + cold thresholds must *all* hold, distiller-authored only, reversible, restored on hit.
- **Hit-recording cost on the hot path**: a hit is an in-memory map update + debounced sidecar flush — never a network/model call.
