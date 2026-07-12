# Task 5 report: Conversation HTTP and resumable SSE API

## Result

- Added authenticated collection, item, message, event, and transport-link routes under `/api/conversations`.
- Added decoded path IDs, JSON/input validation, service/repository error-to-status mapping, wrong-method handling, and documented 200/201 behavior.
- Added resumable SSE framing with `id:` and serialized `data:`, supporting `after` and `Last-Event-ID` cursors.
- Added transport-local idempotency status tracking so repeated successful requests using the same identity, conversation, and `Idempotency-Key` return the canonical message with 200 after the initial 201.
- Preserved existing route authentication and status behavior.

## TDD evidence

RED:

`bun test tests/conversationWeb.test.ts`

Result: 0 pass, 6 fail, 6 expect() calls. Each new route returned 404 as expected.

GREEN (focused):

`bun test tests/conversationWeb.test.ts`

Result: 6 pass, 0 fail, 21 expect() calls.

Final verification:

- `bun test tests/conversationWeb.test.ts tests/webServer.test.ts tests/web.test.ts` — 39 pass, 0 fail, 96 expect() calls.
- `bun test` — 720 pass, 0 fail, 1719 expect() calls.
- `bun run typecheck` — exit 0.
- `git diff --check` — exit 0 (Git emitted only its configured LF-to-CRLF working-copy warning).

## Self-review

- Authentication runs before method dispatch, matching the existing anti-enumeration behavior: unauthenticated known routes return 400 and authenticated wrong methods return 405.
- Conversation IDs are decoded only at dispatch, with malformed encodings mapped to 400.
- Cursor parsing accepts only safe, non-negative decimal integers; query `after` takes precedence over `Last-Event-ID`.
- SSE cancellation invokes the injected unsubscribe function.
- Existing channel SSE framing remains unchanged.
- The initial process-local idempotency implementation described below was superseded by the durable review follow-up.

## Concerns

- The existing production `WebDeps` composition does not yet construct the conversation repository/service. Conversation dependency members remain optional for staged compatibility and must be injected before these routes are served in production; this task tests the required injected composition directly.
- Production construction remains intentionally deferred to Task 6; until then authenticated conversation actions fail closed with 503.

## Review follow-up: authorization, durable idempotency, and validation

- Made `subscribeConversation` identity-aware; the trusted authenticated email now crosses the dependency boundary before subscription, and non-members map to 403.
- Carried repository `AppendMessageResult` through `ConversationService` and `WebDeps`. HTTP status now comes from durable `inserted`, eliminating process-local classification and correctly handling fresh dependency objects and concurrent requests.
- Changed normal missing-conversation service paths to throw `RepositoryNotFoundError`, preserving validation errors for malformed operations and enabling HTTP 404 mapping.
- Added focused coverage for repository conflict 409, validation 400, unauthenticated wrong methods, malformed percent encoding, query-cursor precedence, SSE cancellation, non-member SSE, malformed `includeArchived`, and malformed link options.
- Conversation routes return a controlled 503 while Task 6's production service dependencies are absent, instead of throwing a `TypeError`. Task 6 still owns `hub/index.ts` construction and wiring.

Review RED evidence:

`bun test tests/conversationWeb.test.ts tests/conversationService.test.ts`

Result: 9 pass, 7 fail, 43 expect() calls. Failures reproduced the discarded insertion result, identity-less SSE boundary, unvalidated query/link options, and wrong missing-conversation error type.

Missing-dependency RED evidence:

`bun test tests/conversationWeb.test.ts`

Result: 11 pass, 1 fail, 36 expect() calls. The absent Task 6 dependency reproduced the accidental `TypeError`.

Review final verification:

- `bun test tests/conversationWeb.test.ts tests/conversationService.test.ts tests/conversationRepository.test.ts tests/webServer.test.ts tests/web.test.ts` — 60 pass, 0 fail, 161 expect() calls.
- `bun test` — 726 pass, 0 fail, 1739 expect() calls.
- `bun run typecheck` — exit 0.
- `git diff --check` — exit 0 (Git emitted only configured LF-to-CRLF working-copy warnings).
