# Lane C — canonical cards + web interaction endpoint

Status: built, flag-gated off (`hub.webCards.enabled`).
Depends on: PR #55 (`fix/persist-card-routing`) — **#55 merges first**.
Consumed by: Lane D (web rendering), which renders against the contract below.

## Problem

Cards are the hub's rich UI: `post_card` posts one, `update_card` edits it in place forever
via `correlation_id`. Two gaps stop the web workspace being a peer of Discord:

1. **Cards have no canonical representation.** `TurnCoordinator.acceptAgentReply` only accepts
   `kind: "reply"`, so a card never enters the conversation pipeline. The only web trace is
   `mirrorRichReplyToWeb`, which flattens title+body to a plain text message — buttons, fields
   and footer are lost, and an `update` appends a *second* text message rather than
   expressing "this card is now in state X".
2. **A web click cannot reach the agent.** Only Discord's `interactionCreate` can.

## What is already transport-neutral (verified, not re-derived)

- `CardSpec` / `CardButton` / `CardModal` (`hub/types.ts`) are plain data — no discord.js types.
- The agent-facing frame is text: `interactionFrame` writes
  `[interaction] custom_id=<id> user_id=<id> fields={...}` to stdin. There is no typed Discord
  object past the shim boundary, so **a web click can synthesise a byte-identical frame** and
  neither agent needs any change.

## Design

### 1. Canonical representation: a card-shaped `ConversationEvent` + its own store

**Decision: a `card` `ConversationEvent` with a sidecar store — NOT an extension of `Message`.**

`Message` is an append-only, sequence-ordered utterance with a single `content` string. A card
is neither: it is a *mutable control surface* with structure (fields, buttons, footer) and a
lifetime longer than one turn. Forcing it into `Message` would mean either serialising JSON
into `content` (every existing consumer — search, mirror, delivery worker, Discord fan-out —
would then treat a blob of JSON as message text) or mutating a committed row, which breaks the
sequence contract `ConversationEventStream` replays on.

So a card follows the **attachment precedent** exactly: a typed field on `ConversationEvent`,
plus a hydration route. Unlike attachments, which are live-only and therefore vanish on
navigate-away, cards are **persisted** in their own SQLite sidecar (`webcards.sqlite`, own
migration chain — the `hub/documentsMigrations.ts` pattern) and rehydrated from
`GET /api/conversations/:id/cards`.

It deliberately does **not** reuse #55's `card_locations` table: that store documents itself as
"a CACHE, not a record of truth", TTL-swept, every row droppable at any time. Transcript
content cannot live there.

### 2. Edit-in-place vs. a trail

**Decision: the transcript shows ONE card per `correlationId`, rendering the LATEST state,
anchored at the timestamp of its FIRST appearance. Every prior revision is retained in
storage and shipped in the payload as `history[]`, so nothing is silently destroyed.**

Why latest-in-place rather than a message per edit:

- **Stale buttons are a safety bug, not a cosmetic one.** If revision 1 (`🚀 Fix ready…`
  + an `Approve` button) stayed clickable after revision 3 (`✅ Deployed to live.`), a click
  would re-fire an action whose moment has passed. Only the newest revision may carry live
  buttons — so only one revision may be interactive, and showing a dead card next to a live
  one invites exactly the misclick.
- **A card is a control surface, not an utterance.** `triage` edits one ticket card many times;
  a trail of eight near-identical cards is transcript noise that buries real conversation.
- **Anchoring at first appearance** keeps ordering stable — the card does not leap to the
  bottom of the transcript every time an agent touches it, which would reorder history on
  each edit and is its own kind of silent rewrite.

Why keep `history[]` anyway: "the web shows the latest" must not mean "the hub forgot". The
revision trail is the audit answer to *what did this card say when I approved it* and costs
one extra row per edit. Lane D is free to render it behind a disclosure ("3 earlier states"),
and **must not** render history buttons as clickable.

### 3. Web interaction endpoint

`POST /api/conversations/:id/interactions`. It resolves identity, runs the **existing** gates,
then classifies the click exactly as the Discord path does.

**Identity.** Every gate is keyed on a Discord snowflake; web identity is an email from the
trusted identity header. Rather than write parallel web authorisation rules — the drift that
produced the `onPublish`/`attachMirror` ownership bug — the endpoint maps
email → snowflake via `hub.webCards.identityMap` and then calls the *same* gate functions.
An email with no mapping is **rejected** (`unmapped_identity`, 403). Nothing is hardcoded.

**Gates, in the Discord order** (`hub/cardGate.ts`, extracted from the previously-inline
`index.ts` wiring and now used by *both* callers, so they cannot drift):

1. Base gate — `baseGate.listAllowed().includes(snowflake)`. Universal.
2. `approval:*` → snowflake must be in `hub.approvals.approvers`.
3. `deploy:*` → must equal `hub.deployApproverUserId` exactly (`isDeployAuthorized`).
4. Any `GatedAction` with `approverOnly` → same approver check.
5. Anything else passes to the agent.

**Classification** mirrors `onNotifyButton`: `approval:` resolves hub-side, a matched
`GatedAction` runs hub-side, and only a plain card button synthesises the frame and calls
`sendInteraction` — the same call, so the agent cannot tell web from Discord.

**Modals.** A button carrying a `CardModal` returns `{ status: "modal", modal }` (HTTP 200)
instead of firing, exactly as Discord shows the modal first. The client then submits to the
same endpoint with `fields`, which flow through the identical frame. The gate runs on **both**
the open and the submit — the Discord path gates `showModal` and then gates the submit's route,
and a client that skipped straight to submit must not bypass anything.

## The contract Lane D renders against

### Live SSE event (`GET /api/conversations/:id/events`)

```jsonc
{
  "kind": "card",
  "conversationId": "conv-1",
  "sequence": 1721400000000,   // monotonic clock, like attachment/tool_step — NOT a message sequence
  "ts": 1721400000000,
  "card": { /* CardInfo, below */ }
}
```

Like `attachment` and `tool_step`, a `card` event **never advances a subscriber's message
high-water mark** and is not replayed from message history — hydration is the reload path.

### Hydration (`GET /api/conversations/:id/cards`)

Returns `CardInfo[]`, oldest first. Same objects as the live event's `card`, so a card looks
identical whether it streamed in or was rehydrated. **Keep the two producers in step.**

### `CardInfo`

```ts
interface CardInfo {
  correlationId: string   // stable identity; an edit re-emits the SAME id
  conversationId: string
  agent: string           // authoring agent
  revision: number        // 1 on first post, +1 per edit
  createdAt: number       // epoch ms of the FIRST post — the transcript anchor, never changes
  updatedAt: number       // epoch ms of this revision
  card: CardSpec          // current state: { title, body, fields?, buttons, footer? }
  history?: CardRevision[] // prior states, oldest first; absent when revision === 1
}
interface CardRevision { revision: number; card: CardSpec; updatedAt: number }
```

`CardSpec.buttons[]` entries carry `customId`, `label`, optional `style`/`emoji`, and optional
`modal`. **A button with `modal` set must open a form, not post immediately.**

Rendering rules Lane D must honour:
- Anchor by `createdAt`; replace in place on a re-emit with the same `correlationId`.
- Only `card.buttons` are interactive. `history[].card.buttons` are inert.
- A card with `buttons: []` is terminal — render it with no controls.

### Interaction request

```
POST /api/conversations/:id/interactions
{ "customId": "deploy:go:481", "fields": { "note": "…" } }   // fields optional
```

### Interaction responses

| status | HTTP | meaning |
|---|---|---|
| `{ status: "ok" }` | 200 | delivered to the agent (frame sent) |
| `{ status: "modal", modal: CardModal }` | 200 | open this form, then re-POST with `fields` |
| `{ status: "handled", action: "approval" \| "gated" }` | 200 | ran hub-side, no agent involved |
| `{ error: "unmapped_identity" }` | 403 | caller's email has no snowflake mapping |
| `{ error: "not_allowlisted" }` | 403 | mapped, but not on the base allowlist |
| `{ error: "forbidden_action" }` | 403 | mapped + allowlisted, but failed the per-namespace gate |
| `{ error: "unroutable", reason }` | 409 | no owning agent / agent gone (#55's legible reasons) |
| `{ error: "web_cards_disabled" }` | 503 | flag off |

## Flag

`hub.webCards.enabled`, default **false**. Off ⇒ no store is opened, no `card` event is ever
published, the hydration and interaction routes return 503, and the surfaces capability stays
`false` — byte-identical to today. Discord delivery is untouched in both states: the emit is
strictly additive alongside the existing `cardLifecycle.onCard` / `onUpdate` calls.

## Capability

`SurfaceCapabilities.cards` stays `false` on `DiscordAdapter` (that adapter still cannot
*render* a canonical card — it posts via the legacy card path), and the web surface reports
`cards: true` only when the flag is on. The capability now reflects reality rather than being
a permanently-false placeholder.
