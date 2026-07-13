# Phase 3 Task 3 Report: Typed Client State and Reconnect Core

## Status

Implemented the typed browser API, durable local draft lifecycle, gap-first conversation reconnect stream, pure workspace reducer, and corrected canonical conversation event replay semantics.

## Implementation summary

- Added client-owned conversation/session/message/link/event types.
- Added `WorkspaceApi` with all required methods, encoded conversation IDs, JSON request headers, message idempotency headers, and safe `ApiError` handling for non-2xx responses.
- Added `DraftStore` using `switchboard:draft:<conversationId>`, persistent client keys, change-only key rotation, empty-text deletion, and late-response-safe `markSent` behavior.
- Added `ConversationStream` with injected gap fetch, EventSource, online state, and timers; gap-first initial/reconnect ordering; durable message-only cursors; explicit connection states; bounded retry delays; generation-based stale-work cancellation; and deterministic timer/source cleanup.
- Added `workspaceReducer` with message ID deduplication, sequence ordering, and conversation-selection cleanup of prior transcript/activity state.
- Split live activity delivery from the durable message high-water mark so same-sequence queued/working/failed events remain live while reconnect replay remains canonical-message-only.

## TDD evidence

Initial RED command:

`bun test web/client/api.test.ts web/client/drafts.test.ts web/client/conversationStream.test.ts tests/conversationEvents.test.ts`

Initial RED result: exit 1. Bun reported missing `./api`, `./drafts`, and `./conversationStream` modules, while the new conversation-event regression received only committed messages and omitted queued/working/failed at the current message sequence. These were the expected missing-feature failures.

Initial GREEN command:

`bun test web/client/api.test.ts web/client/drafts.test.ts web/client/conversationStream.test.ts tests/conversationEvents.test.ts`

Initial GREEN result: exit 0; 20 pass, 0 fail, 47 assertions.

Lifecycle RED command:

`bun test web/client/conversationStream.test.ts`

Lifecycle RED result: exit 1; 6 pass, 2 fail. Repeated source errors scheduled 2 timers instead of 1, and a stopped `c1` gap fetch emitted into the later `c2` selection. These failures proved the cleanup and stale-connection races.

Lifecycle GREEN command:

`bun test web/client/conversationStream.test.ts`

Lifecycle GREEN result: exit 0; 8 pass, 0 fail, 16 assertions.

Final focused command:

`bun test web/client/api.test.ts web/client/drafts.test.ts web/client/conversationStream.test.ts tests/conversationEvents.test.ts`

Final focused result: exit 0; 22 pass, 0 fail, 50 assertions.

## Verification commands

- `bun run typecheck` — exit 0; `tsc --noEmit` completed without diagnostics.
- `bun run build:web` — exit 0.
- `bun test` — exit 0; 852 pass, 0 fail, 2147 assertions across 118 files.
- `git diff --check` — exit 0; no whitespace errors (Git only reported the repository's LF-to-CRLF checkout warning).

## Files changed

- Created `web/client/types.ts`
- Created `web/client/api.ts`
- Created `web/client/api.test.ts`
- Created `web/client/drafts.ts`
- Created `web/client/drafts.test.ts`
- Created `web/client/conversationStream.ts`
- Created `web/client/conversationStream.test.ts`
- Created `web/client/state.ts`
- Modified `hub/conversations/events.ts`
- Modified `tests/conversationEvents.test.ts`
- Overwrote `.superpowers/sdd/task-3-report.md`

## Self-review

- Gap-first ordering is enforced both at initial start and every reconnect; SSE opens only after the durable history fetch and uses the post-gap cursor.
- Only canonical `message_committed` events with a message advance the stream cursor. Turn/activity events remain visible without moving the reconnect boundary.
- Reducer transcript ownership deduplicates history/SSE overlap by message ID and sorts by sequence.
- Offline errors close the source, emit `offline`, and do not enqueue a reconnect; online failures emit `reconnecting` and use bounded delays `[1000, 2000, 5000, 10000]`.
- A single reconnect timer is allowed, `stop()` closes/clears owned resources, and generation checks prevent slow stopped work from leaking into a newer selection.
- Draft client keys survive retries and unchanged writes; `markSent` cannot erase newer typing after a late successful response.
- API errors expose only JSON `{ error }` codes or the safe fallback `request_failed`; raw proxy/HTML bodies are not exposed.
- Server replay remains history/message-only, duplicate committed messages remain suppressed by the durable high-water mark, and live same-sequence queued/working/failed states are delivered.
- Scope is limited to the requested task files and report; unrelated pre-existing coordination artifacts were not modified or staged.

## Concerns

None.
