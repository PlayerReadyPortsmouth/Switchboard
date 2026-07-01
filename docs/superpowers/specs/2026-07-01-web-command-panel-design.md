# Switchboard — Web Command Panel (Phase 1: auth + actions)

**Date:** 2026-07-01
**Status:** Approved, pre-implementation
**One-liner:** Turn the read-only web dashboard (`docs/superpowers/specs/2026-06-24-web-dashboard-design.md`) into a real control surface — approve/deny pending approvals, mirror a Discord channel's conversation (send + receive), and run an agent's built-in commands (`!status`/`!nag`/`!audit`/`!tools`/`!memory`) — all from the browser, gated by a widened version of the existing Entra-authenticated ReadyApp proxy.

This is Phase 1 of 4 identified for "true command panel" work. Deferred to later specs: deep per-agent observability (logs/history/tool timeline drill-down), agent config management (add/edit/remove agent defs), and live hub config editing.

---

## 0. Why this, why now

The read-only dashboard (shipped 2026-06-24/29) explicitly seeded this: *"The shell for write actions later. If the full web-chat scope is ever taken on, this page is where it lands."* Today, acting on the hub — approving a gated effect, nudging an agent, running a status check — requires Discord. This phase makes the browser a first-class second surface for those actions, without duplicating any execution logic: every write goes through the exact same in-process objects (`ApprovalRegistry`, the `InboundMessage` pipeline, the direct-command matcher) that Discord already drives.

## 1. Trust boundary & auth

The hub's `webServer` stays loopback-only (`127.0.0.1`, unauthenticated at the hub level — unchanged from the read-only dashboard). The only thing that can reach it is ReadyApp's proxy (`apps/api/src/routes/switchboardProxy.ts`), which already does Entra auth + an OID allowlist for `GET`.

Changes to the proxy:
- Forward `POST` (body + headers) in addition to `GET`, to the same `http://127.0.0.1:{SWITCHBOARD_WEB_PORT}` upstream.
- Replace the `SWITCHBOARD_UI_OIDS` env var with an `AppSetting`-backed flag `switchboardCommandPanel` (`{ enabled: boolean, allowlist: string[] }`, entraOid-keyed), read the same way every other ReadyApp feature flag is (60s cache, fail-closed to off/empty). Managed from the Feature Flags page. `GET` access (the existing read-only dashboard) keeps working unconditionally for the allowlisted set — this flag governs the *panel/write* surface, not the whole `/switchboard` route.
- On every proxied request, resolve the caller's display identity (email from `request.user`) and forward it as `X-Switchboard-User: <email>`.

The hub trusts `X-Switchboard-User` unconditionally — it only ever arrives from the loopback-bound proxy, which has already gated it. Every write action stamps its audit `actor` as `web:<email>` (vs. a Discord user id for Discord-originated actions), and every web-constructed `InboundMessage` uses `userId: "web:<email>"`, `user: <email>`.

## 2. New hub-side components

| Component | Responsibility |
| --- | --- |
| `hub/webActions.ts` | Pure: validates + executes one write request against injected deps (`ApprovalRegistry`, an `emit: (msg: InboundMessage) => void` for the inbound pipeline, the direct-command matcher, a Discord history/post seam). No I/O of its own — mirrors `directCommands.ts`/`approval.ts`. |
| `hub/channelStream.ts` | Per-channel pub/sub for the web layer: `subscribe(channelId, cb)` / `publish(channelId, event)`. The orchestrator's existing "send reply to Discord channel" call site also calls `publish()`; `Gateway`'s `messageCreate` handler does the same for human Discord messages. Pure registry (Map of channelId → Set of callbacks) + a thin wiring point in `index.ts`. |
| `hub/webServer.ts` (extended) | New routes (below). Existing `/`, `/api/status` unchanged. |

## 3. API surface

All new routes require `X-Switchboard-User` to be present (400 if missing — the proxy always sets it when the flag is on, so its absence means misconfiguration, not an anonymous caller).

- `GET /api/status` — unchanged shape, `pendingApprovals` (count) becomes `pendingApprovals: number` **and** a new `pendingApprovalList: PendingApprovalJson[]` array (id, kind, target, actor, summary, createdAt, expiresAt).
- `POST /api/approvals/:id` `{ decision: "grant" | "deny" }` → `approvalRegistry.resolve(id, decision)`; on success fires the held effect (`e.fire(corr)`) and audits `web:<email>`. Returns `200 { state }` or `409 { state }` if already resolved/expired.
- `GET /api/channels` — channels the hub currently has an active session for (in-memory per-channel agent-session map, the same state the router already keys off for "current agent"), plus any statically configured `channelId`s from `schedules`/`commands`. Each entry: `{ channelId, name?, agent }`.
- `GET /api/channel/:id/history` — last 50 messages fetched live from Discord via the bot client already held by `Gateway` (`channel.messages.fetch({ limit: 50 })`), normalized to `{ ts, author, content, attachments: {name,url}[] }[]`. No local storage; always matches Discord.
- `GET /api/channel/:id/stream` — SSE. Subscribes via `channelStream.subscribe`; each published event is a JSON message line, same shape as a history row plus `origin: "discord" | "web" | "agent"`.
- `POST /api/channel/:id/message` `{ text }` — builds an `InboundMessage` (`chatId: id`, `userId: "web:<email>"`, `user: <email>`, `content: text`, `ts: now`, `isDM: false`), feeds it into the same `onMessage` callback the orchestrator wires for Discord, **and** posts a mirrored message to the real Discord channel (`**<email> (web):** <text>`) via the bot client, so Discord-side participants see it. The agent's reply flows back through the normal Discord-send path, which `channelStream.publish`s it — the sender's own open SSE connection receives it like any other subscriber (no separate optimistic echo needed).
- `POST /api/command/:name` `{ channelId }` — `:name` ∈ the built-in commands the target channel's agent actually exposes (`status`, `nag`, `audit`, `tools`, `memory`); builds the equivalent command text (`!status`, `!nag`, …) and routes it through the identical path as `POST /api/channel/:id/message`. Unknown/unsupported command for that agent → `404`.

## 4. Web UI additions

Single-page dashboard gains a second view (tab or route within the same `DASHBOARD_HTML`, still no build step / vanilla JS):
- **Approvals panel** — list from `pendingApprovalList`, Approve/Deny buttons per row, optimistic removal on success, "already handled" toast on `409`.
- **Channel chat** — channel picker (`/api/channels`) → history fetch → SSE-fed live pane, a send box, and a command-button row (populated per-agent, only the commands that channel's agent supports).

## 5. Explicit non-goals (Phase 1)

- No message edit/delete propagation — the web view is append-only, same as the existing audit feed. A Discord edit/delete after the fact won't retroactively change what's shown.
- No Discord card retraction when an approval is resolved from the web (or vice versa) — the losing side's UI just shows the terminal "already handled" state on next interaction, same race behavior that already exists between two Discord approvers today.
- No new persistent transcript store — channel history is always a live Discord fetch.
- Agent config management and hub config editing are separate, later specs (Phases 3–4).

## 6. Testing

- `hub/webActions.test.ts` — approve/deny incl. double-resolve → 409; command-name → command-text mapping matches what Discord's matcher expects; unsupported command for an agent → rejected before reaching the pipeline.
- `hub/channelStream.test.ts` — publish fans out to all subscribers of a channel, none to other channels; unsubscribe stops delivery.
- `hub/webServer.test.ts` (extended) — new routes, injected deps, no real socket: missing `X-Switchboard-User` → 400; approvals 200/409; channel routes happy-path shape.
- ReadyApp: `switchboardProxy.test.ts` extended for POST passthrough + identity header injection + flag-off → 404 (mirrors the existing dormant-route test).
- Manual verify (post-merge): approve a real pending approval from the browser and confirm the Discord card flips to resolved; send a web chat message and confirm it appears in the real Discord channel with the agent's reply streaming back into both surfaces.

## 7. Rollout

- Hub-side routes ship dark (additive, no config default needed beyond the existing `webPort`).
- ReadyApp proxy POST support + UI ship behind `switchboardCommandPanel` (`AppSetting`, allowlist starts as `["<aurora-oid>"]`), consistent with the repo's required runtime-flag convention. Widen the allowlist independently, whenever.

## 8. Build order (each increment shippable)

1. `hub/channelStream.ts` — pure pub/sub, unit-tested.
2. `hub/webActions.ts` — approve/deny + command-text builder, pure, unit-tested against fakes.
3. `webServer.ts` extension — wire the new routes to real deps (`ApprovalRegistry`, `Gateway`'s Discord client for history/post, the orchestrator's `onMessage`/publish hook).
4. Web UI — approvals panel, then channel chat pane.
5. ReadyApp: `switchboardProxy.ts` POST passthrough + identity header + `switchboardCommandPanel` AppSetting flag + Feature Flags page entry.
6. Wire end-to-end, manual verify, PR.
