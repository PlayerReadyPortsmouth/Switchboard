import type { CardStore, StoredButton } from "./cardStore"

/** Maps a posted card's button customIds back to the agent that requested the card.
 *  Unlike PermissionRouter, entries persist (a card can be clicked many times)
 *  until explicitly forgotten.
 *
 *  The Map is the only read path. With a `store` (cardPersistence flag on) writes
 *  mirror through and `restore()` reloads surviving entries at boot, so a click
 *  after a restart still finds its owning agent. With no store this is
 *  byte-identical to the original in-memory-only router. */
export class NotifyRouter {
  private byCustomId = new Map<string, string>()

  constructor(private store: CardStore | null = null) {}

  register(customIds: string[], agent: string): void {
    for (const id of customIds) this.byCustomId.set(id, agent)
    this.store?.putButtons(customIds, agent)
  }
  agentFor(customId: string): string | undefined {
    return this.byCustomId.get(customId)
  }
  forget(customIds: string[]): void {
    for (const id of customIds) this.byCustomId.delete(id)
    this.store?.deleteButtons(customIds)
  }
  /** Re-seat button→agent rows read back from the store at boot. */
  restore(buttons: StoredButton[]): number {
    for (const b of buttons) this.byCustomId.set(b.customId, b.agentKey)
    return buttons.length
  }
}
