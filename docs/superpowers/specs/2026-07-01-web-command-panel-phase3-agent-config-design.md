# Switchboard — Web Command Panel Phase 3: Agent Config Management

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**One-liner:** Let an operator create, edit, or remove agent definitions from the web panel — full `AgentConfig` coverage including `cwd`/`claudeArgs`/`allowedTools` — through a preview-then-confirm flow that shows an exact diff and an honest classification (hot-swappable now / needs `!reload hard` / needs a full restart), reusing the exact apply logic `!reload` already has rather than duplicating it.

This is Phase 3 of the command-panel roadmap (Phase 1 — auth/approvals/chat/audit/tools — and Phase 2 — trace/doctor/timeline — are both live). Phase 4 (hub-level config editing) is a separate, later spec that reuses this phase's preview/confirm plumbing.

---

## 0. Why this, why now

Today, changing an agent's definition means SSHing into the VPS and hand-editing `config/agents.json`, then running `!reload`/`!reload hard` in Discord to apply it (or restarting the whole hub for changes neither reload tier can apply). This phase removes the SSH step for routine agent changes while keeping the same underlying reload mechanics — it does not change what `!reload` itself can or cannot apply live, only who can trigger an edit and how safely.

**Trust boundary note:** `runtime.cwd`/`runtime.claudeArgs`/`runtime.allowedTools` directly control what a spawned `claude` process can read, write, and execute. This phase makes those editable from the browser — a materially bigger capability than anything shipped in Phases 1-2 (chat, approvals, read-only observability). The preview/confirm flow and audit diffing below exist specifically to keep that capability accountable, not just convenient.

## 1. The honest classification problem

`hub/configReload.ts`'s `planReload(prev, next)` classifies a prev→next config transition into `restartAgents` (hard-reload targets — a persistent, non-pooled agent whose spawn signature changed) and `fullRestart` (hub-level keys like `webPort`, or an added/removed agent, or a pooled/mode-changed agent). Everything else is implicitly assumed "safe" — but `!reload`'s actual apply code only ever hot-swaps `access` and the hub-level model/`contextWindows`/`commands`/`directCommands` fields. Fields like `emoji`, `description`, `useMemory`, `injectContext`, `overseer`, `sessionGovernor`, `maxQueueDepth`, `coalesceBurst`, `pool`, and `audit` are covered by **neither** path — a change to them via file-edit + `!reload` today silently does nothing and is never flagged as needing anything further.

This phase does not change that behavior (out of scope — `!reload`'s own capability is F4's territory, not this phase's). It does refuse to let the UI imply the existing safe/hard/full-restart split is exhaustive. A new wrapper, `classifyAgentChange`, sits in front of `planReload`:

```ts
// hub/agentConfigDraft.ts
export type FieldTier = "safe" | "hard" | "restart"

export interface AgentChangeClassification {
  tier: "safe" | "hard" | "restart"   // the worst tier among all changed fields
  restartAgent: boolean               // true if this specific agent needs !reload hard
  fullRestart: string[]               // labels, e.g. "+agent:foo", "unapplied:emoji" — reasons a full restart is needed
}
```

`classifyAgentChange(name, before, after, hubConfigContext)` internally calls `planReload` for the agent-add/remove/mode/pool/spawn-signature cases (unchanged), then does its own field-by-field diff of `before`/`after` for the fields `!reload` doesn't apply at all (`emoji`, `description`, `useMemory`, `injectContext`, `overseer`, `sessionGovernor`, `maxQueueDepth`, `coalesceBurst`, `pool`'s own value if unchanged-but-agent-otherwise-safe, `audit`) — any of those changing pushes the tier to `"restart"` with a `unapplied:<field>` label, distinct from `planReload`'s own `fullRestart` labels but shown identically in the UI (both mean "won't take effect until the hub restarts").

## 2. Preview / confirm flow

```ts
// hub/agentConfigPreview.ts
export interface AgentConfigPreview {
  id: string
  agentName: string
  before: AgentConfig | null   // null ⇒ this is a create
  after: AgentConfig | null    // null ⇒ this is a remove
  classification: AgentChangeClassification
  createdAt: number
  expiresAt: number            // short TTL (5 min) — a stale preview must be re-generated, not silently confirmed
}

export class AgentConfigPreviewRegistry {
  constructor(private now: () => number, private genId: () => string, private ttlMs: number) {}
  create(agentName: string, before: AgentConfig | null, after: AgentConfig | null, classification: AgentChangeClassification): AgentConfigPreview
  get(id: string): AgentConfigPreview | undefined
  consume(id: string): AgentConfigPreview | null   // single-shot, like ApprovalRegistry.resolve — a second confirm on the same token is a no-op
}
```

Deliberately a sibling of `ApprovalRegistry`, not a reuse of it — an approval gates someone ELSE's already-decided effect behind a separate approver; a config preview is a self-serve "are you sure" for the SAME operator's own pending edit. Different enough shapes (no `fire` callback, no approver identity) that forcing them into one class would blur both.

**Confirm-time drift check:** `POST /api/agents/:name/confirm` re-reads `config/agents.json` from disk and re-classifies against the *current* on-disk state before applying — if it's drifted from what `before` captured at preview time (someone else already changed this agent), confirm is rejected with a "config changed since preview — re-preview" error rather than silently overwriting a concurrent edit.

## 3. Applying a confirmed change

`!reload`'s Discord branch (`hub/index.ts:1731-1764`) currently inlines: re-read config → `planReload` → hot-swap the safe subset → optionally respawn hard-tier agents → report. This phase extracts the "hot-swap the safe subset + optionally respawn" half into a shared function:

```ts
async function applyAgentChange(
  name: string, after: AgentConfig | null, hard: boolean,
): Promise<{ restarted: string[]; failed: { name: string; error: string }[] }>
```

Both the Discord `!reload`/`!reload hard` branch (for the whole-registry case) and the new web confirm endpoint (for the single-agent case) call into the same underlying apply primitives — no duplicated hot-swap logic. `after: null` (a remove) always writes the file and reports `fullRestart` (agent removal is never live-appliable, per `planReload`); it's confirm-able (writes to disk, so the removal is "staged" and takes effect on the next restart) but never auto-restarts the hub (see §4).

`config/agents.json` writes go through an atomic temp-file-then-rename, matching the pattern already established for `trace.jsonl`'s sweep rewrite in Phase 2.

## 4. No auto-restart

When a change's classification includes `fullRestart` items, the API reports them (same wording style as `!reload`'s Discord report) and stops — it never calls `process.exit()` or otherwise triggers a restart itself. An operator (or the next deploy) restarts the hub separately. This keeps "edit config" and "take the live bot offline" as two distinct, deliberate actions, matching the guardrail already established for `!reload` itself.

## 5. Audit trail

Every confirmed change — create, edit, or remove — writes one audit event with a full before/after diff in `detail`, not just a generic "config changed" marker:

```ts
audit.record({
  kind: "event", actor: `web:${email}`, action: "agent_config_change",
  target: agentName, outcome: "ok",
  detail: { before, after, classification },
})
```

(Web-originated actions use the `web:<email>` actor convention established in Phase 1; Discord-originated `!reload` keeps its own existing audit shape, unchanged.)

## 6. API surface

- `GET /api/agents` → `{ [name: string]: AgentConfig }` — the full current registry (new; the existing dashboard only has status-table summaries, not full config).
- `POST /api/agents/:name/preview` `{ config: AgentConfig | null }` → validates `config` roughly matches the `AgentConfig` shape (required fields present, `mode` is one of the two valid values — a full runtime schema isn't necessary here, a malformed edit fails loudly at `!reload`/hard-respawn time the same way a hand-edited file would, this phase just needs to not crash on garbage input), classifies via `classifyAgentChange`, stores a preview, returns `{ id, before, after, classification }`. `config: null` previews a removal. A `:name` not currently in the registry previews a create.
- `POST /api/agents/:name/confirm` `{ id: string, hard: boolean }` → re-validates against current disk state (drift check per §2), writes, applies via `applyAgentChange`, audits, returns `{ applied: "safe" | "hard" | "none", restarted: string[], fullRestart: string[] }`.

All three routes join the existing guarded-route set in `hub/webServer.ts` (same `X-Switchboard-User` gate as every other `/api/*` route beyond `/` and `/api/status`).

## 7. Web UI

- The existing Agents status table gains an "Edit" link per row (opens a panel below the table, not a separate page — keeps the single-page-no-router style).
- A "+ New Agent" button above the table opens the same panel in create mode (empty name field + empty-ish template JSON).
- The panel: a `<textarea>` pre-filled with the agent's current config as pretty-printed JSON (or a starter template for create). "Preview" button → calls the preview endpoint, renders the diff (a simple line-by-line before/after, not a fancy diff widget — this dashboard has no build step, so a hand-rolled JSON-stringify-and-compare-lines renderer, not a library) and the classification (`safe`/`needs !reload hard`/`needs a full restart`, with the specific field labels listed). Two confirm buttons appear based on classification: "Apply" (always, if tier is `safe` or `hard`) and, only when tier is `hard`, a second "Apply + restart this agent" — mirroring `!reload` vs `!reload hard`'s two-tier distinction. When tier is `restart`, no confirm button applies live changes — only a "Save to disk (needs a full restart to take effect)" option, worded so it's unmistakable nothing live happens yet.
- A "Remove" link per row opens the same panel pre-loaded as a removal preview (`after: null`) — same diff/classify/confirm flow, always lands in the `restart` tier per `planReload`.

## 8. Non-goals (this phase)

- No structured per-field form (emoji picker, role multi-select, etc.) — the JSON textarea is the whole editing surface, kept safe by preview/diff/confirm rather than input-level affordances.
- No auto-restart capability, even for changes classified as needing one (§4).
- No expansion of what `!reload`'s own hot-swap logic covers (the `emoji`/`description`/`overseer`/etc. gap documented in §1 is surfaced honestly, not fixed — fixing it would be a `!reload`/F4-scoped change, not this phase's).
- No schema-level JSON validation beyond "roughly shaped like an `AgentConfig`" — a genuinely malformed `runtime.claudeArgs` etc. fails the same way a hand-edited file would today (at reload/respawn time), not earlier.

## 9. Testing

- `hub/agentConfigDraft.ts` / `.test.ts`: `classifyAgentChange` — every tier (safe: `access`-only change; hard: spawn-signature change on a persistent non-pooled agent; restart: add, remove, mode change, pooled-agent spawn change, and each of the "unapplied" fields individually).
- `hub/agentConfigPreview.ts` / `.test.ts`: create/get/consume (single-shot, matching `ApprovalRegistry`'s existing test shape), TTL expiry.
- `hub/webServer.ts`: new route tests — preview happy path (create/edit/remove), confirm happy path, confirm with a stale/consumed token → 409, confirm after drift → 409 with a distinct error, missing-identity → 400 (matching the existing pattern for every guarded route).
- `hub/index.ts`'s `applyAgentChange` extraction: no new tests (wiring, matching the established convention that `hub/index.ts` isn't unit-tested directly) — verified via the full suite + a manual smoke check that `!reload`'s Discord behavior is unchanged (same extraction discipline as Phase 2's `gatherDoctorFacts()`).
- Manual verification (post-deploy): create a throwaway ephemeral agent via the web panel, confirm it previews as `fullRestart`, confirm it writes to `config/agents.json` on the VPS; edit an existing agent's `access.users` (safe-tier), confirm it hot-swaps without any process restart; edit a persistent agent's `model` (hard-tier), confirm "Apply + restart this agent" respawns only that one agent.

## 10. Build order

1. `hub/agentConfigDraft.ts` (`classifyAgentChange`) + tests.
2. `hub/agentConfigPreview.ts` (`AgentConfigPreviewRegistry`) + tests.
3. `hub/webServer.ts`: `GET /api/agents`, `POST /api/agents/:name/preview`, `POST /api/agents/:name/confirm` + tests (fakes).
4. `hub/index.ts`: extract `applyAgentChange` from `!reload`'s existing apply logic (both Discord and web call it); wire the three new routes to real deps; audit-diff logging.
5. `hub/web.ts`: Edit/Remove/+New Agent UI, JSON textarea, diff renderer, classification-aware confirm buttons.
6. Wire end-to-end, deploy, manual verification.
