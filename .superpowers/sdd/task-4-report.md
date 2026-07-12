# Task 4 Report: Discord Surface Adapter

## Status

Implemented and verified.

## TDD evidence

- RED: `bun test tests/discordAdapter.test.ts hub/gateway.test.ts`
  - Exit 1.
  - `Cannot find module '../hub/surfaces/discordAdapter'`.
  - Gateway contract test received `undefined` for `Gateway.prototype.stop`.
- GREEN focused run: same command exited 0 with 20 pass, 0 fail.
- Final required verification: `bun test tests/discordAdapter.test.ts hub/gateway.test.ts tests/gateway-helpers.test.ts; if ($LASTEXITCODE -eq 0) { bun run typecheck }`
  - Exit 0.
  - 25 pass, 0 fail, 54 assertions.
  - `tsc --noEmit` exited 0.
- Hygiene: `git diff --check` exited 0 (only Git line-ending notices).

## Implemented behavior

- Added `DiscordAdapter`, named `discord`, with explicit capabilities.
- Added narrow `DiscordGatewayPort`: inbound registration, lifecycle, and text delivery only.
- Normalizes Discord message/location/author/content/timestamp/reply identifiers.
- Converts canonical author/content/reply metadata to Discord text delivery.
- Converts send exceptions and unavailable channels to typed delivery failures.
- Added `Gateway.stop()` using `client.destroy()`.
- Added `Gateway.sendText()` with 2,000-character chunking, reply metadata on the first chunk, and the first posted Discord message ID as its result.
- Preserved existing `sendReply`, card, interaction, reaction, modal, thread, file, and plain-text APIs.

## Self-review

- Compatibility: legacy Gateway paths were not moved or removed; the adapter uses only the narrow port.
- Boundary: adapter imports no repositories, agent registry, or agent configuration.
- Error behavior: adapter reports the original gateway error message; the surface router may still sanitize thrown adapter failures independently.
- Deliberate result semantics: a chunked send returns the first external Discord ID because that ID represents the canonical reply target for the delivered message.
- Scope note: `InboundMessage.replyToMessageId` and the surfaces barrel export were necessary supporting changes beyond the brief's enumerated files.

## Concerns

- Discord creates one external message per chunk while `SurfaceDeliveryResult` carries one ID. Only the first ID can be retained by the current contract.

## Review follow-up

- Added `SurfaceDelivery.replyToExternalId`; the adapter no longer passes canonical `Message.replyTo` values to Discord.
- Added deterministic SHA-256-derived, 25-character per-delivery/per-chunk Discord nonces with `enforceNonce: true`. A retry reuses each nonce, allowing Discord to deduplicate chunks already accepted before a later chunk failed.
- Narrowed advertised canonical capabilities to text and replies. Cards, attachments, edits, and deletes are false.
- Forward references no longer normalize as replies.
- Rejected asynchronous inbound handlers are caught and routed to an injectable error reporter.

Review RED evidence:

- `bun test tests/discordAdapter.test.ts hub/gateway.test.ts`
- Result: 18 pass, 7 fail. Failures directly reproduced all five review findings, including a second-chunk failure/retry leaving only one nonce entry without the fix.

Review GREEN / final verification:

- `bun test tests/discordAdapter.test.ts hub/gateway.test.ts tests/surfaceRouter.test.ts; if ($LASTEXITCODE -eq 0) { bun run typecheck }`
- Result: exit 0; 31 pass, 0 fail, 64 assertions; `tsc --noEmit` exited 0.

Review self-check:

- Existing `sendReply` remains unchanged and does not opt into adapter nonce semantics.
- Nonces contain lowercase hexadecimal characters only and are exactly 25 characters, within Discord's limit.
- The delivery ID is stable across queue retries and the chunk index is stable for immutable canonical message content, so nonce reuse is deterministic.
- The gateway still returns the first chunk's external ID; the delivery result schema cannot represent every chunk ID.

## Review r2 follow-up

- Added repository lookup of a delivered external message ID by canonical message ID and transport link ID.
- The coordinator persists canonical `replyTo`, resolves its delivered parent independently for each link, and supplies the resulting external IDs through the router to adapters.
- Added a production-path integration test covering coordinator → SQLite repository → surface router → Discord adapter and proving the Discord parent ID reaches the gateway.
- Extended delivery results with optional `retryable`; absence means retryable, while failed Discord compensation explicitly returns `retryable: false`.
- On a partial chunk send failure, Gateway deletes every message posted in that attempt in reverse order. Successful cleanup permits retry; any cleanup failure blocks retry to prevent duplication.
- Deterministic Discord nonces remain as immediate duplicate protection in addition to compensation.
- Forward normalization tests now use `MessageReferenceType.Forward` rather than its numeric representation.

Review r2 RED evidence:

- `bun test hub/gateway.test.ts tests/discordAdapter.test.ts tests/conversationRepository.test.ts tests/turnCoordinator.test.ts`
- Result: 53 pass, 5 fail. Failures reproduced missing repository resolution, missing production threading, absent compensation, and missing non-retryable propagation.

Review r2 GREEN / final verification:

- `bun test hub/gateway.test.ts tests/discordAdapter.test.ts tests/surfaceRouter.test.ts tests/turnCoordinator.test.ts tests/conversationRepository.test.ts; if ($LASTEXITCODE -eq 0) { bun run typecheck }`
- Result: exit 0; 64 pass, 0 fail, 162 assertions; `tsc --noEmit` exited 0.

Review r2 self-check:

- Parent resolution is scoped to the exact link, preventing an external ID from one surface/location being used on another.
- Missing, pending, failed, or null-ID parent deliveries omit reply metadata and still deliver plain text.
- Successful compensation reports a normal retryable failure; failed compensation is the only path that sets `retryable: false`.
- Legacy `sendReply` is unchanged.

## Final reply-path follow-up

- Added schema migration v2 with `external_message_links`, keyed by canonical message and link and uniquely constraining external IDs within each link.
- Migration execution now applies v2 both to fresh databases and databases already carrying migration v1, and sets `user_version` to 2.
- Inbound receipt recording atomically persists the canonical message receipt and its link-scoped external message ID. Duplicate receipt processing reuses the canonical message and mapping.
- Repository reply resolution now checks link-scoped inbound mappings as well as delivered outbound rows, without cross-link fallback.
- `acceptSurfaceEvent` passes its resolved link ID and normalized external message ID into persistence.
- Replaced the coordinator threading integration setup with a true inbound normalized Discord event → persisted canonical parent → agent canonical reply → router → Discord adapter test.

Final reply-path RED evidence:

- `bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts tests/turnCoordinator.test.ts`
- Result: 31 pass, 4 fail. Failures reproduced the absent v2 schema, missing inbound mapping, and missing end-to-end external reply resolution.

Final reply-path GREEN / final verification:

- `bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts tests/turnCoordinator.test.ts tests/surfaceRouter.test.ts tests/discordAdapter.test.ts hub/gateway.test.ts; if ($LASTEXITCODE -eq 0) { bun run typecheck }`
- Result: exit 0; 68 pass, 0 fail, 176 assertions; `tsc --noEmit` exited 0.
