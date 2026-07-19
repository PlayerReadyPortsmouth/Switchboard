# Lane D — rendering agent cards in the web transcript

Status: built. Web-client only; the hub side is Lane C (PR #56) and is unchanged by this work.
Depends on: `feature/web-card-contract` — this branch targets it, not master.
Gated by: `session.features.cards`, which the hub reports true only when `hub.webCards.enabled`
is on. Off ⇒ no hydration fetch, no card rendered, no button offered.

## Problem

Lane C made a card canonical, persisted it, and opened an authenticated interaction endpoint.
Nothing rendered it. The web workspace showed a `triage` ticket as flattened text with its
controls missing, so every quick action still had to happen in Discord.

## What this lane adds

- `CardInfo`/`CardSpec` mirrored into `web/client/types.ts`, plus `features.cards`.
- `WorkspaceApi.listConversationCards` (hydration) and `submitCardInteraction` (clicks).
- A `cards` slice in the reducer, merged by `correlationId`.
- `AgentCard`, `CardModalDialog`, `TranscriptCards` + `anchorCards`, and a CSS block.

## Decisions

### One card per correlationId, replaced in place

The reducer replaces by `correlationId` and **only when the incoming revision is higher**. A
redelivered or out-of-order older revision is dropped. That is a safety property, not a tidiness
one: the Lane C spec's whole argument for latest-in-place is that a superseded revision's
buttons must never be clickable, and a redelivery that overwrote revision 3 with revision 1
would put dead buttons back on screen.

Ordering is by `createdAt`, never `updatedAt`, and an in-place replacement does not re-sort — so
an edit leaves the card exactly where it was in the transcript.

### History: collapsed, and structurally inert

`history[]` is surfaced behind a `<details>`, **collapsed by default**, below the live action
row.

- *Collapsed*, because the current state is the answer. `triage` rewrites one ticket card three
  or four times; expanded by default, the trail would bury the live buttons under superseded
  copies of themselves.
- *Present at all*, because the trail is the audit answer to "what did this card say when I
  clicked Approve", which the hub deliberately retains. Discarding it in the client would make
  the hub's retention pointless.
- *Below the actions*, because an expanded trail is tall and the buttons that still work must
  stay adjacent to the card they belong to.

A superseded button renders as a `<span>`, **never** a disabled `<button>`. The guarantee is
structural rather than attributive: there is no button element, so there is nothing for a click,
an Enter key, a form submit, or a `disabled` attribute a later refactor removes to activate.
`aria-disabled` on a real button would have been a promise; an absent element is a fact. A test
asserts `history.querySelectorAll("button").length === 0`.

### Every documented response is legible, and no button ever sticks

`interactionFailureMessage` is pure and exported so the mapping is tested directly. The three
403s get three different sentences because they call for three different actions from the
reader (get an identity mapped / get allowlisted / stop); `unroutable` is explicitly not framed
as a permission problem, because it is not one. The hub's `reason` is appended sentence-cased.

The pending flag is cleared in a `finally`. Discord's own path had a bug where an unroutable
click froze its button forever, and a frozen control surface is strictly worse than a legible
failure — so every documented failure ends with the card clickable again. Regression-tested per
error code.

Double-submit is blocked by a ref, not by the state, because two clicks in one tick both read
the stale state. Pending is per-card, not per-button: the buttons on a triage card are
alternatives, so while one is in flight none may fire.

### The modal round-trip goes through the hub

A button carrying `modal` still POSTs first, and the form is built from the modal the **hub**
returned. The client does not open the embedded spec directly, because the hub gates the open as
well as the submit — opening locally would let an unauthorised reader fill in a whole form before
being refused. `button.modal` is used only for `aria-haspopup="dialog"`.

A refused submit keeps the dialog open with its text intact; closing it would throw away what
the reader typed in order to tell them it was refused.

### Anchoring reuses the attachment rule

`anchorCards` is `anchorAttachments`' rule verbatim — nearest agent message at or after
`createdAt` — because cards are produced the same way: posted mid-turn over the MCP shim, before
the reply that closes the turn is committed. Anchoring on `createdAt` is what keeps an edited
card under the message where the ticket was raised.

## Mobile

Aurora works `triage` on a phone at ~390px, so the action row is the primary case. Buttons are
44px tall at every width and the row wraps rather than scrolls. `min-width: max-content` in the
mobile block makes the half-column a target rather than a cap: a button whose label will not fit
at 50% takes a row of its own instead of ellipsising — "Need i…" is not a button. Verified at
390px with `document.scrollWidth === clientWidth === 390`.

## Verification

`bun run typecheck` clean. `bun test`: 1477 pass / 5 fail, and the 5 are the documented Windows
`hub/documents.test.ts` baseline — diffed by NAME against a clean-master run, not by count.
`SWITCHBOARD_WEB_BASE=/switchboard bun run build:web` succeeds with `/switchboard/chunk-*.js`.
Driven in Chrome at 1440px and 390px against the built bundle: a four-button triage card, the
`unroutable` and `forbidden_action` failures, the modal round-trip, and an edit-in-place from
revision 1 to revision 3 surviving a navigate-away-and-back.
