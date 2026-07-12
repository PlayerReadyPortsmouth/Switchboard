# Canonical conversations

Phase 1 introduces a transport-neutral conversation domain for the web client and future adapters. The hub owns this domain: it assigns conversation and message IDs, allocates monotonically increasing per-conversation message sequences, enforces participation and roles, persists records, and emits resumable events. Discord channel history and the legacy dashboard channel chat are not canonical conversation storage.

## Storage and ownership

The hub opens one SQLite database at `hub.conversationDbFile` when configured, otherwise at `<stateDir>/switchboard.sqlite`. Migrations run when `SqliteConversationRepository` is constructed. The schema contains conversations, participants, messages, transport links, deliveries, and external-event receipts.

The uniqueness constraints are part of the public persistence contract:

- `(conversation_id, sequence)` orders messages within a conversation.
- `(conversation_id, client_key)` makes web submission idempotent.
- `(adapter, external_event_id)` makes transport ingestion idempotent.
- `(adapter, external_location_id)` allows an external location to belong to only one canonical conversation.

`ConversationRepository` is the storage boundary. `SqliteConversationRepository` is the Phase 1 implementation; callers should depend on the interface rather than SQLite details. `ConversationService` is the application boundary above it. It validates inputs, checks authorization, creates owners atomically with conversations, and publishes events only after a new message is committed. HTTP handlers call the service and do not access the repository directly.

## Identity and authorization

All conversation API routes trust the `X-Switchboard-User` request header as the caller identity. Switchboard does not authenticate that value. A trusted reverse proxy or hosting layer must authenticate the user, remove any client-supplied copy of the header, and set the verified identity before forwarding the request. Do not expose these routes directly to untrusted clients.

Authorization is enforced again in `ConversationService`:

- owners can read, post messages, archive, and manage transport links;
- members can read and post messages;
- viewers can read only;
- identities with no participant record cannot access the conversation.

The conversation creator is stored as an owner participant in the same transaction as creation.

## HTTP contract

All IDs in route paths are URL encoded. JSON routes return `400` for invalid input or missing identity, `403` for insufficient participation or role, `404` for a missing conversation, and `409` for uniqueness conflicts.

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/conversations?includeArchived=false` | List conversations visible to the caller. |
| `POST` | `/api/conversations` | Create a conversation from `{ title, primaryAgent }`; caller becomes owner. |
| `GET` | `/api/conversations/:id` | Fetch one visible conversation. |
| `DELETE` | `/api/conversations/:id` | Archive a conversation; owner only. |
| `GET` | `/api/conversations/:id/messages?after=0&limit=100` | Fetch messages after a sequence. `limit` must be 1–200. |
| `POST` | `/api/conversations/:id/messages` | Commit `{ content, replyTo? }`; owner/member only. Supply `Idempotency-Key` (a `clientKey` body field is also accepted). A new message returns `201`; a duplicate key returns the original message with `200`. |
| `GET` | `/api/conversations/:id/events?after=<sequence>` | Subscribe to resumable server-sent events. |
| `GET` | `/api/conversations/:id/links` | List transport links. |
| `POST` | `/api/conversations/:id/links` | Add a transport link; owner only. Adapter and external-location IDs are trimmed and must be nonblank. |

## SSE resume semantics

Conversation events use the message sequence as the SSE `id`. A subscriber supplies either the `after` query parameter or `Last-Event-ID`; `after` takes precedence. The cursor is exclusive: reconnecting after sequence `N` replays persisted messages with sequence greater than `N`, in sequence order, then continues with live events.

The event stream registers the live subscription before reading history and buffers concurrent publications during replay. Persisted catch-up is read in bounded 500-message pages until the complete gap is exhausted. Its high-water mark advances between pages and suppresses overlap with buffered live publications, so a reconnect receives every missing sequence exactly once from this hub process, including gaps larger than one page. SSE is a notification/resume surface, not the source of truth; clients should retain their cursor and can always recover through message history.

## Phase 1 boundary

Phase 1 stores web messages and streams `message_committed` events, but it does **not** submit those messages to an agent and does **not** mirror them through transport links. Transport links, delivery records, message states, and external-event receipts establish the durable boundary that Phase 2 will build on; they are not yet an active gateway pipeline.

Until Phase 2 connects canonical conversations to agent turns and adapters, the dashboard's legacy channel chat remains the active path for sending work to agents. Code that appends a canonical message must not assume an agent run or an external delivery has occurred.

The Phase 1 restart gate exercises the production conversation repository, service, event stream, and HTTP handler by stopping the listener, closing SQLite, and rebuilding that runtime against the same temporary state. It intentionally does not start the Discord-connected `hub/index.ts`: making the full hub bootstrap Discord-optional is deferred to Phase 2.

See the [approved standalone web-client and transport architecture](../superpowers/specs/2026-07-12-standalone-web-client-and-transport-architecture-design.md) for the broader design and deferred work.
