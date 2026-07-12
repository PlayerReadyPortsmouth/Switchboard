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
- Successful idempotency entries are recorded only after the injected append returns, so failed attempts do not poison retries.

## Concerns

- The existing production `WebDeps` composition does not yet construct the conversation repository/service. Conversation dependency members remain optional for staged compatibility and must be injected before these routes are served in production; this task tests the required injected composition directly.
- Duplicate HTTP status memory is process-local. Repository idempotency remains durable and canonical, but the first retry after an HTTP process restart can report 201 because the service method intentionally returns only the domain `Message`, not the repository insertion flag.
