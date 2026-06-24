# Switchboard — Unified Audit Log (the trust keystone)

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Generalize the outbound delivery log into **one append-only record of every governed effect** the hub performs — who did what, to what, when, and how it turned out — so the whole system is queryable, reviewable, and trustworthy. This is the keystone the gated-action catalog, metrics, inter-agent work, and the web surface all write into.

---

## 0. Why this, why now

Switchboard now performs real side effects: it routes messages to agents, spawns ephemerals, runs `directCommands`, fires outbound webhooks, resets/compacts sessions, and gates access. Each of these is logged **somewhere or nowhere** — the outbound engine writes `outbound-log.jsonl`, routing pokes the `StatusRegistry`, the rest is `stderr` at best. There is **no single answer to "what has this hub done, and on whose say-so?"**

That question is the biggest trust lever for anything touching real systems, and the outbound spec (`2026-06-24-outbound-webhooks-design.md`, §7) already promised this feature as the generalization of its delivery log. We build it now because everything queued behind it needs it: the **gated action catalog** records every approval/denial *as* an audit event; **metrics** counts and rolls up audit events; **inter-agent** calls and **web** requests are governed effects that must land in the same ledger. Build the ledger once, here.

Done naively this is "sprinkle `console.log` everywhere." Done right it is **one typed event, one append-only file, one query surface** — secrets redacted, message bodies excluded by default, never throwing on the hot path, off unless configured.

New components:

| Component | Responsibility |
| --- | --- |
| **AuditEvent** | One typed, flat, greppable record — `kind` / `actor` / `action` / `target` / `outcome` / `detail` — for every governed effect. |
| **audit core** | Pure: normalize an event, redact its detail, filter a stream for queries, roll up a summary. |
| **AuditLog** | The sink: `record()` builds + redacts + appends (never throws); a tail reader feeds queries. Injected IO. |
| **`!audit` command** | Operator-only read surface over the ledger — recent events, filtered by kind/actor/chat, plus a cost rollup. |

No new dependency, no new secret type (env-var refs as everywhere), no state-format change — `audit.jsonl` sits beside `outbound-log.jsonl` under the existing `0700` state dir, written with the same `appendJsonl` discipline. With no `audit` config block, **behaviour is unchanged**.

---

## 1. The record shape

One flat record, discriminated by `kind`, optimized for `grep`/`jq` over JSONL:

```ts
export interface AuditEvent {
  ts: number              // ms epoch (injected now())
  kind: AuditKind         // category: route | spawn | exec | outbound | session | access | approval | event | card
  actor: string           // "user:<discordId>" | "agent:<name>" | "hub" | "schedule:<id>"
  action: string          // verb within the kind: "route" | "spawn" | "deliver" | "exec" | "reset" | "compact" | "deny" | "grant" | …
  target?: string         // what it acted on: agent name, route id, command id, channel id
  chat?: string           // chat key — threads every event in one conversation together
  outcome: "ok" | "deny" | "error" | "pending"
  detail?: Record<string, unknown>  // kind-specific, redacted, metadata-only (no message bodies)
  cost?: number           // optional usd (turn cost) for rollups
  corr?: string           // optional correlation id to thread a multi-step action (e.g. an approval → its effect)
}
export type AuditKind =
  | "route" | "spawn" | "exec" | "outbound"
  | "session" | "access" | "approval" | "event" | "card"
```

- **`actor` is a `type:id` string** (not a nested object) so a filter is `actor.startsWith("agent:")` — cheap and shell-friendly.
- **`chat`** is the existing chat key (`chatKeyScope`), so `!audit chat <key>` reconstructs a conversation's full effect history.
- **`corr`** lets a gated action (§7) thread its `approval.request → approval.grant → outbound.deliver` events together.
- The record is **metadata, not content**: it stores ids, counts, lengths, outcomes — never the user's or agent's message text. This keeps the ledger safe to retain and share. (`detail` may carry short non-sensitive descriptors — a command id, an exit code, an http status.)

## 2. Audit core (pure, fully unit-tested)

```ts
// hub/audit.ts — no IO, no clock of its own
auditEvent(p: AuditInput, now: number): AuditEvent           // normalize: default outcome "ok", stamp ts, drop undefined
redactDetail(detail: Record<string,unknown>, secrets: string[]): Record<string,unknown>  // mask values containing a secret
matchAudit(events: AuditEvent[], f: AuditFilter): AuditEvent[]  // filter by kind / actor / chat / action / outcome / since
summarize(events: AuditEvent[]): AuditSummary                 // counts by kind & outcome, total cost, distinct actors
```

```ts
interface AuditFilter { kind?: AuditKind; actor?: string; chat?: string; action?: string; outcome?: AuditEvent["outcome"]; since?: number; limit?: number }
interface AuditSummary { total: number; byKind: Record<string, number>; byOutcome: Record<string, number>; costUsd: number; actors: number }
```

- `redactDetail` reuses the spirit of outbound's `redact` (`hub/outbound.ts`): any string value containing a configured secret substring becomes `"***"`.
- `matchAudit` is a substring/equality filter, `since` is a `ts` lower bound, `limit` keeps the most recent N — pure, so `!audit` parsing is trivial and tested.

## 3. AuditLog — the sink

```ts
// hub/auditLog.ts
interface AuditLogDeps {
  append: (e: AuditEvent) => void     // <stateDir>/audit.jsonl, via the existing appendJsonl
  readTail: (n: number) => AuditEvent[]  // injected reader for queries (parses the JSONL tail)
  now: () => number
  secrets?: string[]                  // values to mask in detail (resolved env-var values)
  enabled?: boolean                   // default false
  kinds?: AuditKind[]                 // optional allowlist; omit ⇒ record all kinds
}
class AuditLog {
  record(input: AuditInput): void     // build → redact → append; NEVER throws (try/catch like appendJsonl)
  recent(filter: AuditFilter): AuditEvent[]  // readTail → matchAudit, for !audit
  summary(filter: AuditFilter): AuditSummary
}
```

- **`record()` never throws and never blocks.** It is called at every hook point (§4); a logging failure must never break a turn. It wraps the append in the same `try/catch → stderr` that `appendJsonl` already uses.
- **Off by default.** If `audit.enabled` is unset, `record()` is a no-op — zero behaviour change with no config, matching the repo convention.
- **Kind allowlist.** `audit.kinds` lets an operator record only what they care about (e.g. just `["exec","outbound","access"]`).
- All IO is injected, so the engine is deterministic and unit-tested exactly like `OutboundDelivery` (`tests/outboundDelivery.test.ts` is the template — capture appends into an array, inject `now`).

## 4. Hook points — where `record()` is called

Each governed effect gets one `audit.record(...)` next to where it already happens. The hooks are tiny and additive; a missing hook just means that effect isn't in the ledger yet.

| kind | where (file:line today) | action / outcome |
| --- | --- | --- |
| **route** | `hub/index.ts` router pick (beside `statusRegistry.recordRoute`) | `route` / `ok`, `detail:{ switched }`, `cost` from the turn usage |
| **session** | `resetAgentSession` (`hub/index.ts`), governor compaction (`hub/sessionGovernor.ts`) | `reset` / `compact`, `target: agent` |
| **outbound** | delivery resolution (`fireOutboundText` / `fireOutboundNamed` / `emitHubEvent`, `hub/index.ts`) | `deliver` / `ok`\|`error`, `target: routeId` — complements per-attempt `outbound-log.jsonl` |
| **exec** | `runDirectCommand` (`hub/index.ts`) | `direct` / `ok`\|`error`, `target: cmdId`, `detail:{ exit }` |
| **access** | `BaseGate.gate` (`hub/baseGate.ts`), `deployGate` | `deny`\|`pair`\|`allow`, `actor: user:<id>`, `outcome: deny`\|`ok` |
| **spawn** | `runSpawnTrigger` (`hub/index.ts`) | `spawn`, `actor: agent:<parent>`, `target: child` |
| **event** | `emitHubEvent` (`hub/index.ts`) | the event name as `action`, `actor: "hub"` |
| **approval** | *reserved for the gated-action catalog (§7)* | `request` / `grant` / `reject`, threaded by `corr` |
| **card** | `CardLifecycle.runGated` (`hub/cardLifecycle.ts`) | `gated` / `ok`\|`error` |

**Relationship to `outbound-log.jsonl`:** that file stays — it is the *per-HTTP-attempt* detail (status, retry n, dead-letter). The audit log records the *higher-level* "an outbound action fired and resolved to X." They complement; neither is ripped out.

## 5. The `!audit` read surface

Operator-only (same gate as `!status` / `!usage`), reading the ledger tail — never the model, never blocking:

- `!audit` — last N events, compact one-line-each (ts · kind · actor · action · target · outcome).
- `!audit <kind>` — filter to a kind (`!audit exec`, `!audit access`).
- `!audit actor user:<id>` / `!audit chat <key>` — everything one user or one conversation caused.
- `!audit cost` — `summarize` rollup: events by kind, denies, total cost, distinct actors.

Rendered as a code block (or a single embed when `statusChannelId` is set), throttled like the status board. `recent()`/`summary()` are just `readTail → matchAudit/summarize`, so the command handler is a thin parser over the pure core.

## 6. Config

```jsonc
"audit": {
  "enabled": true,                       // default false — omit ⇒ no ledger, no behaviour change
  "file": "audit.jsonl",                 // optional; default <stateDir>/audit.jsonl
  "kinds": ["route","exec","outbound","access","session","approval"],  // optional allowlist; omit ⇒ all
  "redactEnv": ["EXTRA_SECRET"],         // optional extra secret env names whose values are masked in detail
  "maxBytes": 10485760,                  // optional rotation threshold (§ build order 6)
  "keepFiles": 5                         // optional rotated-file retention
}
```

```ts
// HubConfig gains:  audit?: AuditConfig
// AgentRuntime gains:  audit?: boolean   // per-agent opt-out (default: inherit hub.audit.enabled)
```

Mirrors the opt-in shape of `sessionGovernor` / `pool` / `memory`: a single optional block, defaults safe, per-agent override available.

## 7. Security & privacy

- **Metadata, not content** — message text is never recorded; only ids, kinds, outcomes, counts, costs. The ledger is safe to retain.
- **Secrets redacted** in `detail` via `redactDetail` (resolved env values + `audit.redactEnv`), reusing outbound's redaction discipline.
- **Under the `0700` state dir**, same as `outbound-log.jsonl` / `access.json`.
- **Operator-only reads** — `!audit` uses the existing `!status` operator gate; nothing exposes the ledger to ordinary users or to agents.
- **No agent write path** — agents cannot forge audit events; only the hub's hook points call `record()`.

## 8. From OK to must-have — what this seeds

This is the keystone the rest of the roadmap stands on:

1. **Gated action catalog** — `approval.request → approval.grant/reject → <effect>` events, threaded by `corr`, give every gated action a tamper-evident trail. `requireApproval` (already typed on `OutboundRoute`) gates; the audit log records.
2. **Metrics / health** — `summarize` over the ledger is the data source for cost-per-agent, deny rates, route-switch rate, outbound error rate — derived, not separately instrumented.
3. **Inter-agent work** — an agent consulting/handing off to another is an audited `route`/`spawn`-class effect; the same ledger shows the cross-agent call graph.
4. **Web surface** — a web request entering the router is just another `actor` (`user:<webSessionId>`); it lands in the same ledger with no special-casing, and the web UI can render `recent()` directly.

We don't build §8 now — but §1–§5 are shaped so these are additive, not rewrites.

## 9. Build order (each increment shippable, leaves the system working)

1. **audit core** (`hub/audit.ts`) — `auditEvent` / `redactDetail` / `matchAudit` / `summarize` + config types. Pure, no wiring.
2. **AuditLog sink** (`hub/auditLog.ts`) — `record` (build → redact → append, never throws), `recent` / `summary` over an injected `readTail`. Injected IO, unit-tested.
3. **Wire the conversational hooks** — `route` and `session` (reset/compact) in `index.ts` / `sessionGovernor.ts`; load the `audit` config and construct the sink with real IO (`appendJsonl` + a JSONL tail reader).
4. **Wire the effect hooks** — `outbound` (delivery resolution), `exec` (`runDirectCommand`), `access` (`BaseGate`/`deployGate`), `event` (`emitHubEvent`), `spawn`.
5. **`!audit` operator command** — `!audit [kind|actor|chat] [n]` + `!audit cost`, throttled embed/code-block, behind the operator gate.
6. **Rotation + docs** — optional size-based rotation (`maxBytes`/`keepFiles`, `.tmp`+rename), README section, example `audit` config block.
