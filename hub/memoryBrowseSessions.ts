// hub/memoryBrowseSessions.ts
import type { NoteSummary } from "./memoryCard"

export interface BrowseSession { chatId: string; scopes: string[]; query?: string; label: string; notes: NoteSummary[]; page: number; pageSize: number }

/** Short-lived map of corrId → the notes a posted browse card is showing.
 *  corrIds are base36 counters (no ':' — safe inside the mem: customId). */
export class BrowseSessions {
  private map = new Map<string, BrowseSession>()
  private counter = 0
  constructor(private cap = 200) {}

  create(s: Omit<BrowseSession, "page"> & { page?: number }): string {
    const id = "s" + (this.counter++).toString(36)
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(id, { ...s, page: s.page ?? 0 })
    return id
  }
  get(corrId: string): BrowseSession | undefined { return this.map.get(corrId) }
  setPage(corrId: string, page: number): void { const v = this.map.get(corrId); if (v) v.page = page }
}
