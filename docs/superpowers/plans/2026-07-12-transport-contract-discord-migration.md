# Transport Contract and Discord Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web and Discord first-class surfaces of the same canonical conversation pipeline, with Discord behind a reusable adapter contract and the hub able to run without Discord.

**Architecture:** Add a transport router beside the Phase 1 conversation service. Platform adapters normalize inbound events and execute delivery requests; they never select agents or write SQLite directly. A canonical turn coordinator persists inbound messages, dispatches the primary agent using `conversationId` as its chat key, persists agent output, and plans idempotent deliveries to eligible links.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Discord.js 14, existing agent `Dispatcher`, Bun test.

## Global Constraints

- Existing Discord behavior and regression tests remain passing.
- The hub starts and supports agent-backed web conversations when Discord is disabled.
- Canonical messages commit before agent dispatch or transport delivery.
- New transport-neutral APIs use `conversationId`; external channel/message IDs remain adapter metadata.
- New links default to `two_way`; all four sync modes are enforced.
- Adapter event IDs and delivery uniqueness prevent duplicate ingestion and mirror loops.
- A failed adapter delivery never rolls back a canonical message or blocks another adapter.
- Adapters do not access SQLite, choose agents, or bypass authorization/audit.
- No Slack or Teams implementation is included; their future addition must require no conversation-schema redesign.

---

## File Structure

- `hub/surfaces/types.ts` — normalized inbound envelopes, adapter capabilities and delivery results.
- `hub/surfaces/adapter.ts` — `SurfaceAdapter` lifecycle/send contract.
- `hub/surfaces/router.ts` — adapter registry, link-mode planning, delivery execution and isolation.
- `hub/surfaces/discordAdapter.ts` — Discord `Gateway` wrapper and event normalization.
- `hub/conversations/turnCoordinator.ts` — canonical inbound/agent-output orchestration.
- `hub/conversations/repository.ts` and `sqliteRepository.ts` — external-link resolution, agent append and delivery state operations.
- `hub/conversations/migrations.ts` — version 2 indexes/columns only where Task 2 tests prove they are required.
- `hub/gateway.ts` — platform-specific Discord I/O retained behind the adapter.
- `hub/index.ts` — optional adapter composition and removal of direct canonical-path gateway calls.
- `hub/types.ts` and `hub/config.ts` — optional Discord configuration.
- `tests/surfaceRouter.test.ts`, `tests/discordAdapter.test.ts`, `tests/turnCoordinator.test.ts`, `tests/transportMirror.test.ts`, `tests/discordOptional.test.ts` — focused and integration coverage.

---

### Task 1: Surface Adapter Contract and Delivery Planning

**Files:**
- Create: `hub/surfaces/types.ts`
- Create: `hub/surfaces/adapter.ts`
- Create: `hub/surfaces/router.ts`
- Create: `hub/surfaces/index.ts`
- Create: `tests/surfaceRouter.test.ts`

**Interfaces:**
- Produces `NormalizedSurfaceEvent`, `SurfaceDelivery`, `SurfaceDeliveryResult`, `SurfaceCapabilities`, `SurfaceAdapter`, and `SurfaceRouter`.

- [ ] **Step 1: Write failing routing tests**

Test that a registered adapter receives eligible deliveries, disabled links are skipped, `inbound_only` links reject transcript output, an adapter exception becomes a failed result without preventing a second adapter, and an unknown adapter returns a typed failure.

```ts
test("isolates adapter failures while delivering to other eligible links", async () => {
  const router = new SurfaceRouter([throwingAdapter("discord"), recordingAdapter("slack")])
  const results = await router.deliver(message(), [link("discord", "two_way"), link("slack", "outbound_only")])
  expect(results.map((r) => [r.adapter, r.ok])).toEqual([["discord", false], ["slack", true]])
})
```

- [ ] **Step 2: Run the focused test**

Run: `bun test tests/surfaceRouter.test.ts`

Expected: FAIL because `hub/surfaces/router.ts` does not exist.

- [ ] **Step 3: Define exact contracts**

```ts
export interface NormalizedSurfaceEvent {
  adapter: string; eventId: string; externalLocationId: string; externalMessageId: string
  authorId: string; authorName: string; content: string; createdAt: number
  replyToExternalId?: string
}
export interface SurfaceDelivery { deliveryId: string; conversationId: string; link: TransportLink; message: Message }
export interface SurfaceDeliveryResult { deliveryId: string; adapter: string; ok: boolean; externalMessageId?: string; error?: string }
export interface SurfaceCapabilities { text: boolean; replies: boolean; cards: boolean; attachments: boolean; edits: boolean; deletes: boolean }
export interface SurfaceAdapter {
  readonly name: string
  readonly capabilities: SurfaceCapabilities
  start(onEvent: (event: NormalizedSurfaceEvent) => Promise<void>): Promise<void>
  stop(): Promise<void>
  send(delivery: SurfaceDelivery): Promise<SurfaceDeliveryResult>
}
```

- [ ] **Step 4: Implement router eligibility and isolation**

`SurfaceRouter` rejects duplicate adapter names in its constructor, exposes `startAll`, `stopAll`, and `deliver`, and selects links as follows: transcript messages may deliver through `two_way` or `outbound_only`; notification events may also use `notifications_only`; `inbound_only` never receives output. Catch adapter errors and convert them to sanitized results.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test tests/surfaceRouter.test.ts && bun run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hub/surfaces tests/surfaceRouter.test.ts
git commit -m "feat(transports): define surface adapter contract"
```

---

### Task 2: Delivery and Link Repository Operations

**Files:**
- Modify: `hub/conversations/repository.ts`
- Modify: `hub/conversations/sqliteRepository.ts`
- Modify: `hub/conversations/types.ts`
- Test: `tests/conversationRepository.test.ts`

**Interfaces:**
- Produces `resolveTransportLink(adapter, externalLocationId)`, `appendAgentMessage`, `createDeliveries`, `markDeliveryDelivered`, `markDeliveryRetry`, and `listDueDeliveries`.

- [ ] **Step 1: Add failing repository tests**

Cover external-location resolution, atomic agent message insertion plus delivery rows, delivery uniqueness, delivered external ID persistence, retry attempts/next time, exhausted state, and due-delivery ordering.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun test tests/conversationRepository.test.ts`

Expected: compile failure for missing repository methods.

- [ ] **Step 3: Extend repository types**

Add:

```ts
appendAgentMessage(input: AppendMessageInput, links: TransportLink[], now: number): { message: Message; deliveries: Delivery[]; inserted: boolean }
resolveTransportLink(adapter: string, externalLocationId: string): TransportLink | null
createDeliveries(messageId: string, links: TransportLink[], eventKind: string, now: number): Delivery[]
markDeliveryDelivered(id: string, externalMessageId: string | null, now: number): Delivery
markDeliveryRetry(id: string, error: string, nextAttemptAt: number | null, exhausted: boolean, now: number): Delivery
listDueDeliveries(now: number, limit?: number): Delivery[]
```

- [ ] **Step 4: Implement transactional operations**

Agent message plus delivery creation occurs in one immediate transaction. Existing `(message_id, link_id, event_kind)` uniqueness makes retry and repeated agent callbacks idempotent. Sanitize stored errors to 500 characters. `listDueDeliveries` returns `pending` plus elapsed `retry_wait`, ordered by next attempt/creation, maximum 200.

- [ ] **Step 5: Run focused and full repository tests**

Run: `bun test tests/conversationMigrations.test.ts tests/conversationRepository.test.ts && bun run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hub/conversations tests/conversationRepository.test.ts tests/conversationMigrations.test.ts
git commit -m "feat(conversations): persist transport deliveries"
```

---

### Task 3: Canonical Turn Coordinator

**Files:**
- Create: `hub/conversations/turnCoordinator.ts`
- Modify: `hub/conversations/index.ts`
- Modify: `hub/conversations/service.ts`
- Create: `tests/turnCoordinator.test.ts`

**Interfaces:**
- Consumes `ConversationService`, `ConversationRepository`, `Dispatcher`, `ConversationEventStream`, and `SurfaceRouter` through focused injected interfaces.
- Produces `submitWebTurn`, `acceptSurfaceEvent`, and `acceptAgentReply`.

- [ ] **Step 1: Write failing coordinator tests**

Prove web input is persisted before dispatch, surface input is deduplicated before dispatch, primary agent receives `conversationId` as `chatId`, agent text is persisted before delivery, duplicate agent callbacks do not duplicate output, and dispatch failure leaves a committed user message with a failed turn event.

- [ ] **Step 2: Run test and verify failure**

Run: `bun test tests/turnCoordinator.test.ts`

Expected: missing coordinator module.

- [ ] **Step 3: Define coordinator input boundary**

```ts
export interface TurnDispatcher {
  dispatch(agent: string, conversationId: string, inbound: InboundMessage): boolean
  isAvailable(agent: string): boolean
}
```

`submitWebTurn(identity, conversationId, input)` calls the existing authorized service append, then dispatches only when `inserted` is true. `acceptSurfaceEvent` resolves the link, rejects disabled/outbound-only/notifications-only inbound, records the external receipt and canonical message, then dispatches once. `acceptAgentReply` handles text in Phase 2; card/react/edit remain Discord compatibility paths until later workspace parity.

- [ ] **Step 4: Implement persistence-first orchestration**

Build an `InboundMessage` using `conversationId` for `chatId`, canonical message ID for `messageId`, and adapter-qualified surface identities. Publish `turn_state` events for queued/working/failed. Agent text uses origin `agent`, state `completed`, and creates eligible delivery rows before invoking the router.

- [ ] **Step 5: Run coordinator and conversation tests**

Run: `bun test tests/turnCoordinator.test.ts tests/conversationService.test.ts tests/conversationEvents.test.ts tests/conversationRepository.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hub/conversations tests/turnCoordinator.test.ts
git commit -m "feat(conversations): coordinate canonical agent turns"
```

---

### Task 4: Discord Surface Adapter

**Files:**
- Create: `hub/surfaces/discordAdapter.ts`
- Modify: `hub/gateway.ts`
- Create: `tests/discordAdapter.test.ts`
- Modify: `hub/gateway.test.ts`

**Interfaces:**
- Consumes `Gateway` through a narrow `DiscordGatewayPort`.
- Produces a `SurfaceAdapter` named `discord`.

- [ ] **Step 1: Write failing adapter contract tests**

Verify normalized event IDs/location/message/identity/content, Discord reply IDs, chunked text delivery result, send failure conversion, capability declaration, and start/stop callback registration.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/discordAdapter.test.ts hub/gateway.test.ts`

Expected: missing adapter module.

- [ ] **Step 3: Extract a narrow gateway port**

Add `Gateway.stop(): Promise<void>` using `client.destroy()`. Change inbound registration so the adapter owns normalization callbacks without moving Discord parsing into the core. Add a send method returning the external Discord message ID; preserve current `sendReply`, cards, interactions, reactions and thread callbacks for compatibility.

- [ ] **Step 4: Implement adapter**

`DiscordAdapter.start` registers the normalized callback then logs in. `send` translates canonical author/content/reply metadata to Discord text and returns the posted message ID. It never reads repositories or agent configuration.

- [ ] **Step 5: Run adapter and gateway tests**

Run: `bun test tests/discordAdapter.test.ts hub/gateway.test.ts tests/gateway-helpers.test.ts && bun run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hub/surfaces/discordAdapter.ts hub/gateway.ts tests/discordAdapter.test.ts hub/gateway.test.ts
git commit -m "feat(discord): implement surface adapter"
```

---

### Task 5: Optional Discord Startup and Web Agent Turns

**Files:**
- Modify: `hub/types.ts`
- Modify: `hub/config.ts`
- Modify: `hub/index.ts`
- Modify: `config/hub.config.json`
- Modify: `docs/config-reference.md`
- Create: `tests/discordOptional.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/conversationWeb.test.ts`

**Interfaces:**
- Produces `discord?: { enabled?: boolean }`, defaulting to enabled for backward compatibility.
- Wires web message POST to `TurnCoordinator.submitWebTurn`.

- [ ] **Step 1: Write optional-start and web-turn tests**

Test configuration defaults Discord to enabled, explicit false requires no token or login, canonical APIs remain live, a web message reaches the selected primary agent, and its reply persists/streams with no surface links.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/discordOptional.test.ts tests/config.test.ts tests/conversationWeb.test.ts`

Expected: disabled Discord is unsupported.

- [ ] **Step 3: Make Discord composition optional**

Only read `botTokenEnv`, construct/start `DiscordAdapter`, register Discord-only interactions, and resolve Discord roles when enabled. Disabled mode supplies no Discord adapter and a role resolver returning `[]`; it must not call `gateway.client` anywhere during boot or shutdown.

- [ ] **Step 4: Route web turns through the coordinator**

Replace the Phase 1 `appendConversationMessage` dependency implementation with coordinator submission while preserving `{ message, inserted }` HTTP semantics. Agent text replies for canonical conversation IDs return through `acceptAgentReply`, not `gateway.sendReply`.

- [ ] **Step 5: Document configuration and limitation changes**

Document `discord.enabled`, its backward-compatible default, web-only startup, and that cards/interactions remain Discord-specific compatibility behavior in Phase 2.

- [ ] **Step 6: Run focused and full tests**

Run: `bun test tests/discordOptional.test.ts tests/conversationWeb.test.ts tests/config.test.ts && bun run typecheck && bun test`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add hub/index.ts hub/types.ts hub/config.ts config/hub.config.json docs/config-reference.md tests/discordOptional.test.ts tests/config.test.ts tests/conversationWeb.test.ts
git commit -m "feat(hub): support web-only agent conversations"
```

---

### Task 6: Discord Channel Migration and Two-Way Mirroring

**Files:**
- Create: `hub/conversations/channelMigration.ts`
- Modify: `hub/index.ts`
- Create: `tests/transportMirror.test.ts`
- Create: `tests/channelMigration.test.ts`

**Interfaces:**
- Produces `ensureDiscordConversation(event, configuredAgent)` and full two-way mirror behavior.

- [ ] **Step 1: Write migration and mirror tests**

Cover first Discord event creating one canonical conversation plus a `two_way` link, repeated/concurrent first events resolving the same conversation, reliable cached-history import preserving order/author/origin, no invented history, inbound dedupe, web-to-Discord mirror, Discord-to-web event, origin echo suppression, and mixed sync modes.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/channelMigration.test.ts tests/transportMirror.test.ts`

Expected: migration module is missing.

- [ ] **Step 3: Implement race-safe channel mapping**

Resolve `(discord, externalLocationId)` first. If absent, create a canonical conversation titled from adapter metadata or `Discord <channelId>`, choose the existing pinned/bound/default agent, and create the two-way link. On unique conflict, reload and return the winner. External Discord authors become adapter-qualified participants as `external` members.

- [ ] **Step 4: Import only reliable cache entries**

Import cached entries only when author, timestamp and ordering are present. Generate deterministic import idempotency keys from channel, timestamp, role and ordinal. Skip ambiguous entries and record counts in audit; never synthesize unavailable content.

- [ ] **Step 5: Wire canonical mirror pipeline**

Discord normalized events use `acceptSurfaceEvent`. Web and agent canonical messages create Discord deliveries only for eligible links. The originating external message ID is recorded and excluded from echo. Preserve legacy commands/cards/reactions through compatibility routing while ordinary text uses the canonical path.

- [ ] **Step 6: Run integration and legacy regressions**

Run: `bun test tests/channelMigration.test.ts tests/transportMirror.test.ts hub/gateway.test.ts tests/orchestrator.test.ts tests/webServer.test.ts && bun test`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add hub/conversations/channelMigration.ts hub/index.ts tests/channelMigration.test.ts tests/transportMirror.test.ts
git commit -m "feat(discord): migrate channels to canonical conversations"
```

---

### Task 7: Retry Worker, Shutdown and Phase Verification

**Files:**
- Create: `hub/surfaces/deliveryWorker.ts`
- Modify: `hub/shutdown.ts`
- Modify: `hub/index.ts`
- Create: `tests/deliveryWorker.test.ts`
- Modify: `tests/shutdown.test.ts`
- Modify: `docs/architecture/conversations.md`
- Modify: `README.md`

**Interfaces:**
- Produces bounded retry/backoff, graceful adapter shutdown, and Phase 2 operational documentation.

- [ ] **Step 1: Write delivery-worker tests**

Test pending success, retryable failure with bounded exponential backoff and jitter injection, exhaustion, no early retry, concurrent tick exclusion, unknown adapter handling, and one failed delivery not blocking the next.

- [ ] **Step 2: Run test and verify failure**

Run: `bun test tests/deliveryWorker.test.ts`

Expected: worker module missing.

- [ ] **Step 3: Implement worker with injected clock/jitter**

Process at most 100 due deliveries per tick. Backoff is `min(60_000, 1000 * 2 ** (attempts - 1))` plus injected jitter `0..250`. Default maximum attempts is 5. A tick already running makes the next tick a no-op. Persist every outcome.

- [ ] **Step 4: Extend graceful shutdown**

Stop accepting web work, stop retry timer, await adapter stops, await web stop, then close SQLite. Cleanup remains idempotent under repeated signals.

- [ ] **Step 5: Update docs**

Document the adapter contract, sync modes, optional Discord startup, mapping/import behavior, delivery state/retries, web-only agent path, and deferred rich-card workspace parity.

- [ ] **Step 6: Run Phase 2 completion gate**

Run: `git diff --check && bun run typecheck && bun test`

Expected: zero whitespace errors, typecheck exit 0, all tests pass.

Run two smoke scenarios with temporary state: web-only boot/message/agent reply/restart; Discord-adapter fake inbound/web mirror/dedup without network. Expected: one canonical copy of every message and one delivery per eligible link.

- [ ] **Step 7: Commit**

```bash
git add hub/surfaces/deliveryWorker.ts hub/shutdown.ts hub/index.ts tests/deliveryWorker.test.ts tests/shutdown.test.ts docs/architecture/conversations.md README.md
git commit -m "feat(transports): complete canonical delivery pipeline"
```

---

## Phase 2 Completion Gate

- Discord-disabled hub boot supports durable, agent-backed web conversations.
- Discord ordinary text uses canonical conversations and defaults to two-way mirroring.
- Duplicate Discord events and repeated delivery attempts produce one canonical message and at most one external delivery.
- Every sync mode has integration coverage.
- Adapter failure cannot roll back a message or block another adapter.
- Existing Discord commands, cards, interactions, reactions, threads and regression tests pass.
- Shutdown awaits retry worker, adapters, web server and SQLite in that order.
- `bun run typecheck`, `bun test`, and both Phase 2 smoke scenarios pass.
