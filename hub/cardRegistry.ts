import type { CardSpec } from "./types"

export interface CardLocation { chatId: string; messageId: string; card: CardSpec }

/** Tracks, per correlationId, where its card is and which buttons it carries —
 *  so a card can be re-found and edited in place. In-memory (like NotifyRouter);
 *  not persisted across hub restarts. */
export class CardRegistry {
  private byCorrelation = new Map<string, CardLocation>()
  private correlationByCustomId = new Map<string, string>()

  set(correlationId: string, chatId: string, messageId: string, card: CardSpec): void {
    const prev = this.byCorrelation.get(correlationId)
    if (prev) for (const b of prev.card.buttons) this.correlationByCustomId.delete(b.customId)
    this.byCorrelation.set(correlationId, { chatId, messageId, card })
    for (const b of card.buttons) this.correlationByCustomId.set(b.customId, correlationId)
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
