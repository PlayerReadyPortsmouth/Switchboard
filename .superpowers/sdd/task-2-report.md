# Task 2 Report: Delivery and Link Repository Operations

## Status

Implemented the canonical SQLite repository operations for transport-link resolution, atomic agent message and delivery persistence, idempotent delivery creation, delivery outcome transitions, and bounded due-delivery polling.

## TDD evidence

- RED: `bun test tests/conversationRepository.test.ts`
  - Result: exit 1; 12 passed, 5 failed.
  - Expected failures were missing `resolveTransportLink`, `appendAgentMessage`, and `createDeliveries` repository methods.
- GREEN: `bun test tests/conversationRepository.test.ts`
  - Result after implementation: exit 0; 17 passed, 0 failed.
- Final focused verification: `bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts`
  - Result: exit 0; 20 passed, 0 failed, 56 assertions.
- Type verification: `bun run typecheck`
  - Result: exit 0 (`tsc --noEmit`).
- Full regression suite: `bun test`
  - Result: exit 0; 749 passed, 0 failed, 1812 assertions across 104 files.
- Diff hygiene: `git diff --check`
  - Result: exit 0; no whitespace errors.

## Coverage added

- Adapter/external-location link resolution and missing-link behavior.
- Atomic agent message plus delivery insertion, including transaction rollback.
- Idempotent repeated agent callbacks and unique `(message_id, link_id, event_kind)` deliveries.
- Delivered state and external message ID persistence.
- Retry attempt increments, next-attempt timestamps, 500-character error truncation, and exhausted state.
- Pending and elapsed-retry due selection, deterministic ordering, requested limits, and the hard 200-row cap.

## Self-review

- `appendAgentMessage` uses one SQLite immediate transaction around message and delivery writes.
- Delivery IDs are generated only for attempted inserts; tuple uniqueness remains the canonical idempotency guard, and existing rows are returned after conflicts.
- State transitions throw `RepositoryNotFoundError` for unknown delivery IDs and clear stale retry data on successful delivery.
- Due polling excludes delivered, exhausted, and future retry rows and clamps caller limits to 200.
- No schema migration was required because the Phase 1 schema already defines delivery columns and tuple uniqueness.

## Concerns

None identified. The task brief listed `hub/conversations/types.ts`, but the required `Delivery`, `DeliveryState`, and `TransportLink` domain types already existed unchanged from Phase 1; only repository interfaces and implementation required extension.

## Review follow-up

Addressed the repository integrity review findings:

- Delivery creation now resolves the canonical message conversation and validates every persisted link belongs to it inside the same immediate transaction. Missing or cross-conversation links raise `RepositoryConflictError`; agent message insertion is rolled back.
- Non-exhausted retries now require a non-null `nextAttemptAt`.
- Delivered and exhausted rows are terminal. Delivery outcome updates are guarded to `pending`/`retry_wait`, returning `RepositoryConflictError` instead of reopening terminal rows.

### Follow-up TDD and verification evidence

- RED: `bun test tests/conversationRepository.test.ts`
  - Result: exit 1; 18 passed, 3 failed.
  - Expected failures reproduced cross-conversation delivery acceptance, null retry scheduling, and reopening a delivered row.
- GREEN: `bun test tests/conversationRepository.test.ts`
  - Result: exit 0; 21 passed, 0 failed, 57 assertions.
- Focused final: `bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts`
  - Result: exit 0; 23 passed, 0 failed, 65 assertions.
- Type verification: `bun run typecheck`
  - Result: exit 0 (`tsc --noEmit`).
- Full regression suite: `bun test`
  - Result: exit 0; 752 passed, 0 failed, 1821 assertions across 104 files.
