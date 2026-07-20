# Card sync across both surfaces (`hub.webCards` bug fix)

**Status:** built. Bug fix to `hub.webCards`, which is already merged and enabled in prod. No
new flag.

## The bug

`hub.webCards` shipped with exactly ONE path publishing a card canonically: the agent-reply
path (`update_card` → `onAgentReply`'s `kind:"update"` branch → `publishCardToWeb` → `web_cards`
revision N+1 → live `card` event). That path is sound and is unchanged.

Every *other* card mutation edited the Discord message directly and told the web nothing:

| Bypassing edit | What Discord showed | What the web showed |
|---|---|---|
| `gateway.ts` — `interaction.update({components:[buildWorkingRow()]})` on a card button click | ⏳ Working, disabled | the original card, buttons live |
| `gateway.ts` — the same swap on a card modal **submit** | ⏳ Working, disabled | the original card, buttons live |
| `cardLifecycle.runGated`'s `editBody` (`deploy:*` buttons) | pending → ✅/❌ text, no buttons | the original text and buttons, forever |
| `requestApproval` / `resolveApproval` / approval expiry | the approval card, then its terminal state | **nothing at all** — the card never existed on the web |
| `runWorkflow`'s mission progress card | live per-step progress | **nothing at all** |

`gateway.ts`'s `perm:allow|deny` branch also edits content and clears components, but that is
the DM permission prompt, not a card: it has no `correlationId`, no `web_cards` row and no web
surface. It is deliberately left alone.

And nothing went the other way at all: a **web** click produced no in-flight state on Discord,
so the Discord card kept offering a live button for an action that was already running. That is
a genuine double-fire (a `deploy:*` gated action would run its command twice), not a cosmetic
mismatch.

## The fix

`hub/cardSync.ts` is the chokepoint. Two operations, deliberately distinct:

- **`publishState(correlationId, chatId, card)`** — a genuine content change. Mints a revision,
  exactly as the agent path does. Called by `cardLifecycle.runGated` (via the new optional
  `publishCard` dep), by approval request/resolve/expire, and by mission progress edits.
- **`markInFlight` / `release`** — the transient "a click is running" state. Sets
  `CardInfo.inFlight`. **Does not mint a revision.**

### Why "Working" does not mint a revision

It is ephemeral and superseded seconds later by the real outcome, and it carries no content —
minting a revision per click would pad `web_card_revisions` and the card's user-visible history
disclosure with entries that say nothing about what the card ever *said*. But it is still
**persisted**, as an `in_flight_json` column on the card row (migration v2), because a reload
that re-offered a button whose action is already running would be the same double-fire on a
slower path. `record()` clears the column as part of minting the next revision, so the outcome
releases it with no bookkeeping.

The client accepts an equal-revision event only when the marker actually changed
(`advancesInFlight` in `web/client/state.ts`). Revisions still never go backwards.
`setInFlight` bumps `updated_at`, which is what lets the client order a *cleared* state against
a *marked* one at the same revision; a dead tie favours the marked copy, because a card wrongly
shown as busy self-corrects on the next revision while one wrongly shown as clickable is the
bug.

### Web → Discord

A web click edits the Discord message to `workingCard(spec)` — the card's content with its
buttons replaced by the single `WORKING_BUTTON`, which is the same spec `buildWorkingRow()`
renders (a test asserts the two produce identical component data). `CardButton.disabled` was
added to `CardSpec` so one spec expresses "unavailable" on both surfaces.

### Concurrency

`CardSync.begin()` is a compare-and-set claim keyed by `correlationId`. Whichever surface
clicks first takes it; the second is refused with `card_busy` (HTTP 409, "not a permission
problem — someone got there first"). The claim is taken **after** every authorisation check, so
an unauthorised click is still refused for who the clicker is, not told the card is busy.
The store's forward-only revision rule keeps *content* sane under interleaving but cannot stop
a second *execution*; the claim is what does that. A claim expires after
`hub.webCards.claimTtlMs` (default 5 min) so a click whose action never reports back cannot
wedge the card forever.

### Ordering constraints honoured

- Discord's optimistic `interaction.update` is untouched and still the first thing that
  happens; all canonical work runs after the ack, inside the hub's own callbacks.
- Every canonical write degrades rather than throwing (`webCardStore` already swallows storage
  errors; `publishCardInFlight` wraps its own).
- With `hub.webCards` off, `CardSync` takes no claims, publishes nothing and edits nothing —
  byte-identical to before.
