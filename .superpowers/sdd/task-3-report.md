# Task 3 Report: Canonical Turn Coordinator

## Status

Implemented the canonical turn coordinator with persistence-first web and surface dispatch, external receipt deduplication, canonical `conversationId` routing, agent callback deduplication, atomic agent message/delivery persistence, surface delivery, and queued/working/failed turn events.

## Files

- Created `hub/conversations/turnCoordinator.ts`
- Modified `hub/conversations/index.ts`
- Modified `hub/conversations/service.ts`
- Created `tests/turnCoordinator.test.ts`

## TDD evidence

RED command:

`bun test tests/turnCoordinator.test.ts`

RED result: exit 1. Bun reported `SyntaxError: Export named 'TurnCoordinator' not found in module .../hub/conversations/index.ts`; 0 pass, 1 fail, 1 error. This was the expected missing-feature failure before production implementation.

GREEN command:

`bun test tests/turnCoordinator.test.ts`

GREEN result: exit 0; 6 pass, 0 fail, 27 assertions.

Regression command:

`bun test tests/turnCoordinator.test.ts tests/conversationService.test.ts tests/conversationEvents.test.ts tests/conversationRepository.test.ts`

Regression result: exit 0; 39 pass, 0 fail, 128 assertions across 4 files.

Typecheck command:

`bun run typecheck`

Typecheck result: exit 0; `tsc --noEmit` completed without diagnostics.

## Requirement review

- Web append uses the existing authorized service boundary and dispatches only for a newly inserted message.
- Surface events resolve enabled inbound-capable links, persist the external receipt and canonical message atomically, and dispatch only once.
- Agent-bound `InboundMessage.chatId` is always the canonical conversation ID and `messageId` is the canonical message ID.
- Adapter-qualified identities are used for surface authors.
- Agent text is persisted with `origin: "agent"` and `state: "completed"`; eligible delivery rows are created atomically before router invocation.
- Duplicate agent callbacks reuse the repository client-key idempotency boundary and do not invoke surface delivery twice.
- Dispatch failure does not roll back the committed user/surface message and publishes a failed turn event.
- Non-text agent compatibility paths return `null` for later handling by the existing Discord path.

## Self-review

- Scope is limited to the requested conversation coordinator, service methods, barrel export, and focused tests/report.
- The coordinator depends on focused `Pick`/method interfaces rather than concrete dispatcher/router implementations.
- Delivery eligibility is computed before the atomic repository call and matches transcript routing rules.
- Agent reply idempotency requires `correlationId` or `messageId`; missing callback identity is rejected rather than silently risking duplicate output.
- Surface inserted detection compares the freshly generated canonical ID with the receipt-returned message ID. Coordinator-generated IDs are fresh, while duplicate receipts return the original ID.
- No unrelated pre-existing untracked files were modified or staged.

## Review follow-up

- Wrapped dispatcher invocation so thrown transport errors publish terminal `failed` after persistence, then rethrow the original error as the caller contract.
- Added direct coverage proving duplicate web client keys do not redispatch.
- Strengthened delivery ordering coverage: the router mock observes both the completed agent message and one pending delivery row during `deliver()`.
- Removed unused `isAvailable` from the focused `TurnDispatcher` interface; availability remains encapsulated by `dispatch()`'s boolean result.

Follow-up RED command:

`bun test tests/turnCoordinator.test.ts`

Follow-up RED result: exit 1; 7 pass, 1 fail. The throwing-dispatch test observed `["queued"]` instead of `["queued", "failed"]`, proving the missing terminal event.

Follow-up GREEN command:

`bun test tests/turnCoordinator.test.ts`

Follow-up GREEN result: exit 0; 8 pass, 0 fail, 34 assertions.

Follow-up regression result: `bun test tests/turnCoordinator.test.ts tests/conversationService.test.ts tests/conversationEvents.test.ts tests/conversationRepository.test.ts` exited 0 with 41 pass, 0 fail, 135 assertions across 4 files.

Follow-up typecheck result: `bun run typecheck` exited 0 with no TypeScript diagnostics.
