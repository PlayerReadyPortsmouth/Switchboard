# Task 5 report

## Status

Implemented the canonical conversation transcript, text composer, live activity disclosure, and structured conversation inspector while preserving the Task 4 routing, stream, reducer, draft, and drawer/focus model.

## TDD evidence

- Initial RED: `bun test web/client/ConversationView.test.tsx` failed because `ConversationView` was not exported from `App.tsx`.
- Composer/send GREEN: focused tests proved failed-text retention, exact idempotency-key retry, matching-draft-only clearing, canonical-response insertion, no optimistic transcript row, Enter/Shift+Enter/IME behavior, blank disablement, and the six-line cap.
- Transcript/activity GREEN: focused tests proved accessible origin labels, five-minute/non-reply grouping boundaries, resolved/dismissible reply preview, collapsed activity, streaming-state dedupe, and canonical ID dedupe/sequence ordering.
- Inspector GREEN: focused tests proved canonical primary-agent header refresh, safe link metadata, focus trapping, and desktop column collapse.
- Race RED/GREEN: an out-of-order PATCH test first ended on `reviewer` instead of the later `operator`; request generations now discard stale PATCH results. Late sends are also prevented from reducing into a newly selected conversation.
- Focus-trap RED/GREEN: with the cycling branch removed, Tab left focus on the last control; restoring it cycles last-to-first and Shift+Tab first-to-last.
- Desktop-collapse RED/GREEN: the CSS contract initially found no state-driven grid collapse; desktop now removes the inspector column and hides the closed region.

## Implementation

- Exported `ConversationView` from `App.tsx` as the selected-pane orchestrator. `App` remains owner of the selected conversation, single `ConversationStream`, canonical reducer state, routing, and cross-pane focus.
- Added focused `Transcript`, `MessageItem`, `Composer`, and `ActivityItem` components.
- Rendered canonical messages only, deduplicated by ID and ordered by sequence, with accessible role/origin labels, reply context, and restrained grouping.
- Added durable draft/idempotency handling, local sending/error state, exact-key retry, canonical-response reduction, and conversation/request generation guards.
- Added primary-agent PATCH with latest-response wins semantics, safe linked-surface summaries, sync/enabled/timestamp metadata, responsive inspector focus trapping/return, and desktop collapse.
- Kept external location IDs, internal message IDs, attachment/markdown controls, and Phase 4 operations out of the UI.

## Verification

- `bun test web/client/ConversationView.test.tsx web/client/App.test.tsx` — 53 pass, 0 fail, 156 assertions.
- `bun run typecheck` — exit 0 (`tsc --noEmit`).
- `bun run build:web` — exit 0.
- Review-fix full-suite run: `bun test` — 909 pass, 0 fail, 2311 assertions across 120 files.
- `git diff --check` — exit 0; only existing LF-to-CRLF conversion warnings were emitted.

## Files

- Created `web/client/ConversationView.test.tsx`.
- Created `web/client/components/Transcript.tsx`.
- Created `web/client/components/MessageItem.tsx`.
- Created `web/client/components/Composer.tsx`.
- Created `web/client/components/ActivityItem.tsx`.
- Modified `web/client/components/Inspector.tsx`.
- Modified `web/client/App.tsx`.
- Modified `web/client/styles.css`.
- Overwrote `.superpowers/sdd/task-5-report.md`.

## Design critique

- Direction: a quiet technical record rather than chat bubbles. Fine horizontal rules establish chronology; one-pixel origin traces distinguish sources without turning messages into colored cards.
- Signature: the existing signal-trace motif is concentrated in the live-activity disclosure, where it communicates actual turn progression.
- Typography: body copy remains the existing system sans stack; monospace is limited to origin/state/time and inspector labels.
- Composer: one grounded field/action assembly, with status and retry below it; no decorative container, gradients, glass, pills, or dead controls.
- Inspector: metadata reads as a ledger (`dl`, timestamps, linked-surface rows), not a stack of decorative cards.
- Responsive/accessibility: semantic articles, labelled controls, visible focus, reduced-motion inheritance, six-line composer cap, drawer focus trap, Escape/close focus return, and desktop state-driven collapse are preserved.
- Visual browser QA could not be performed because the in-app browser backend was unavailable; the design critique used source/CSS inspection plus responsive and semantic tests.

## Self-review

- Async send races: a request captures conversation ID and generation; a late success clears only its matching durable draft and cannot update a newer conversation or interrupt its send state.
- Conversation switching: reply, error, local fallback transcript, and composer state reset to the selected conversation's durable draft; `App` retains the only stream/reducer ownership.
- Retry semantics: unchanged failed content reuses the same persisted key; editing invalidates the failed attempt and creates the draft lifecycle's new key.
- PATCH races: only the newest agent update response can refresh header/inspector state.
- Accessibility: four origins have distinct article labels; activity is collapsed; repeated streaming chunks do not add repeated state announcements; tablet/mobile inspector focus is trapped and returned to the trigger.
- Metadata safety: link ID, external location ID, message ID, and client idempotency key are never rendered.
- Visual restraint: no new font dependency, gradient, glass, excessive pill, attachment UI, markdown composer, or Phase 4 operation was introduced.
- Responsibilities: leaf components render one concern; `ConversationView` coordinates reply/send/metadata UI; `App` retains canonical workspace ownership.

## Concerns

- No known functional concerns.
- Visual QA is limited to source/test inspection because the in-app browser was unavailable in this session.

## Important review fixes

- Primary-agent PATCH failures are no longer swallowed. The controlled selector remains on the canonical agent, a clearly named inline `aria-live="polite"` status explains the failure, and the enabled control can retry immediately.
- Agent request generations now gate failure as well as success. An older rejected PATCH cannot roll back or announce over a newer canonical success, and a rejection from a previous conversation is ignored.
- Transcript grouping now requires the later sequence's timestamp delta to be within the inclusive range `0..300000` milliseconds. Negative timestamps no longer group.
- Added deferred-promise RED→GREEN coverage for failure, canonical restoration, retry success, stale failure after newer success, and failure after conversation switching.
- Added boundary coverage for exactly five minutes, over five minutes, negative timestamp delta, changed author, and replies.
- RED evidence: the failure/retry test could not find the required named status; the negative-delta test received `data-grouped="true"` instead of `false`.
- GREEN evidence: focused ConversationView/App tests report 53 pass and 0 fail; typecheck and web build exit 0; the single review-fix full suite reports 909 pass and 0 fail.
