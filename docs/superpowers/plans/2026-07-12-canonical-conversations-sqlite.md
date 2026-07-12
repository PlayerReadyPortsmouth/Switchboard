# Canonical Conversations and SQLite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, transport-neutral conversations, participants, ordered messages, external links and receipts, role enforcement, resumable events, and authenticated HTTP APIs without changing existing Discord runtime behavior.

**Architecture:** A focused `hub/conversations/` module owns domain types, SQLite migrations, repositories, authorization, and events. `hub/webServer.ts` exposes this module through injected dependencies, preserving its current testable request-router pattern. Phase 1 does not route agent turns or migrate Discord; it establishes the stable domain/API boundary those later changes consume.

**Tech Stack:** Bun 1.x, TypeScript 5.4+, `bun:sqlite`, Bun test, existing Bun HTTP server and SSE implementation.

## Global Constraints

- SQLite database path defaults exactly to `<stateDir>/switchboard.sqlite`.
- Canonical IDs and APIs use `conversationId`, never a Discord channel ID.
- Canonical message content is persisted before an event is published.
- Message sequence numbers are monotonic within a conversation.
- Duplicate client idempotency keys and duplicate external event IDs return the existing message.
- Trusted identity continues to come from the existing `WebDeps.requireUser` boundary.
- Existing Discord, dashboard, configuration, approval, and channel APIs remain backward compatible in Phase 1.
- Do not add an ORM or an external runtime dependency.

---

## File Structure

- `hub/conversations/types.ts` — transport-neutral domain and input types only.
- `hub/conversations/migrations.ts` — ordered SQLite DDL migrations and migration runner.
- `hub/conversations/repository.ts` — repository interface and typed repository errors.
- `hub/conversations/sqliteRepository.ts` — all SQL and transaction handling.
- `hub/conversations/service.ts` — authorization and application rules; no SQL or HTTP concerns.
- `hub/conversations/events.ts` — sequenced in-memory subscriptions backed by repository catch-up.
- `hub/conversations/index.ts` — public exports for the module.
- `hub/webServer.ts` — conversation routes and injected dependency surface.
- `hub/index.ts` — composition root: database, repository, service and web dependency wiring.
- `tests/conversationMigrations.test.ts` — schema and upgrade behavior.
- `tests/conversationRepository.test.ts` — persistence, ordering and idempotency.
- `tests/conversationService.test.ts` — role and lifecycle rules.
- `tests/conversationEvents.test.ts` — subscribe and reconnect gap behavior.
- `tests/conversationWeb.test.ts` — HTTP authentication, validation and status codes.

---

### Task 1: Domain Types and SQLite Migrations

**Files:**
- Create: `hub/conversations/types.ts`
- Create: `hub/conversations/migrations.ts`
- Create: `tests/conversationMigrations.test.ts`

**Interfaces:**
- Produces: `Conversation`, `Participant`, `Message`, `TransportLink`, `Delivery`, `ExternalEventReceipt`, `ConversationRole`, `SyncMode`, `MessageOrigin`, `NewConversation`, `AppendMessageInput`.
- Produces: `runConversationMigrations(db: Database): void`.

- [ ] **Step 1: Write the migration test**

```ts
import { Database } from "bun:sqlite"
import { test, expect } from "bun:test"
import { runConversationMigrations } from "../hub/conversations/migrations"

test("creates the canonical conversation schema idempotently", () => {
  const db = new Database(":memory:")
  runConversationMigrations(db)
  runConversationMigrations(db)
  const names = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map((row) => row.name)
  expect(names).toEqual(expect.arrayContaining([
    "conversations", "participants", "messages", "transport_links",
    "deliveries", "external_event_receipts", "conversation_schema_migrations",
  ]))
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1)
})
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `bun test tests/conversationMigrations.test.ts`

Expected: FAIL with `Cannot find module '../hub/conversations/migrations'`.

- [ ] **Step 3: Define the domain types**

Create `hub/conversations/types.ts` with these exact public shapes:

```ts
export type ConversationRole = "owner" | "member" | "viewer"
export type ParticipantKind = "user" | "agent" | "external"
export type SyncMode = "two_way" | "inbound_only" | "outbound_only" | "notifications_only"
export type MessageOrigin = "web" | "agent" | "transport" | "system"
export type MessageState = "committed" | "queued" | "working" | "streaming" | "completed" | "failed"
export type DeliveryState = "pending" | "delivered" | "retry_wait" | "exhausted"

export interface Conversation { id: string; title: string; primaryAgent: string; createdBy: string; createdAt: number; updatedAt: number; archivedAt: number | null }
export interface Participant { conversationId: string; identity: string; kind: ParticipantKind; role: ConversationRole; createdAt: number }
export interface Message { id: string; conversationId: string; sequence: number; author: string; origin: MessageOrigin; content: string; replyTo: string | null; state: MessageState; clientKey: string | null; createdAt: number }
export interface TransportLink { id: string; conversationId: string; adapter: string; externalLocationId: string; label: string | null; syncMode: SyncMode; enabled: boolean; createdAt: number; updatedAt: number }
export interface Delivery { id: string; messageId: string; linkId: string; eventKind: string; state: DeliveryState; attempts: number; nextAttemptAt: number | null; externalMessageId: string | null; error: string | null; createdAt: number; updatedAt: number }
export interface ExternalEventReceipt { adapter: string; externalEventId: string; messageId: string; receivedAt: number }
export interface NewConversation { id: string; title: string; primaryAgent: string; createdBy: string; createdAt: number }
export interface AppendMessageInput { id: string; conversationId: string; author: string; origin: MessageOrigin; content: string; replyTo?: string; state?: MessageState; clientKey?: string; createdAt: number }
```

- [ ] **Step 4: Implement migration version 1**

Create `hub/conversations/migrations.ts`. Enable `foreign_keys`, `journal_mode=WAL` for file databases, and `busy_timeout=5000`. In one transaction, create the seven tables tested above with foreign keys and these uniqueness rules:

```sql
UNIQUE(conversation_id, sequence)
UNIQUE(conversation_id, client_key)
UNIQUE(adapter, external_location_id)
UNIQUE(message_id, link_id, event_kind)
PRIMARY KEY(adapter, external_event_id)
```

Store migration `1` in `conversation_schema_migrations(version, applied_at)` and set `PRAGMA user_version = 1`. Use `db.transaction(() => { ... })()` and skip versions already present.

- [ ] **Step 5: Run migration tests and typecheck**

Run: `bun test tests/conversationMigrations.test.ts && bun run typecheck`

Expected: migration test passes and TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add hub/conversations/types.ts hub/conversations/migrations.ts tests/conversationMigrations.test.ts
git commit -m "feat(conversations): add canonical schema"
```

---

### Task 2: SQLite Repository

**Files:**
- Create: `hub/conversations/repository.ts`
- Create: `hub/conversations/sqliteRepository.ts`
- Create: `tests/conversationRepository.test.ts`

**Interfaces:**
- Consumes: domain types and `runConversationMigrations` from Task 1.
- Produces: `ConversationRepository` and `SqliteConversationRepository`.
- Produces exact methods: `createConversation`, `getConversation`, `listConversations`, `archiveConversation`, `addParticipant`, `getParticipant`, `appendMessage`, `getMessage`, `listMessages`, `createTransportLink`, `listTransportLinks`, and `recordExternalMessage`.

- [ ] **Step 1: Write repository behavior tests**

```ts
import { Database } from "bun:sqlite"
import { test, expect } from "bun:test"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"

const makeRepo = () => new SqliteConversationRepository(new Database(":memory:"))

test("assigns ordered message sequences and returns a duplicate client key once", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Plan", primaryAgent: "architect", createdBy: "a@example.com", createdAt: 10 })
  const first = repo.appendMessage({ id: "m1", conversationId: "c1", author: "a@example.com", origin: "web", content: "one", clientKey: "k1", createdAt: 11 })
  const duplicate = repo.appendMessage({ id: "m2", conversationId: "c1", author: "a@example.com", origin: "web", content: "one", clientKey: "k1", createdAt: 12 })
  const second = repo.appendMessage({ id: "m3", conversationId: "c1", author: "a@example.com", origin: "web", content: "two", clientKey: "k2", createdAt: 13 })
  expect([first.sequence, duplicate.id, second.sequence]).toEqual([1, "m1", 2])
})

test("deduplicates an external event and returns its canonical message", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Mirror", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const input = { id: "m1", conversationId: "c1", author: "discord:u1", origin: "transport" as const, content: "hello", createdAt: 11 }
  expect(repo.recordExternalMessage("discord", "evt-1", input).id).toBe("m1")
  expect(repo.recordExternalMessage("discord", "evt-1", { ...input, id: "m2" }).id).toBe("m1")
})
```

- [ ] **Step 2: Run tests and verify repository modules are missing**

Run: `bun test tests/conversationRepository.test.ts`

Expected: FAIL with missing repository module.

- [ ] **Step 3: Define the repository contract**

In `hub/conversations/repository.ts`, define the methods listed in Interfaces with concrete return types. Use:

```ts
listConversations(identity: string, includeArchived?: boolean): Conversation[]
listMessages(conversationId: string, afterSequence?: number, limit?: number): Message[]
createTransportLink(input: Omit<TransportLink, "createdAt" | "updatedAt">, now: number): TransportLink
recordExternalMessage(adapter: string, externalEventId: string, input: AppendMessageInput): Message
```

Add `RepositoryConflictError` and `RepositoryNotFoundError`, each extending `Error`.

- [ ] **Step 4: Implement SQL mapping and transactions**

In `SqliteConversationRepository`, call `runConversationMigrations` in the constructor. Keep row-to-domain mapping in private functions. Implement `appendMessage` inside an immediate transaction:

1. Return the existing row when `clientKey` is present and already exists for the conversation.
2. Verify the conversation exists and is not archived.
3. Compute `COALESCE(MAX(sequence), 0) + 1` inside the transaction.
4. Insert the message and update `conversations.updated_at`.
5. Return the inserted row.

Implement `recordExternalMessage` in one transaction that first checks `(adapter, external_event_id)`, otherwise appends the message and inserts the receipt. Convert unique constraint failures for links into `RepositoryConflictError`.

- [ ] **Step 5: Expand repository tests**

Add tests proving participant lookup, owner-visible listing, archive exclusion, pagination after a sequence, default `two_way` link persistence, duplicate external-location rejection, and foreign-key rejection. Use a fresh in-memory database per test.

- [ ] **Step 6: Run focused and full tests**

Run: `bun test tests/conversationRepository.test.ts tests/conversationMigrations.test.ts && bun test`

Expected: focused tests pass and the full existing suite has zero failures.

- [ ] **Step 7: Commit**

```bash
git add hub/conversations/repository.ts hub/conversations/sqliteRepository.ts tests/conversationRepository.test.ts
git commit -m "feat(conversations): add sqlite repository"
```

---

### Task 3: Authorized Conversation Service

**Files:**
- Create: `hub/conversations/service.ts`
- Create: `tests/conversationService.test.ts`

**Interfaces:**
- Consumes: `ConversationRepository` from Task 2.
- Produces: `ConversationService`, `ConversationForbiddenError`, `ConversationValidationError`.
- Produces exact methods: `create`, `list`, `get`, `archive`, `appendUserMessage`, `history`, `addTransportLink`, and `listTransportLinks`.

- [ ] **Step 1: Write failing role tests**

```ts
test("owner can write and viewer can only read", () => {
  const { service, repo } = fixture()
  const c = service.create("owner@example.com", { title: "Design", primaryAgent: "architect" })
  repo.addParticipant({ conversationId: c.id, identity: "viewer@example.com", kind: "user", role: "viewer", createdAt: 2 })
  expect(service.history("viewer@example.com", c.id)).toEqual([])
  expect(() => service.appendUserMessage("viewer@example.com", c.id, { content: "no", clientKey: "v1" })).toThrow(ConversationForbiddenError)
  expect(service.appendUserMessage("owner@example.com", c.id, { content: "yes", clientKey: "o1" }).sequence).toBe(1)
})
```

The `fixture()` uses an in-memory `SqliteConversationRepository` and injects deterministic `now()` and `id()` functions.

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/conversationService.test.ts`

Expected: FAIL with missing `ConversationService`.

- [ ] **Step 3: Implement service dependencies and validation**

Use this constructor:

```ts
constructor(
  private repo: ConversationRepository,
  private now: () => number,
  private id: () => string,
) {}
```

`create` trims the title, verifies non-empty title and primary agent, creates the conversation, and adds the creator as an owner in one repository-level creation transaction. Extend the repository with `createConversationWithOwner(input, owner)` rather than allowing a partially created conversation.

`appendUserMessage` accepts `{ content: string; clientKey: string; replyTo?: string }`, rejects blank content and absent client keys, permits owner/member, and writes origin `web`, author equal to the trusted identity, state `committed`.

`history` permits owner/member/viewer. `archive` and `addTransportLink` require owner. A new link defaults to `two_way` when the caller omits `syncMode`.

- [ ] **Step 4: Add lifecycle and validation tests**

Cover unknown conversation, non-participant, member write, viewer read, owner archive, post-archive write rejection, blank titles, blank messages, default link mode, and owner-only link creation.

- [ ] **Step 5: Run service, repository and type tests**

Run: `bun test tests/conversationService.test.ts tests/conversationRepository.test.ts && bun run typecheck`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add hub/conversations/service.ts hub/conversations/repository.ts hub/conversations/sqliteRepository.ts tests/conversationService.test.ts tests/conversationRepository.test.ts
git commit -m "feat(conversations): add authorized service"
```

---

### Task 4: Sequenced Conversation Events

**Files:**
- Create: `hub/conversations/events.ts`
- Create: `tests/conversationEvents.test.ts`
- Modify: `hub/conversations/service.ts`

**Interfaces:**
- Consumes: committed `Message` records from Task 3.
- Produces: `ConversationEvent`, `ConversationEventStream.publish`, `ConversationEventStream.subscribe`.

- [ ] **Step 1: Write the reconnect-gap test**

```ts
test("subscribe replays committed messages after the requested sequence then streams new ones", () => {
  const history = [message(1), message(2)]
  const stream = new ConversationEventStream((conversationId, after) => history.filter((m) => m.conversationId === conversationId && m.sequence > after))
  const seen: number[] = []
  const stop = stream.subscribe("c1", 1, (event) => seen.push(event.sequence))
  stream.publish({ kind: "message_committed", conversationId: "c1", sequence: 3, ts: 30, message: message(3) })
  stop()
  expect(seen).toEqual([2, 3])
})
```

- [ ] **Step 2: Run test and verify failure**

Run: `bun test tests/conversationEvents.test.ts`

Expected: FAIL with missing events module.

- [ ] **Step 3: Implement event stream**

Define:

```ts
export interface ConversationEvent {
  kind: "message_committed" | "turn_state" | "activity"
  conversationId: string
  sequence: number
  ts: number
  message?: Message
  state?: MessageState
  detail?: Record<string, unknown>
}
```

`subscribe(conversationId, afterSequence, callback)` must register the live subscriber before replaying repository history, suppress any live event whose sequence was included in replay, and return an unsubscribe function. Use a per-subscription high-water mark.

- [ ] **Step 4: Publish only after service persistence**

Inject the stream into `ConversationService`. Immediately after `repo.appendMessage` returns, publish `message_committed` using the returned message sequence. Do not publish when the idempotency key returned an already-existing message; compare by an added repository result `{ message, inserted }` so this decision is explicit.

- [ ] **Step 5: Run event, service and repository tests**

Run: `bun test tests/conversationEvents.test.ts tests/conversationService.test.ts tests/conversationRepository.test.ts`

Expected: all pass, including a new test that a duplicate client key emits once.

- [ ] **Step 6: Commit**

```bash
git add hub/conversations/events.ts hub/conversations/service.ts hub/conversations/repository.ts hub/conversations/sqliteRepository.ts tests/conversationEvents.test.ts tests/conversationService.test.ts tests/conversationRepository.test.ts
git commit -m "feat(conversations): publish resumable events"
```

---

### Task 5: Conversation HTTP and SSE API

**Files:**
- Modify: `hub/webServer.ts`
- Create: `tests/conversationWeb.test.ts`

**Interfaces:**
- Consumes: service operations from Tasks 3–4 through injected `WebDeps` functions.
- Produces routes: `GET/POST /api/conversations`, `GET/DELETE /api/conversations/:id`, `GET/POST /api/conversations/:id/messages`, `GET /api/conversations/:id/events`, `GET/POST /api/conversations/:id/links`.

- [ ] **Step 1: Write failing API tests**

```ts
test("conversation routes require identity and create a conversation", async () => {
  const deps = conversationDeps()
  const missing = await handleWebRequest(new Request("http://x/api/conversations"), deps)
  expect(missing.status).toBe(400)
  const created = await handleWebRequest(new Request("http://x/api/conversations", {
    method: "POST", headers: { "X-Switchboard-User": "owner@example.com", "content-type": "application/json" },
    body: JSON.stringify({ title: "Design", primaryAgent: "architect" }),
  }), deps)
  expect(created.status).toBe(201)
  expect((await created.json()).title).toBe("Design")
})
```

Add a test that posting the same `Idempotency-Key` twice returns the same message ID and status `200` on the duplicate versus `201` on insertion.

- [ ] **Step 2: Run tests and verify 404 responses**

Run: `bun test tests/conversationWeb.test.ts`

Expected: FAIL because `/api/conversations` returns 404.

- [ ] **Step 3: Extend `WebDeps` with transport-neutral functions**

Add exact dependency signatures mirroring the service methods. Keep domain objects as return types. Add `subscribeConversation(conversationId, afterSequence, cb)` where callback receives `ConversationEvent`.

- [ ] **Step 4: Implement route parsing and status mapping**

All new routes are guarded by `requireUser`. Parse IDs with `decodeURIComponent`. Enforce:

- `201` for newly created conversations, messages, and links.
- `200` for reads and idempotent duplicate messages.
- `400` for invalid JSON, missing fields, or validation errors.
- `403` for `ConversationForbiddenError`.
- `404` for `RepositoryNotFoundError`.
- `409` for repository conflicts.

For events, parse `after` as a non-negative integer and return SSE frames with both fields:

```text
id: <sequence>
data: <serialized ConversationEvent>

```

Also accept `Last-Event-ID` when `after` is absent.

- [ ] **Step 5: Add wrong-method, authorization and SSE tests**

Verify authenticated wrong methods return `405`, non-members return `403`, malformed `after` returns `400`, an SSE subscriber receives an `id:` field, and all existing web route tests retain their current status behavior.

- [ ] **Step 6: Run web tests and full suite**

Run: `bun test tests/conversationWeb.test.ts tests/webServer.test.ts tests/web.test.ts && bun test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add hub/webServer.ts tests/conversationWeb.test.ts
git commit -m "feat(web): add conversation api"
```

---

### Task 6: Composition-Root Wiring and Configuration

**Files:**
- Create: `hub/conversations/index.ts`
- Modify: `hub/index.ts`
- Modify: `hub/types.ts`
- Modify: `hub/config.ts`
- Modify: `docs/config-reference.md`
- Test: `tests/config.test.ts`
- Test: `tests/conversationWeb.test.ts`

**Interfaces:**
- Consumes: all Phase 1 conversation module interfaces.
- Produces: a live database at `hub.conversationDbFile ?? join(hub.stateDir, "switchboard.sqlite")` and fully wired `WebDeps` conversation operations.

- [ ] **Step 1: Add the configuration default test**

Add an assertion to `tests/config.test.ts` that an omitted `conversationDbFile` remains undefined after parsing, because the composition root owns the `<stateDir>/switchboard.sqlite` default. Add a parsing test that `conversationDbFile: "~/custom.sqlite"` is expanded to the user's home directory.

- [ ] **Step 2: Run config tests and verify the new property is unsupported**

Run: `bun test tests/config.test.ts`

Expected: FAIL at compile time because `HubConfig.conversationDbFile` does not exist.

- [ ] **Step 3: Add configuration and public exports**

Add `conversationDbFile?: string` to `HubConfig` beside `stateDir`. Expand it in `hub/config.ts` when present. Export public conversation module types and classes from `hub/conversations/index.ts`.

- [ ] **Step 4: Wire database and service before web server construction**

In `hub/index.ts`, create:

```ts
const conversationDb = new Database(hub.conversationDbFile ?? join(hub.stateDir, "switchboard.sqlite"), { create: true })
const conversationRepo = new SqliteConversationRepository(conversationDb)
const conversationEvents = new ConversationEventStream((id, after) => conversationRepo.listMessages(id, after, 500))
const conversationService = new ConversationService(conversationRepo, () => Date.now(), () => crypto.randomUUID(), conversationEvents)
```

Wire every Task 5 dependency to the service. On shutdown, unsubscribe clients through server cancellation and call `conversationDb.close()` after stopping the web server.

- [ ] **Step 5: Document configuration and backup behavior**

In `docs/config-reference.md`, document `conversationDbFile`, its exact default, the trusted-header deployment requirement, and that a consistent backup must include the SQLite database plus `-wal` while the hub is running or use SQLite's backup command.

- [ ] **Step 6: Add a file-database integration test**

Use `mkdtempSync` to start a real `SqliteConversationRepository`, create a conversation and message, close the database, reopen it, and assert both remain. Clean up only the test-created temp directory in `afterEach`.

- [ ] **Step 7: Run verification**

Run: `bun test tests/config.test.ts tests/conversationWeb.test.ts tests/conversationRepository.test.ts && bun run typecheck && bun test`

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add hub/conversations/index.ts hub/index.ts hub/types.ts hub/config.ts docs/config-reference.md tests/config.test.ts tests/conversationWeb.test.ts tests/conversationRepository.test.ts
git commit -m "feat(hub): wire canonical conversations"
```

---

### Task 7: Phase Verification and Phase 2 Contract Notes

**Files:**
- Create: `docs/architecture/conversations.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed Phase 1 behavior.
- Produces: operator/developer documentation and the exact stable boundary Phase 2 will build upon.

- [ ] **Step 1: Write architecture documentation**

Document domain ownership, database location, repository/service layering, identity trust boundary, HTTP routes, SSE resume semantics, and the explicit Phase 1 limitation: messages are stored and streamed but are not yet submitted to agents or mirrored until Phase 2.

- [ ] **Step 2: Add a README entry point**

Link `docs/architecture/conversations.md` and the approved design from the README's web/dashboard documentation. State that the legacy channel chat remains the active agent path until Phase 2.

- [ ] **Step 3: Run the complete verification gate**

Run: `git diff --check && bun run typecheck && bun test`

Expected: no whitespace errors, TypeScript exits 0, and all tests pass with zero failures.

- [ ] **Step 4: Inspect the database smoke path**

Run the hub with a temporary state directory and web port, create a conversation through `POST /api/conversations` with the configured identity header, post a message with `Idempotency-Key`, restart the hub, then fetch message history. Expected: the same conversation and one message survive restart. Stop the temporary hub and retain no process.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/conversations.md README.md
git commit -m "docs: document canonical conversations"
```

---

## Phase 1 Completion Gate

Phase 1 is complete only when:

- `bun run typecheck` exits 0.
- `bun test` has zero failures.
- A web-only canonical conversation and message survive a real hub restart.
- Duplicate web idempotency keys and external event IDs produce one canonical message.
- Owner/member/viewer authorization is enforced by service and HTTP tests.
- SSE reconnect from a sequence returns the exact missing events once.
- Existing Discord and legacy dashboard tests remain unchanged and passing.
- The known limitation that Phase 1 does not yet run agent turns is documented.

After this gate, write the Phase 2 plan against the merged public interfaces rather than predicting gateway changes before the contracts exist.
