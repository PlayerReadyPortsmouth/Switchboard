// hub/cardSync.ts
// One chokepoint for every card mutation, so a card cannot change on one surface without the
// other surface learning about it.
//
// Why this exists: `hub.webCards` shipped with only ONE path publishing canonically — the
// agent-reply path (`update_card` → onAgentReply's "update" branch → publishCardToWeb → a new
// `web_cards` revision → the live `card` event). Every other mutation edited the Discord
// message directly and told the web nothing:
//
//   • gateway's optimistic "⏳ Working" swap on a button click and on a modal submit
//   • cardLifecycle.runGated's pending → success/failure edits (deploy:* buttons), which are
//     entirely hub-side and never reach onAgentReply at all
//   • the approval card: posted and re-rendered on resolution straight through gateway
//   • the mission progress card: re-rendered on every step, same shape
//
// …and nothing at all went the other way: a WEB click left the Discord card sitting there with
// live buttons while its action was already running, so the same action could be fired a
// second time from Discord. That is a double-fire, not a cosmetic mismatch.
//
// Two distinct things travel through here, and keeping them distinct is the whole design:
//
//   publishState() — a genuine CONTENT change. Mints a revision (`web_cards` N+1) exactly as
//                    the agent path does, because the card now says something different.
//
//   markInFlight() — the transient "a click is running" state. Does NOT mint a revision; it
//                    sets `CardInfo.inFlight`. A ⏳ Working row is superseded seconds later and
//                    is not a thing the card ever *said*; minting a revision per click would
//                    pad `web_card_revisions` and the user-visible history trail with entries
//                    that carry no content. It is still PERSISTED (a column on the card row),
//                    so a reload cannot re-offer a button whose action is already running, and
//                    the next real revision clears it automatically.
//
// Concurrency: two surfaces can now act on one card. `begin()` is a compare-and-set claim
// keyed by correlationId — whichever click arrives first takes it and the other is refused
// with a legible reason instead of running the action twice. The store's
// "revisions only move forward" rule already stops a late write from resurrecting old content,
// but it cannot stop a second EXECUTION, which is what the claim is for.
import type { CardInFlight } from "./conversations/events"
import type { CardButton, CardSpec } from "./types"

/** The surface a click arrived on. */
export type CardSurface = "discord" | "web"

/** The single disabled control that represents "handed off, in progress". Rendered from ONE
 *  spec on both surfaces so they cannot drift apart. */
export const WORKING_BUTTON: CardButton = {
  customId: "working:noop", label: "Working", emoji: "⏳", style: "secondary", disabled: true,
}

/** The card as it should look while a click on it is running: same content, controls replaced
 *  by the single disabled Working button. */
export function workingCard(card: CardSpec): CardSpec {
  return { ...card, buttons: [WORKING_BUTTON] }
}

export interface CardSyncDeps {
  /** hub.webCards.enabled. False ⇒ claims are not taken and nothing is published: the hub
   *  behaves exactly as it did before web cards existed, per the house "off = byte-identical"
   *  rule. With no web surface there is no second clicker to race. */
  enabled: boolean
  /** Persist a content revision and publish the live `card` event. Must never throw. */
  publish(correlationId: string, chatId: string, card: CardSpec): void
  /** Set/clear the in-flight marker and publish the resulting state. Must never throw. */
  publishInFlight(correlationId: string, inFlight: CardInFlight | null): void
  /** The card currently rendered for this correlation, if the hub still knows where it is. */
  currentCard(correlationId: string): CardSpec | undefined
  /** Edit the card's Discord message in place. Must never throw. */
  editDiscord(correlationId: string, card: CardSpec): Promise<void>
  now(): number
  /** How long a claim survives with no outcome. A click whose action never reports back must
   *  not wedge the card forever; the Discord card already "simply rests" on Working in that
   *  case, and this is the matching bound on the claim. */
  claimTtlMs?: number
}

const DEFAULT_CLAIM_TTL_MS = 5 * 60_000

/** Refusal text for a click that lost the race. Deliberately not a permission message — the
 *  clicker WAS authorised; someone else simply got there first. */
export const BUSY_REASON = "This card is already handling an action."

export class CardSync {
  private claims = new Map<string, CardInFlight>()

  constructor(private deps: CardSyncDeps) {}

  private get ttl(): number { return this.deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS }

  /** Claim this card for one in-flight action.
   *
   *  `false` ⇒ another surface is already running something on it; the caller must refuse
   *  rather than dispatch. An unknown correlation (a button the hub cannot tie to a card) is
   *  always allowed through: there is nothing to serialise on, and refusing would break clicks
   *  that work today. */
  begin(correlationId: string | undefined, surface: CardSurface, customId: string): boolean {
    if (!this.deps.enabled || !correlationId) return true
    const held = this.claims.get(correlationId)
    if (held && this.deps.now() - held.at < this.ttl) return false
    this.claims.set(correlationId, { surface, customId, at: this.deps.now() })
    return true
  }

  /** Reflect an accepted click onto both surfaces.
   *
   *  Discord-originated: the gateway has ALREADY swapped in its Working row inside the
   *  interaction ack (that must stay immediate — Discord gives it three seconds), so only the
   *  web needs telling. Web-originated: the web client shows its own pending state, and Discord
   *  is the surface that would otherwise still be offering the button, so it gets the edit. */
  markInFlight(correlationId: string | undefined, surface: CardSurface, customId: string): void {
    if (!this.deps.enabled || !correlationId) return
    const inFlight = this.claims.get(correlationId) ?? { surface, customId, at: this.deps.now() }
    this.deps.publishInFlight(correlationId, inFlight)
    if (surface !== "web") return
    const current = this.deps.currentCard(correlationId)
    if (!current) return
    // After the web response, never in front of it: a Discord API round trip must not sit
    // between the clicker and their answer.
    void this.deps.editDiscord(correlationId, workingCard(current))
  }

  /** A click that was accepted but could not be delivered (or was refused downstream). The
   *  action never ran, so the card must become clickable again on both surfaces rather than
   *  strand on Working — the frozen-button bug, in its two-surface form. */
  release(correlationId: string | undefined): void {
    if (!this.deps.enabled || !correlationId) return
    this.claims.delete(correlationId)
    this.deps.publishInFlight(correlationId, null)
    const current = this.deps.currentCard(correlationId)
    if (current) void this.deps.editDiscord(correlationId, current)
  }

  /** A genuine content change: publish it canonically so the web sees revision N+1, and drop
   *  any claim — this edit IS the outcome the claim was waiting for.
   *
   *  Every hub-side card mutation calls this. It is safe to call for content that is already
   *  stored: the store treats an unchanged repost as a delivery retry and burns no revision. */
  publishState(correlationId: string | undefined, chatId: string, card: CardSpec): void {
    if (!correlationId) return
    this.claims.delete(correlationId)
    if (!this.deps.enabled) return
    this.deps.publish(correlationId, chatId, card)
  }

  /** Drop a claim without touching either surface — for a card whose state is about to be
   *  republished by its owner anyway (the agent-reply path). */
  settle(correlationId: string | undefined): void {
    if (correlationId) this.claims.delete(correlationId)
  }

  /** Test/diagnostic view of the live claim, if any. */
  claimFor(correlationId: string): CardInFlight | undefined {
    return this.claims.get(correlationId)
  }
}
