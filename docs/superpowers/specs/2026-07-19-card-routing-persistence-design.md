# Card-Routing Persistence Design

**Date:** 2026-07-19
**Status:** Approved design — built behind `hub.cardPersistence.enabled` (default off)
**Scope:** `hub/cardRegistry.ts`, `hub/notifyRouter.ts`, `hub/gateway.ts` (modal specs)

## The bug

Every card button posted to Discord dies on hub restart.

All the state that decides where a card click goes is in-memory only:

| State | Owner | What it maps |
|---|---|---|
| `byCorrelation` / `correlationByCustomId` | `CardRegistry` | correlationId → `{chatId, messageId, card}`, customId → correlationId |
| `byCustomId` | `NotifyRouter` | customId → agent key |
| `modalByCustomId` | `Gateway` | customId → `CardModal` |

`CardRegistry`'s own docstring said "not persisted across hub restarts".

After a restart, clicking an ordinary card button:

1. passes the base gate and the notify gate;
2. `Gateway` optimistically swaps the row to a disabled `⏳ Working` button
   (`buildWorkingRow`) — instant feedback, anti-double-click;
3. `notifyRouter.agentFor(customId)` returns `undefined`;
4. `hub/index.ts` silently no-ops.

**The button freezes on "Working" forever with no error shown.** `deploy:`-style gated
actions still run their shell command (they resolve through config, not the registry), but the
card never updates because `CardRegistry` is empty — so the operator sees a dead card and no
outcome either way.

Live impact at time of writing: the `triage` agent's channel carried ~27 cards with live
buttons, and the hub restarted 24 times in one night.

## Design

### Write-through mirror, not a new source of truth

The Maps stay the **only read path** at click time — same lookups, same latency, same
semantics. The store is a write-through mirror plus a boot-time restore. Every call site
collapses to the original code when the store is `null`:

```ts
set(correlationId, chatId, messageId, card) {
  this.index(correlationId, chatId, messageId, card)   // the original body
  this.store?.putCard(correlationId, chatId, messageId, card)
}
```

This keeps the flag-off path byte-identical by construction rather than by careful branching.

### Storage: its own SQLite DB

`<stateDir>/cards.sqlite`, three tables (`card_locations`, `card_buttons`, `card_modals`), own
migration chain in `hub/cardMigrations.ts` with its own `card_schema_migrations` table —
mirroring the precedent `hub/documentsMigrations.ts` set for exactly this reason.

Why not a table in the conversations DB (`switchboard.sqlite`)? Two reasons:

- **It is a cache, not a record.** Every row can be deleted at any moment and the only
  consequence is that old cards stop routing — i.e. today's behaviour. The conversations DB
  holds the canonical transcript; entangling a disposable routing cache with it invites
  someone to treat one like the other.
- **Write pattern.** The TTL sweep churns rows continuously. That traffic has no business
  sharing a WAL with the web transcript hot path.

### Staleness: a 7-day TTL that bounds *resurrection*

Naive persistence makes a card from six months ago clickable forever. A `deploy:go:<pr>`
button firing long after its PR stopped mattering would be genuinely bad.

Every row carries `updated_at`, refreshed on **every** write — so a card the agent edited today
is live today, however old its correlationId. `loadAll()` and `sweep()` apply the same cutoff,
so an expired entry can never come back.

Default **168 hours (7 days)**, configurable. Long enough to survive a weekend or a holiday
gap of restarts; short enough that a deploy button cannot fire months late.

Deliberately, the TTL bounds **restoration only** — nothing expires out of a running hub's
Maps. Within one hub lifetime behaviour is exactly today's. This keeps the flag's blast radius
to precisely the bug being fixed: "clicks survive restarts". Making live in-process entries
expire would be a second, separate behaviour change smuggled in under the same flag.

### Orphaned cards must fail legibly

Persisting the routing table makes a new state reachable: the card outlived its agent. The
button's `agentKey` restores fine, but the agent was renamed/removed from `agents.json`, or it
was an ephemeral worker (`jobId` / clone / `thread-<id>` key) that died with the restart.

`routeCardInteraction` (`hub/cardRouting.ts`, extracted from `index.ts` so the failure modes
are unit-testable without Discord) returns a reason string in both unroutable cases:

- unknown button → *"no longer active — older than the hub's card retention window…"*
- known key, no transport → *"Nothing ran — the agent that owns this button (`key`) is no
  longer running…"*

### The frozen-button UX is itself a bug

Rather than leaving a permanently disabled row, `Gateway.reportUnrouted` **undoes** the
optimistic swap — puts the original buttons back, so the action stays retryable, since it
never ran — and follows up ephemerally with the reason. Best-effort and fully `.catch()`-ed:
this is the interaction hot path.

The gateway's callback contract widens from `=> void` to `=> string | void`
(`NotifyRouteFailure`). `undefined` keeps its historic meaning ("routed, or deliberately
swallowed"), so every existing early-`return` in the handler chain is unchanged.

## Explicitly out of scope: `ApprovalRegistry`

`ApprovalRegistry` is **not** persisted, and that is not an oversight. Its docstring is
explicit: *"in-memory by design, so a hub restart drops pending approvals — the held effect
simply never fires (fail-closed, the safe default for 'require approval')."*

Persisting pending approvals would mean a held effect could fire after a restart nobody
correlated with the approval. That is a **security decision**, not a bug fix, and it belongs
to whoever owns the approvals threat model — not to a card-routing repair.

## Flag

`hub.cardPersistence` — `{ enabled?, dbFile?, ttlHours?, sweepIntervalMs? }`, absent/`false` =
off, placed alongside the other subsystem gates (`shareLinks`, `receipts`,
`toolObservability`) in `HubConfig`.

Note this is a hub-wide gate with **no per-user canary**, unlike ReadyApp's flags. "Which
cards route" is a property of the hub's routing tables, not of the person clicking — a
per-user allowlist would be incoherent (the same card is clicked by different people, and the
routing table is shared). This matches how every other Switchboard subsystem gate works, which
the repo's CLAUDE.md records as this repo's flag system.

**Rollback:** set `enabled: false` and restart. The DB file can then be deleted; nothing else
reads it.

## Verification

- `bun run typecheck` clean; `bun run build:web` succeeds (assets under `/switchboard/`).
- `hub/cardStore.test.ts` — 11 tests: restart survival (construct → persist → discard →
  reconstruct → resolve a customId), modal survival, TTL expiry not resolvable, just-inside-TTL
  restores, re-write refreshes the clock, `forget` not resurrected, orphaned agent fails
  legibly, routable click still delivers, flag-off writes nothing and stays silent, malformed
  rows dropped, store failure never throws on the hot path.
- Live Discord card/button behaviour can only be confirmed on a running hub — not driven here.
