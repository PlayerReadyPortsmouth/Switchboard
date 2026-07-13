# Phase 3 consolidated final-fix report

## Outcome

All five Important final-review findings are addressed at Phase 3 scope.

1. Conversation event delivery now uses the durable high-water mark only for canonical `message_committed` replay/deduplication. Live activity accepted after subscription is delivered exactly once regardless of whether a newer durable message has advanced the message cursor. Replay remains message-only and pending live events retain replay-before-live ordering.
2. Accepted production turns now retain their originating canonical user message in a per-conversation/per-agent FIFO. Successful unique agent reply persistence publishes `completed`; dispatch refusal, dispatch exception, and agent-reply persistence failure publish one `failed` terminal. Duplicate/late callbacks do not duplicate terminal announcements. No synthetic streaming chunks were added.
3. Same-origin navigation requests in the service worker now try the exact cache entry, `/index.html`, `/`, then the network. Existing API, SSE, non-GET, and cross-origin bypasses remain ahead of fallback, and no runtime cache writes were introduced. Offline deep conversation reload reconstructs only the shell and the already device-local draft; API reads still fail offline.
4. Canonical primary-agent validation now accepts only persistent registry agents, matching the transports registered by production. Startup/default-agent validation and hub-config previews reject ephemeral defaults, conversation create/update reject undispatchable agents, and `/api/session` exposes only persistent selectable agents. Existing Discord migration tests remain green.
5. Workspace loading now uses a monotonic epoch. Every new load and effect cleanup invalidates older work, and session/conversation/selection/connection/error state changes are guarded. Regressions cover old failure after new success, old success after new failure, unmount, StrictMode effect replay, API replacement, and overlapping retry/replacement.

## Strict RED -> GREEN evidence

- Event cursor RED: `live activity below a newer durable message cursor...` and replay-reentrant activity tests omitted the `turn_state` event. GREEN: focused conversation-event suite passes 8/8.
- Turn terminal RED: production coordinator emitted only `queued`, `working`; concurrent completion expectations were empty. GREEN: focused coordinator suite passes 20/20, including FIFO concurrent turns, duplicate reply suppression, and reply-persistence failure.
- Navigation fallback RED: generated `sw.js` contained no navigation fallback and the build assertion failed. Offline deep-route draft reload also rendered the unavailable page. GREEN: build harness returns cached `/index.html` without network/cache writes, and focused Playwright PWA passes 2/2.
- Agent dispatchability RED: an ephemeral `defaultAgent` loaded successfully. GREEN: config, service, API-session, and production composition regressions reject ephemeral/undispatchable names and accept persistent names.
- Workspace epoch RED: older rejected/resolved loads could replace newer API results; offline deep-route draft recovery rendered `Switchboard is unavailable`. GREEN: App regressions cover both stale-result directions, cleanup/unmount, StrictMode, API replacement, retry overlap, and offline draft recovery.

Focused aggregate after the final edge-case pass: 112 passed, 0 failed, 369 assertions across 8 files. Focused PWA E2E: 2 passed, 0 failed in the desktop project.

## Files changed

- Production: `hub/config.ts`, `hub/conversations/events.ts`, `hub/conversations/turnCoordinator.ts`, `hub/index.ts`, `hub/webServer.ts`, `web/client/App.tsx`, `web/client/public/sw.template.js`.
- Regression coverage: `tests/buildWeb.test.ts`, `tests/config.test.ts`, `tests/conversationEvents.test.ts`, `tests/conversationService.test.ts`, `tests/conversationWeb.test.ts`, `tests/e2e/pwa.spec.ts`, `tests/phase2CompositionSmoke.test.ts`, `tests/turnCoordinator.test.ts`, `web/client/App.test.tsx`.

## Fresh full phase gate

Run once from a fresh shell after focused verification:

- `bun run typecheck`: passed (`tsc --noEmit`, exit 0).
- `bun test`: 938 passed, 0 failed, 2,397 assertions across 121 files.
- `bun run build:web`: passed (exit 0).
- `bun run test:e2e`: 18 passed, 15 intentionally skipped, 0 failed across desktop/tablet/mobile projects (33 discovered tests).
- `git diff --check`: passed; only Git line-ending conversion warnings were emitted.
- Post-gate hygiene: port 4173 had no listener; Playwright `test-results` was removed.

## Self-review

- Durable message replay/dedupe remains sequence-based; activity is neither persisted nor replayed.
- Canonical agent message insertion and delivery-row creation are unchanged and still precede surface fan-out.
- Terminal events reference the originating user message ID and sequence, which exercises the formerly broken lower-sequence interleaving.
- API/SSE/authenticated data is not added to service-worker caches; the offline fallback uses only precached shell assets and an existing local draft.
- Persistent-agent restrictions are applied at startup config, editable default config, canonical service composition, and session projection without changing ephemeral agents for legacy jobs/consults.
- No Phase 4 controls, synthetic streams, browser canonical database, new service, router, or state library were introduced.

## Concerns / explicit limitations

- Current agent transports do not return an originating canonical message correlation for ordinary text replies. Concurrent accepted turns are therefore terminally correlated in dispatch FIFO order per conversation and agent. This is deterministic and covered, but a future transport correlation field could replace FIFO if out-of-order ordinary replies become supported.
- Offline recovery intentionally has no canonical conversation metadata or transcript: it presents the deep-route ID and the device-local draft, marks the connection offline, and still requires a successful canonical API response before a message can appear sent.
- No unresolved architecture blocker remains for Phase 3.
