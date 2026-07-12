# Task 4 report: Sequenced conversation events

## Result

- Added `ConversationEvent` and a synchronous `ConversationEventStream` with replay, live delivery, unsubscribe, and a per-subscription high-water mark.
- Registered subscriptions before history lookup and buffered live events during replay, preventing duplicates when replay overlaps a live publication.
- Changed `appendMessage` to return `{ message, inserted }`, preserving canonical idempotency while making insertion explicit.
- Published `message_committed` only after `appendMessage` returned, and only for newly inserted messages.
- Kept the event stream optional in `ConversationService` so existing construction and behavior remain compatible.

## TDD evidence

RED:

`bun test tests/conversationEvents.test.ts tests/conversationService.test.ts tests/conversationRepository.test.ts`

Failed as expected because `hub/conversations/events.ts` did not exist and repository results did not expose `message`/`inserted`.

GREEN (focused):

`bun test tests/conversationEvents.test.ts tests/conversationService.test.ts tests/conversationRepository.test.ts`

Result: 16 pass, 0 fail, 45 expect() calls.

Final verification:

- `bun run typecheck` — exit 0.
- `bun test` — 711 pass, 0 fail, 1692 expect() calls.
- `git diff --check` — exit 0 (Git emitted only configured LF-to-CRLF working-copy warnings).

## Self-review

- Replay messages are sorted by sequence and converted to `message_committed` events using their persisted timestamps.
- Live publications during history lookup are buffered; replay advances the high-water mark and overlapping buffered events are suppressed.
- Events from other conversations are isolated by the subscription map.
- Duplicate client keys return `inserted: false`, so the service returns the canonical message without republishing.
- External event recording retains its prior `Message` return type while consuming the new internal append result.

## Concerns

- The history callback is synchronous by design, matching the current synchronous repository. A future asynchronous repository would require an async subscription/replay contract.
