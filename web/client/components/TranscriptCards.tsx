import { useId, type JSX } from "react"
import type { CardInfo, Message } from "../types"
import { AgentCard, type CardInteract } from "./AgentCard"

/** How a card's buttons reach the hub, threaded down from the workspace.
 *  Absent (feature off, or no interaction API) ⇒ cards render read-only. */
export interface CardDeps { onCardInteract?: CardInteract }

/** One labelled group of interactive agent cards.
 *
 *  Rendered in the same two places as `TranscriptAttachments`, and deliberately with the same
 *  markup in both: nested inside the agent message that posted the cards, and once at the tail
 *  for anything not yet anchored to a message. Sharing the component is what keeps a card
 *  identical in both positions; only the surrounding CSS differs. */
export function TranscriptCards(
  { cards, nested = false, onCardInteract }: { cards: CardInfo[]; nested?: boolean } & CardDeps,
): JSX.Element | null {
  const headingId = `cards-${useId()}`
  if (!cards.length) return null
  return (
    <section
      className="transcript-cards"
      aria-labelledby={headingId}
      data-region="transcript-cards"
      data-nested={String(nested)}
    >
      <p className="eyebrow" id={headingId}>{cards.length === 1 ? "1 card" : `${cards.length} cards`}</p>
      <ul className="transcript-card-list">
        {cards.map(info => (
          // Keyed by correlationId, NOT by correlationId+revision: an edit must re-render the
          // same element in place. A revision in the key would unmount and remount the card,
          // discarding any pending/notice state and visibly flashing it out of the transcript.
          <li key={info.correlationId}>
            <AgentCard info={info} {...(onCardInteract ? { onInteract: onCardInteract } : {})} />
          </li>
        ))}
      </ul>
    </section>
  )
}

export interface AnchoredCards {
  /** message id → the cards that belong inside that message. */
  byMessage: Map<string, CardInfo[]>
  /** Cards with no agent message to sit under yet — rendered after the transcript. */
  trailing: CardInfo[]
}

/** Attach each card to the agent message it belongs to, by adjacency.
 *
 *  Identical rule to `anchorAttachments`, for the identical reason: an agent posts a card
 *  mid-turn over the MCP shim, while it is still working, and its reply message is only
 *  committed when the turn ends. So a card is always stamped BEFORE the reply it belongs to,
 *  and "nearest preceding agent message" would reliably hang it off the PREVIOUS turn.
 *  Nearest FOLLOWING agent message is the rule that matches how the data is produced.
 *
 *  Anchoring uses `createdAt` — first appearance — not `updatedAt`, so editing a card never
 *  moves it to a later message. That is the whole point of the hub keeping `createdAt` fixed
 *  across revisions, and it is why a `triage` card stays where the ticket was raised even after
 *  it has been rewritten into "Deployed to live".
 *
 *  Live, between the post and the reply landing, there is no following agent message yet —
 *  those cards fall to `trailing` and re-seat under the reply when it arrives, which reads
 *  correctly at both moments. */
export function anchorCards(messages: Message[], cards: CardInfo[]): AnchoredCards {
  const byMessage = new Map<string, CardInfo[]>()
  const trailing: CardInfo[] = []
  const agentMessages = messages.filter(message => message.origin === "agent")
  for (const card of cards) {
    const anchor = agentMessages.find(message => message.createdAt >= card.createdAt)
    if (!anchor) { trailing.push(card); continue }
    const bucket = byMessage.get(anchor.id)
    if (bucket) bucket.push(card)
    else byMessage.set(anchor.id, [card])
  }
  return { byMessage, trailing }
}
