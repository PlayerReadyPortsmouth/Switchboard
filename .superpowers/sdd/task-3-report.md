# Task 3 Report: Authorized Conversation Service

## Files

- `hub/conversations/service.ts` — added the authorized application service, validation errors, role checks, trusted web-message creation, lifecycle operations, and transport-link operations.
- `hub/conversations/repository.ts` — added `createConversationWithOwner` to the repository contract.
- `hub/conversations/sqliteRepository.ts` — implemented atomic conversation/owner creation and retained `createConversation` compatibility.
- `tests/conversationService.test.ts` — added role, lifecycle, validation, archive, and transport-link coverage.

## TDD evidence

1. RED: `bun test tests/conversationService.test.ts`
   - Exit 1: `Cannot find module '../hub/conversations/service'`
2. GREEN: `bun test tests/conversationService.test.ts`
   - Exit 0: 4 pass, 0 fail, 20 assertions.

## Self-review

- Creation trims and validates title/primary agent, and persists the conversation plus owner atomically.
- Read access accepts owner/member/viewer; writes accept owner/member; archive and link creation require owner.
- User message authors and origin come from trusted service inputs, not caller-supplied fields.
- Archived repository conflicts are exposed as service validation errors.
- Transport links default to `two_way` and enabled.
- Existing repository creation behavior remains compatible by delegating to the new transaction method.
- No unrelated working-tree files were changed or staged.

## Exact verification

Command:

`bun test tests/conversationService.test.ts tests/conversationRepository.test.ts; if ($LASTEXITCODE -eq 0) { bun run typecheck }`

Result: exit 0; 12 pass, 0 fail, 33 assertions; `tsc --noEmit` completed successfully.

Command:

`git diff --check`

Result: exit 0; no whitespace errors (Git emitted only line-ending conversion warnings).

## Review fix: owner transaction invariant

- Added a repository regression test covering mismatched conversation ID, creator identity, and owner role.
- Each case asserts the creation rejects with `RepositoryConflictError` and leaves both conversations and participants empty.
- Added explicit invariant validation inside the repository creation transaction.

RED command:

`bun test tests/conversationRepository.test.ts --test-name-pattern "mismatched conversation owners"`

Result: exit 1; 0 pass, 1 fail. The first mismatch produced a raw foreign-key error instead of `RepositoryConflictError`, proving explicit validation was missing.

GREEN command:

`bun test tests/conversationRepository.test.ts --test-name-pattern "mismatched conversation owners"`

Result: exit 0; 1 pass, 0 fail, 9 assertions.

Full verification command:

`bun test tests/conversationRepository.test.ts tests/conversationService.test.ts; if ($LASTEXITCODE -eq 0) { bun run typecheck }`

Result: exit 0; 13 pass, 0 fail, 42 assertions; `tsc --noEmit` completed successfully.
