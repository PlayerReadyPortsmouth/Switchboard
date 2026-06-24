# Switchboard — Replay / Time-Travel

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Ask the hub **"what did you do because of this, and on whose say-so?"** — `!replay <id>` reconstructs the full effect-chain of a conversation (or a single multi-step action) from the `corr`-threaded audit ledger and renders it as an ordered, grouped timeline. Pure projection over the audit log; the keystone finally pays off as forensics.

---

## 0. Why this, why now

The audit log records every governed effect — `route`, `outbound`, `approval`, `consult`, `mission`, `exec`, `spawn`, `session`, `access`, `event` — each row stamped with a `chat` (which conversation) and, for multi-step actions, a `corr` (which threads request → grant → deliver, or a mission's start → step → done into one logical action). The data to answer **"trace everything that happened from this user message"** already exists in the ledger; nothing reads it back as a *story*.

`!audit` lists rows; **replay reconstructs the chain.** Given a conversation, it shows the route decision and every downstream effect in order, with the `corr`-linked steps visually grouped — so "an approval was requested, a human granted it 28s later, then the webhook fired" reads as one threaded action, not three scattered lines. That's the visible payoff of the `corr` design, and a genuine debugging/forensics tool ("why did this fire? who approved it? what did it cost?").

**No new data, no new dependency, no behaviour change.** Replay is a pure read over the same `audit.jsonl` that `!audit` already reads (with the same rotation caveat — current window only). Operator-gated like `!audit`/`!status`.

New components:

| Component | Responsibility |
| --- | --- |
| **replay core** | Pure: `buildReplay(events, id)` (select by `chat` **or** `corr`, order, group by `corr`, summarise) → a `ReplayTimeline`; `renderReplay(timeline)` → the formatted chat output. |
| **`!replay` command** | Operator-gated: read the ledger tail, build + render the timeline for `<id>`. |

---

## 1. What it shows

`!replay guild:123:456` (a conversation) or `!replay a1` (a single action's `corr`):

```
🧵 replay guild:123:456 — 9 events · 4m12s · $0.0413
14:02:01  route     user:U1 → assistant
14:02:05  outbound  agent:assistant → notify-ops      pending   ┐ corr a1
14:02:05    approval  request → notify-ops             pending   │
14:02:33    approval  grant   user:U2 → notify-ops     ok        │
14:02:34    outbound  deliver → notify-ops             ok        ┘
14:03:10  mission   user:U1 start → ship-feature                ┐ corr run-3
14:03:48    mission   step → research                  ok        │
14:04:35    mission   step → assistant                 ok        │
14:06:13    mission   done → ship-feature              ok        ┘
```

- **Selection:** `<id>` matches events where `chat === id` **or** `corr === id` — so the same command traces a whole conversation *or* drills into one threaded action, without the caller specifying which.
- **Grouping:** events sharing a `corr` are bracketed and indented as one action; standalone events sit at the top level.
- **Summary header:** event count, time span (first→last), summed cost.
- **Metadata only:** time · kind · actor · action · target · outcome — exactly what the ledger holds (no message content, no secrets).

## 2. Replay core (pure, unit-tested)

```ts
// hub/replay.ts
export interface ReplayRow {
  ts: number; kind: string; actor: string; action: string
  target?: string; outcome: string; corr?: string
  groupHead: boolean    // first row of a corr group
}
export interface ReplayTimeline {
  id: string; count: number; spanMs: number; costUsd: number
  rows: ReplayRow[]     // ordered by ts, corr-grouped
}

/** Select the events for `id` (by chat OR corr), order by ts, and group corr
 *  threads together (each group's events kept contiguous, ordered within). Pure. */
export function buildReplay(events: AuditEvent[], id: string): ReplayTimeline

/** Render a timeline to a chat string (header + indented, bracketed corr groups). Pure. */
export function renderReplay(timeline: ReplayTimeline, fmtTime: (ts: number) => string): string
```

- **Ordering:** primary by the group's earliest `ts`, so corr threads stay contiguous and in causal order; ungrouped events interleave by their own `ts`.
- **Empty result** → a friendly "nothing recorded for `<id>`" (the renderer handles `count === 0`).
- Deterministic and pure — `fmtTime` injected, fully unit-tested over a synthetic event set.

## 3. The command

`!replay <id> [scan]` (operator-gated, same `baseGate.listAllowed()` as `!audit`):
1. `audit.recent({ limit: scan })` with `scan` defaulting to **2000** (clamped 200–20000). This matters: an *unfiltered* `recent()` reads exactly `scan` raw rows **before** `buildReplay` selects by chat/corr, so the window must be wide enough that a busy ledger doesn't bury the conversation. `scan` lets an operator widen it further.
2. `buildReplay(events, id)` → `renderReplay(timeline, hh:mm:ss)`.
3. `chunkLines(out, 1900)` → `gateway.sendPlain` each chunk — a long timeline is split on newline boundaries so Discord's 2000-char limit can't reject the whole message.

Reuses the audit reader and the operator gate verbatim — no new config, no new state.

## 4. Boundaries (documented)

- **Current window only.** Like `!audit`, replay reads the live `audit.jsonl`; events rotated to `audit-<ts>.jsonl` aren't included. (A future flag could read across rotations.)
- **Requires audit enabled.** With `audit.enabled` off there's nothing to replay — the command says so.
- **Metadata, not transcript.** Replay shows *what the hub did*, not message text (by the ledger's design).

## 5. From OK to must-have — what this seeds

- **The web dashboard's timeline view.** The same `buildReplay` projection drives a clickable per-conversation timeline in the dashboard (a natural follow-on, no new data).
- **Incident postmortems.** "Replay everything `agent:deploy` touched this hour" generalises the selector from one id to a filter.
- **Cost attribution.** Once turn cost lands in the ledger (`cost` field), replay totals per conversation/action for free.

## 6. Testing

- **buildReplay:** selects by chat and by corr; orders by ts; keeps corr groups contiguous with `groupHead` on the first; computes count/span/cost; empty on no match.
- **renderReplay:** header with count/span/cost; grouped rows indented/bracketed; `count === 0` → friendly empty message; time formatted via the injected fn.

## 7. Build order (each increment shippable, leaves the system working)

1. **replay core** (`hub/replay.ts`) — `buildReplay` + `renderReplay` + types. Pure, unit-tested.
2. **`!replay` command + docs** — wire the operator command over the audit reader; README + PR.
