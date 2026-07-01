# Switchboard — Web Command Panel Phase 4: Hub Config Editing

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**One-liner:** Let an operator edit `hub.config.json` from the web panel — one JSON textarea for the whole object, minus four boot-critical fields excluded entirely — through the identical preview-then-confirm flow Phase 3 built for agents, reusing `!reload`'s existing hub-level apply logic and `planReload`'s existing full-restart-key list rather than duplicating either.

This is Phase 4 of the command-panel roadmap. Phases 1-3 (auth/approvals/chat/audit/tools, observability, agent config management) are all live.

---

## 0. Why this, why now

Phase 3 built the whole preview/diff/confirm/drift-check/audit-diff pattern for a KEYED collection (agents, one entry per name). Hub config is a single object, not a collection — this phase adapts that same pattern to a singleton, and closes the same "config apply is not exhaustive" honesty gap `!reload` already has at the hub level: `HubConfig` has ~35 fields, `!reload`'s existing apply logic only ever hot-swaps 7 of them, and `planReload` already tracks 8 more as full-restart-required — everything else (roughly 20 fields: `audit`, `escalation`, `reload`, `trace`, `approvals`, `consult`, `peering`, `workflows`, `workflow`, `attachments`, `outboundAttachments`, `shareLinks`, `toolObservability`, `memoryBrowse`, `receipts`, `gatedActions`, `channelAgents`, `memoryDir`, `contextCacheSize`, `distillIdleMs`, `memory`, `gardener`, `statusChannelId`, `statusRefreshMs`, `outboundAllowedHosts`, `outboundRetries`, `spawnTriggers`, `deployApproverUserId`, `webhooks`, `schedules`, `timezone`, `switchThreshold`, `ephemeralTimeoutMs`, `tagStyle`, `chatKeyScope`) is silently a no-op on live-apply today, same as Phase 3's agent-level unapplied-fields gap.

## 1. Excluded fields

`botTokenEnv`, `socketPath`, `stateDir`, `guildIds` are excluded from the editor entirely — not just classified as restart-tier, genuinely never shown or editable. `GET /api/hub-config` omits them from the response; `POST /api/hub-config/confirm` rejects (400) outright if a submission contains any of the four keys at all, regardless of value. These four are boot-time-only (already in `HUB_FULL_RESTART_KEYS` or never read again after boot) and a malformed value breaks the hub's basic ability to start or reach Discord — worth keeping SSH-only rather than one JSON-paste-typo away from a bad deploy.

## 2. Classification — set-difference, not a hand-enumerated list

Unlike Phase 3's `classifyAgentChange` (which hand-lists ~10 `AgentRuntime` fields as "unapplied" — a manageable count), `HubConfig` has too many fields for that to stay maintainable. `classifyHubChange` instead works by set difference:

```ts
// hub/hubConfigDraft.ts
const SAFE_KEYS = [
  "routerModel", "librarianModel", "distillerModel", "overseerModel",
  "contextWindows", "commands", "directCommands",
] as const   // exactly the 7 fields !reload's existing apply logic hot-swaps

// planReload's own HUB_FULL_RESTART_KEYS, minus the 4 excluded-entirely fields
// (socketPath/stateDir are in that list; botTokenEnv/guildIds aren't tracked by
// it at all today — irrelevant here since neither reaches this function, ever).
const FULL_RESTART_KEYS = ["defaultAgent", "metricsPort", "metricsHost", "webPort", "webHost", "webhookPort"] as const

export function classifyHubChange(before: HubConfig, after: HubConfig): { tier: "safe" | "restart"; fullRestart: string[] } {
  const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k]))
  const fullRestart = changed.filter((k) => !SAFE_KEYS.includes(k as any))
  return fullRestart.length > 0 ? { tier: "restart", fullRestart } : { tier: "safe", fullRestart: [] }
}
```

No `"hard"` tier at the hub level — `!reload hard` respawns *agents*, it has no hub-level-only hard-apply concept, so a hub-config change is either fully hot-swappable now (`safe`) or needs a restart (`restart`, whether that's because it's in `FULL_RESTART_KEYS` or simply a field nothing ever applies live — both render identically to the operator, "needs a restart," which is the honest truth either way).

## 3. Read / write shape

- `GET /api/hub-config` → a fresh disk read of `hub.config.json` (never the live in-memory `hub` object) with the 4 excluded keys stripped. Reading disk fresh everywhere in this phase — GET, preview, and confirm's drift check — is deliberate: Phase 3's final review caught a Critical bug from exactly this kind of raw-disk/in-memory mismatch (an in-memory value normalized at boot, silently diverging from what's actually on disk). Hub config has no known equivalent normalization today, but reading disk fresh consistently avoids ever having to prove that, the same way Phase 3 settled on it for agents.
- `POST /api/hub-config/preview` `{ config: HubConfig }` → 400 if `config` contains any excluded key; otherwise reads disk fresh, re-attaches the excluded keys' real current values onto BOTH the `before` and the proposed `after` (so they never appear as a diff — they're genuinely unchanged, just invisible to the editor), classifies, stores a preview (`HubConfigPreviewRegistry`, a sibling of Phase 3's `AgentConfigPreviewRegistry` — same TTL/single-shot-consume/sweep shape, no `agentName` field since there's only ever one hub config).
- `POST /api/hub-config/confirm` `{ id: string }` → drift check (re-read disk, compare against `preview.before`), write the full object (submitted fields + re-attached excluded-key values) atomically, apply the safe-7 fields live via the exact same assignment lines `!reload`'s Discord branch already has (extracted into a shared `applySafeHubFields(next: HubConfig)` helper, mirroring Task 4's `applySafeAgentFields` extraction), audit the diff. No `hard` parameter (nothing to conditionally respawn at the hub level) and no auto-restart, same guardrail as Phase 3.

## 4. UI

One more button on the dashboard — "Edit hub config" — opens the same JSON-textarea-plus-diff-plus-classification-aware-confirm panel Phase 3 built for agents, adapted for a singleton (no per-row list, no Remove, no "+ New" — just Edit). Classification renders as either "Apply" (safe) or "Save to disk (needs a full restart)" (restart) — no hard-tier button since there's no hub-level hard-apply concept.

## 5. Non-goals

- No per-field form — same JSON-textarea-plus-preview/confirm safety net as Phase 3.
- No auto-restart, ever.
- No fix to what `!reload`'s own hot-swap logic covers — same as Phase 3, this phase surfaces the gap honestly rather than closing it.
- No schema validation beyond the excluded-key rejection — malformed input fails the same way a hand-edited file would, at next reload/restart.

## 6. Testing

- `hub/hubConfigDraft.ts` / `.test.ts`: `classifyHubChange` — safe-only change, each `FULL_RESTART_KEYS` member individually, a generic unlisted-field change (proving the set-difference approach catches fields not hand-enumerated), no-change idempotence.
- `hub/hubConfigPreview.ts` / `.test.ts`: same shape as `AgentConfigPreviewRegistry`'s tests (create/get/consume-single-shot/consume-expires-unswept/sweepExpired).
- `hub/webServer.ts`: preview/confirm route tests, including the excluded-key-rejection 400 case explicitly.
- Manual verification (post-deploy): edit `routerModel` only, confirm it hot-swaps live with no restart; edit an unrelated field like `statusRefreshMs`, confirm it classifies as `restart` and only writes to disk; attempt to submit a config containing `botTokenEnv`, confirm it's rejected with 400.

## 7. Build order

1. `hub/hubConfigDraft.ts` (`classifyHubChange`) + tests.
2. `hub/hubConfigPreview.ts` (`HubConfigPreviewRegistry`) + tests.
3. `hub/webServer.ts`: `GET /api/hub-config`, `POST /api/hub-config/preview`, `POST /api/hub-config/confirm` + tests.
4. `hub/index.ts`: extract `applySafeHubFields`; wire real deps (read/write `hub.config.json` atomically, excluded-key handling, drift check, audit diff).
5. `hub/web.ts`: "Edit hub config" button + panel (reusing as much of Phase 3's editor JS as sensibly shareable — a shared `renderConfigDiff`/confirm-button-builder helper if the two panels' logic converges cleanly; a second near-identical copy if it doesn't, decided during implementation based on actual code shape, not speculated here).
6. Wire end-to-end, deploy, manual verification.
