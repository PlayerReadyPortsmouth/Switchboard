/** Maps a posted card's button customIds back to the agent that requested the card.
 *  Unlike PermissionRouter, entries persist (a card can be clicked many times)
 *  until explicitly forgotten. */
export class NotifyRouter {
  private byCustomId = new Map<string, string>()
  register(customIds: string[], agent: string): void {
    for (const id of customIds) this.byCustomId.set(id, agent)
  }
  agentFor(customId: string): string | undefined {
    return this.byCustomId.get(customId)
  }
  forget(customIds: string[]): void {
    for (const id of customIds) this.byCustomId.delete(id)
  }
}
