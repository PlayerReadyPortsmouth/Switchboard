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
