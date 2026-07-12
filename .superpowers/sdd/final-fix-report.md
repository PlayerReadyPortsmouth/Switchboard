# Final review fix report

## Outcome

- Enforced `replyTo` inside the repository's immediate append transaction. A reply target must exist and have the same `conversation_id`; missing and cross-conversation targets throw `RepositoryConflictError`, which the service exposes as `ConversationValidationError` and HTTP 400.
- Added repository, service, and real repository/service HTTP coverage for valid, missing, and cross-conversation replies.
- Trimmed adapter and external-location IDs at the HTTP and service boundaries and rejected blank values.
- Set the message-history maximum page size to 200 at both HTTP and service boundaries and documented it.
- Added v1 SQLite `CHECK` constraints for participant kind/role, message origin/state, transport sync mode, and delivery state, with migration tests.

## TDD evidence

RED command:

`bun test tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts tests/conversationMigrations.test.ts`

Result: exit 1; 27 pass, 6 fail, 100 assertions. Expected failures reproduced the raw SQLite foreign-key error for a missing reply, acceptance of invalid enum values, unbounded pages, and untrimmed/blank link identifiers.

GREEN command:

`bun test tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts tests/conversationMigrations.test.ts`

Result: exit 0; 33 pass, 0 fail, 113 assertions.

## Final verification

- `bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts tests/conversationEvents.test.ts tests/webServer.test.ts tests/web.test.ts` — exit 0; 73 pass, 0 fail, 201 assertions.
- `bun run typecheck` — exit 0; `tsc --noEmit` completed successfully.
- `bun test` — exit 0; 736 pass, 0 fail, 1776 assertions across 103 files.
- `git diff --check` — exit 0; no whitespace errors (only configured LF-to-CRLF warnings while displaying the diff).

## Self-review

- Confirmed reply validation occurs after conversation/archive validation and before sequence allocation or insertion in the same immediate transaction.
- Confirmed invalid replies do not insert a message or advance the target conversation's stored messages.
- Confirmed the HTTP integration test exercises the actual SQLite repository and service and returns 201/400/400 for valid/missing/cross-conversation targets, never a raw 500.
- Confirmed duplicate client-key lookup remains first, preserving canonical idempotent replay behavior.
- Confirmed the 200-message limit is consistent between transport and application boundaries and the documented default remains 100.
- Confirmed link normalization is defense-in-depth at HTTP and service boundaries.
- Confirmed every requested enum-like v1 column has a matching SQLite check and invalid inserts are rejected.
- Confirmed no Phase 2 agent submission or transport delivery behavior was introduced.

## Concerns

The checks are part of the v1 creation schema as requested. A database that already recorded migration version 1 before this branch's schema ships would not be rebuilt automatically; this feature is still in its pre-release migration phase, so no version-2 table-rebuild migration was added.

## Final re-review: blank reply IDs

- Repository appends now treat a provided empty or whitespace-only `replyTo` as `RepositoryConflictError`, so no raw SQLite foreign-key exception can escape.
- The service rejects blank reply IDs as `ConversationValidationError` before repository access and trims padded valid IDs to their canonical value.
- Repository, service, and real HTTP tests cover empty and whitespace-only values; the service and HTTP tests also preserve padded valid same-conversation reply behavior.

RED command:

`bun test tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts`

Result: exit 1; 29 pass, 3 fail, 102 assertions. The failures reproduced the raw SQLite error for `replyTo: ""`, rejection rather than normalization of a padded valid ID, and the HTTP 500 path.

Final focused command:

`bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts tests/conversationService.test.ts tests/conversationWeb.test.ts tests/conversationEvents.test.ts tests/webServer.test.ts tests/web.test.ts`

Result: exit 0; 73 pass, 0 fail, 210 assertions.

Additional verification:

- `bun run typecheck` — exit 0; `tsc --noEmit` completed successfully.
- `bun test` — exit 0; 736 pass, 0 fail, 1785 assertions across 103 files.
- `git diff --check` — exit 0; no whitespace errors.

Re-review self-check: blank inputs cannot reach the insert, padded valid IDs are stored trimmed, missing/cross-conversation checks still use the same transaction, and valid same-conversation replies still return 201 over HTTP.
