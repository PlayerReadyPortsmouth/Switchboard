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
