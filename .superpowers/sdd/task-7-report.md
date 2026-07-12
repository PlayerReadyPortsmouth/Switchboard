# Task 7 report — retry worker, shutdown, and Phase 2 gate

## Status

Implemented and verified.

## Changes

- Added a single-flight delivery worker that reads at most 100 due rows per tick, reconstructs their canonical message/link, persists success and failure outcomes, honors explicit non-retryable results, and applies injected bounded exponential backoff/jitter with five attempts by default.
- The worker owns an unref'd timer, performs an initial recovery tick only after configured adapters start, and awaits an in-flight tick when stopped.
- Extended idempotent shutdown ordering to stop web ingress, retry work, adapters, and the web server before closing SQLite. The web server exposes a split stop-accepting/await-stop lifecycle.
- Wired the worker into the production canonical conversation runtime and documented adapter/sync/import/delivery/web-only behavior plus deferred rich-card parity.

## TDD evidence

Initial worker run before implementation:

`bun test tests/deliveryWorker.test.ts`

- Exit 1.
- Expected failure: `Cannot find module '../hub/surfaces/deliveryWorker'`.

Initial shutdown run after adding the ordered lifecycle test:

`bun test tests/shutdown.test.ts`

- Exit 1.
- Existing shutdown passed; new ordered shutdown failed with `TypeError: closeDatabase is not a function` because the object-form lifecycle did not exist.

Focused green run:

`bun test tests/deliveryWorker.test.ts tests/shutdown.test.ts; bun run typecheck`

- Exit 0: 8 pass, 0 fail, 14 expectations; TypeScript exit 0.

## Phase 2 completion gate

`git diff --check; bun run typecheck; bun test`

- Exit 0.
- `git diff --check`: no whitespace errors (Git emitted line-ending notices only).
- TypeScript: exit 0.
- Tests: 801 pass, 0 fail, 1954 expectations across 110 files.

## Smoke scenarios

Web-only boot/message/agent reply/restart scenario:

`bun test tests/discordOptional.test.ts tests/conversationWeb.test.ts tests/turnCoordinator.test.ts tests/conversationRepository.test.ts`

- Exit 0: 54 pass, 0 fail, 171 expectations.
- Covers disabled Discord construction/token access, HTTP canonical submit, agent dispatch/reply idempotency, durable delivery creation, and file-backed database reopen.

Fake-Discord inbound/web mirror/dedup scenario (no network):

`bun test tests/discordAdapter.test.ts tests/channelMigration.test.ts tests/transportMirror.test.ts tests/surfaceRouter.test.ts`

- Exit 0: 21 pass, 0 fail, 49 expectations.
- Covers fake adapter inbound normalization, atomic channel mapping/import, one canonical receipt under duplicate inbound, outbound sync-mode selection, isolated adapters, and compatibility callbacks.

## Self-review

- Retry scheduling uses the post-attempt ordinal: first failure waits 1 second plus jitter, fifth failure exhausts, and delay is capped at 60 seconds before 0–250 ms jitter.
- Missing message/link and explicit non-retryable results exhaust without rescheduling.
- A concurrent tick is a no-op; stopping prevents future ticks and waits for the active one.
- The delivery id remains the durable `(message, link)` id used by adapters for external idempotency.
- The web stop split is included because stopping acceptance before adapter drain cannot be represented by the previous single `stop()` method.

No known Task 7 concern remains.
