# Canonical conversations

The hub owns a transport-neutral conversation domain: it assigns conversation and message IDs, allocates monotonically increasing per-conversation message sequences, enforces participation and roles, persists records, and emits resumable events. Discord and web are surfaces over that canonical history, not separate stores.

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

## Agent and transport pipeline

Web posts are committed before they are dispatched to the conversation's primary agent. Agent text replies are committed once using their callback id, published to web subscribers, and assigned one durable delivery per eligible transport link. This path works when Discord is disabled; no Discord client or token is constructed for a web-only boot.

Surface adapters implement `start(onEvent)`, `stop()`, and `send(delivery)`. `send` returns a `SurfaceDeliveryResult`, including an optional external message id and `retryable` failure classification. Adapter startup is optional. One adapter failure is isolated from other links. Every send first atomically claims its durable delivery row with a 30-second lease; another coordinator or worker cannot send it until that lease expires. Expired leases are recoverable by workers. User, inbound, and agent messages persist their durable rows before opportunistic surface delivery runs as tracked background work. Coordinator ownership-loss is reported without changing the committed turn; workers intentionally swallow only stale-owner/terminal conflicts because another executor owns or completed that row, while unrelated errors remain reportable.

Shutdown first stops web ingress and atomically marks the coordinator closed to new turns. Post-boundary web calls receive `TurnCoordinatorClosingError`, surface callbacks return `null`, and agent callbacks receive a truthy closed result so they cannot fall through to legacy Discord. It then stops the retry worker, drains pre-boundary coordinator tasks, stops adapters/web, and finally closes SQLite.

Links use `two_way`, `inbound_only`, `outbound_only`, or `notifications_only`. Ordinary Discord text on an unmapped channel atomically creates a canonical conversation and default `two_way` link (using a pinned agent before the hub default), then imports attributable cached text with deterministic keys. External event receipts deduplicate inbound events; external-message mappings preserve reply targets and prevent echoes.

Deliveries move through `pending`, `retry_wait`, `delivered`, or `exhausted`. The bounded worker claims at most 100 due rows per tick, runs only one tick at a time, and persists every outcome. Retryable failures use exponential delay from one second, capped at 60 seconds, plus 0–250 ms jitter; five attempts are allowed by default. Non-retryable and missing-target deliveries exhaust immediately. Shutdown stops web ingress, waits for the retry worker, adapters, and web listener in order, then closes SQLite; repeated signals share the same cleanup promise.

This phase mirrors ordinary text and reply relationships. Rich Discord cards, attachments, edits, deletes, interactions, and reactions remain on the legacy Discord compatibility path. Before transcript-like legacy rich output, a canonical conversation id resolves to the first enabled `two_way` or `outbound_only` Discord link ordered by creation time then link id. The legacy APIs represent only one channel/message id, so this deterministic boundary deliberately does not fan out rich operations. Canonical conversations with only disabled, `inbound_only`, `notifications_only`, or non-Discord links decline and report rich output rather than sending the canonical UUID to Discord. Raw legacy Discord channel ids pass through unchanged.

Malformed normalized envelopes are rejected before persistence or dispatch and reported through the hub audit/error boundary. Adapter shutdown currently waits for adapter `stop()` and an active delivery worker tick; an adapter send that never settles can therefore delay shutdown. The current adapter APIs have no cancellation signal, so bounded cancellation remains a documented limitation rather than falsely closing the database beneath active delivery work.

See the [approved standalone web-client and transport architecture](../superpowers/specs/2026-07-12-standalone-web-client-and-transport-architecture-design.md) for the broader design and deferred work.
