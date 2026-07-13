# Final review fix report

## Outcome

Addressed all five final-review areas.

- Inbound canonical surface events now persist durable fan-out deliveries to every other enabled transcript-eligible link, excluding the origin. Mixed two-way/outbound/inbound-only routing is covered.
- Delivery rows have atomic owner/expiry leases (schema v3). Coordinators and workers claim before I/O, non-owners cannot complete a claim, and expired claims are recoverable.
- Canonical Discord text sends include `allowedMentions: { parse: [] }` on every chunk.
- The coordinator rejects normalized events with non-finite timestamps or blank adapter/event/location/message/author/content fields before persistence or dispatch. Adapter callback error reporting safely receives the rejection.
- Canonical Discord capabilities remain deliberately text/reply-only. Migrated Discord channels retain rich cards, interactions, reactions, edits, and attachments through the legacy compatibility path; the architecture documentation now states this boundary explicitly.

## Verification

- Focused transport/repository/gateway suite: 77 passed, 0 failed, 205 assertions.
- Typecheck: `tsc --noEmit` exited 0.
- Integrated composition/mirror smokes: 6 passed, 0 failed, 17 assertions.
- Full suite: 814 passed, 0 failed, 1,996 assertions across 111 files.
- `git diff --check`: clean.

## Notes

The lease duration is 30 seconds. A process that remains alive but spends longer than that inside an adapter send could allow a recovery worker to retry; deterministic Discord nonces still provide adapter-side deduplication, and the lease duration is documented for future tuning/renewal if slow adapters are added.

## R2 follow-up

- Canonical web/inbound dispatch no longer awaits opportunistic surface I/O. Delivery rows are persisted first, agent dispatch happens once, and background ownership loss is reported without failing the committed turn.
- Workers treat only `RepositoryConflictError` terminal/ownership races as another executor winning; unrelated persistence failures still escape and are reported.
- Added a canonical-to-Discord compatibility resolver for cards, attachments, edits, reactions, and other legacy rich reply routing.
- Malformed normalized envelopes now enter the hub audit/error reporter before rejection.
- Shutdown remains intentionally unbounded while an adapter send is active because the adapter contract has no abort signal; this is documented rather than closing SQLite while active work can still write.

R2 verification: focused coordinator/worker/rich-compatibility tests passed; `tsc --noEmit` passed; integrated composition/mirror tests passed 7/7; full suite passed 817/817 with 2,007 assertions across 112 files; `git diff --check` passed.

## R3 follow-up

- Canonical agent output now uses the same handled, tracked background-delivery path as web and inbound messages; callback resolution is independent of slow adapters and stale-owner completion is reported.
- `TurnCoordinator.drainDeliveries()` is wired into shutdown after the retry worker and before adapters/database close.
- Legacy rich Discord resolution accepts only enabled `two_way`/`outbound_only` links, chooses one deterministically by creation time/link id, safely declines unresolved canonical conversations, and preserves raw Discord channel ids.

R3 verification: focused/integrated suites passed 51/51; `tsc --noEmit` passed; full suite passed 820/820 with 2,032 assertions across 112 files; `git diff --check` passed.

## R4 follow-up

- Added idempotent `TurnCoordinator.beginShutdown()` as an atomic no-new-turns boundary before worker stop/drain.
- Post-boundary web, surface, and agent callbacks are controlled and cannot persist, dispatch, schedule delivery, fall through to legacy routing, or touch a closed database.
- Background delivery cleanup uses fully handled promise branches; reporter exceptions are swallowed and covered by an unhandled-rejection regression.
- Documentation now distinguishes reported coordinator ownership loss from deliberately ignored worker stale-owner conflicts.

R4 verification: focused/integrated suites passed 43/43; `tsc --noEmit` passed; full suite passed 822/822 with 2,041 assertions across 112 files; `git diff --check` passed.

## R5 follow-up

- Added one shared production ingress gate, closed before coordinator shutdown.
- Both Discord inbound paths now reject post-boundary ordinary and legacy-command events before migration, persistence, or dispatch.
- Every agent reply kind and attachment/file/note callback is denied before legacy resolution or gateway I/O after the boundary.
- Extracted regression counts ensure/persist/dispatch and every rich producer before/after close.

R5 verification: focused/integrated suites passed 45/45; `tsc --noEmit` passed; full suite passed 823/823 with 2,063 assertions across 113 files; `git diff --check` passed.
