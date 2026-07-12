# Task 5 report

## Status

Implemented optional Discord startup and canonical web agent turns.

## Changes

- Added `discord?: { enabled?: boolean }`; config loading materializes the backward-compatible `true` default.
- Added `resolveDiscordStartup`, which returns before accessing the environment when disabled and requires the configured/default token only when enabled.
- Composed `DiscordAdapter`/`SurfaceRouter` only when enabled. Disabled startup uses an empty router, an empty role resolver, and shutdown never calls the Discord gateway.
- Allowed the gateway's legacy handler and canonical surface handler to coexist. Linked Discord locations go only through the canonical coordinator; unlinked locations retain legacy commands/cards/interactions.
- Routed canonical HTTP message POSTs through `TurnCoordinator.submitWebTurn` while retaining 201/200 `{ message, inserted }` semantics.
- Routed canonical agent text replies through `acceptAgentReply`, so they persist and stream without requiring a surface link and do not fall through to `gateway.sendReply`.
- Documented the flag, default, web-only behavior, and Phase 2 Discord-specific card/interaction limitation.

## TDD evidence

Initial focused run failed as expected:

- `loads and validates both files`: expected `hub.discord.enabled` true, received undefined.
- `message POST awaits asynchronous turn submission`: expected 201, received 200 because the Promise was not awaited.
- The later environment-access tests first failed with `Export named 'resolveDiscordStartup' not found`.

Final fresh verification:

- `git diff --check` — exit 0 (only Git CRLF conversion warnings).
- `bun test tests/discordOptional.test.ts tests/conversationWeb.test.ts tests/config.test.ts` — 25 pass, 0 fail, 70 assertions.
- `bun run typecheck` — exit 0 (`tsc --noEmit`).
- `bun test` — 781 pass, 0 fail, 1900 assertions across 107 files.

## Self-review

- Backward compatibility: omission enables Discord and defaults the token variable to `DISCORD_BOT_TOKEN`; legacy non-linked Discord traffic remains on the existing orchestration path.
- Web-only safety: disabled resolution performs zero environment property reads; no adapter is constructed or started; role resolution returns `[]`; empty-router shutdown never invokes `gateway.stop()`/`gateway.client`.
- Canonical routing: coordinator initialization precedes surface startup; linked Discord inbound is not double-dispatched; canonical agent replies return before legacy Discord delivery.
- HTTP compatibility: asynchronous coordinator results preserve the existing inserted-dependent 201/200 response behavior.
- Scope note: `hub/gateway.ts` and `hub/webServer.ts` were additionally required to multiplex legacy/canonical inbound listeners and await the coordinator Promise respectively.

## Concerns

No known functional concerns. Cards, updates, modals, and interaction handling intentionally remain on the Discord compatibility path in Phase 2, as documented.

## Review fixes

- Root cause: token resolution was conditional, but `new Gateway(...)` and Discord callback registration were still unconditional. `createDiscordRuntime` now gates the factory itself; disabled mode therefore constructs neither `Gateway` nor its discord.js `Client`. All Discord startup callback registrations are guarded by the resulting optional runtime. The core retains only an inert fail-closed façade for legacy call-site compatibility.
- Added a factory instrumentation regression test proving disabled mode performs zero factory construction and registration calls, alongside the existing zero token-environment-read assertion.
- Root cause: legacy inbound suppression tested only whether any transport link existed, while `TurnCoordinator` separately rejected disabled/outbound-only/notifications-only links. Both now share `inboundLinkRoute`/`acceptsInboundLink`: only enabled `two_way` and `inbound_only` links are canonical; absent, disabled, `outbound_only`, and `notifications_only` links fall back to legacy handling.
- Added explicit routing-matrix coverage and an inbound gateway multiplexer ordering test.

Review-fix TDD evidence:

- RED: optional composition test failed because `createDiscordRuntime` did not exist; gateway multiplexer test failed because `InboundMultiplexer` did not exist; routing-matrix test failed because `inboundLinkRoute` did not exist.
- `bun test tests/discordOptional.test.ts tests/config.test.ts tests/conversationWeb.test.ts tests/turnCoordinator.test.ts hub/gateway.test.ts tests/discordAdapter.test.ts` — 65 pass, 0 fail, 173 assertions.
- `bun run typecheck` — exit 0 (`tsc --noEmit`). An intermediate run exposed and then corrected null narrowing after the shared route helper was introduced.
- `bun test` — 785 pass, 0 fail, 1910 assertions across 107 files.
