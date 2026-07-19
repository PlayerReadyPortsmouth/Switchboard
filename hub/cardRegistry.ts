import type { CardSpec } from "./types"
import type { CardStore, StoredCard } from "./cardStore"

export interface CardLocation { chatId: string; messageId: string; card: CardSpec }

/** Tracks, per correlationId, where its card is and which buttons it carries —
 *  so a card can be re-found and edited in place.
 *
 *  The Maps are the only read path. When a `store` is supplied (cardPersistence
 *  flag on) every write is mirrored to it and `restore()` reloads the surviving
 *  entries at boot, so card buttons keep working across a hub restart. With no
 *  store this is byte-identical to the original in-memory-only registry. */
export class CardRegistry {
  private byCorrelation = new Map<string, CardLocation>()
  private correlationByCustomId = new Map<string, string>()

  constructor(private store: CardStore | null = null) {}

  set(correlationId: string, chatId: string, messageId: string, card: CardSpec): void {
    this.index(correlationId, chatId, messageId, card)
    this.store?.putCard(correlationId, chatId, messageId, card)
  }

  /** Populate the maps without writing back to the store — the shared core of
   *  `set()` and `restore()`. */
  private index(correlationId: string, chatId: string, messageId: string, card: CardSpec): void {
    const prev = this.byCorrelation.get(correlationId)
    if (prev) for (const b of prev.card.buttons) this.correlationByCustomId.delete(b.customId)
    this.byCorrelation.set(correlationId, { chatId, messageId, card })
    for (const b of card.buttons) this.correlationByCustomId.set(b.customId, correlationId)
  }

  /** Re-seat cards read back from the store at boot. Entries past the store's
   *  retention window are never handed here, so a stale card cannot revive. */
  restore(cards: StoredCard[]): number {
    for (const c of cards) this.index(c.correlationId, c.chatId, c.messageId, c.card)
    return cards.length
  }

  get(correlationId: string): CardLocation | undefined {
    return this.byCorrelation.get(correlationId)
  }

  correlationFor(customId: string): string | undefined {
    return this.correlationByCustomId.get(customId)
  }

  /** Old button customIds for this correlation that are NOT in `newIds`. */
  supersededCustomIds(correlationId: string, newIds: string[]): string[] {
    const prev = this.byCorrelation.get(correlationId)?.card.buttons ?? []
    const keep = new Set(newIds)
    return prev.map((b) => b.customId).filter((id) => !keep.has(id))
  }
}
