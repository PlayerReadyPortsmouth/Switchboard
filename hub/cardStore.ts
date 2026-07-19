// hub/cardStore.ts
// Durable mirror of the card-routing maps, so a hub restart doesn't kill every live card
// button in Discord.
//
// Shape: the in-memory Maps stay the ONLY read path at click time (same lookups, same
// latency, same semantics). This store is a write-through mirror plus a boot-time restore.
// With the store absent (flag off) every call site collapses to the pre-existing code — see
// the `if (!this.store)` guards in cardRegistry.ts / notifyRouter.ts / gateway.ts.
//
// Staleness: rows carry `updated_at`, refreshed on every write (a card edited today is live
// today, however old its correlationId). `restore()` and `sweep()` both apply the same
// cutoff, so an entry past the retention window can never come back — a `deploy:go:<pr>`
// button cannot fire months after its PR stopped mattering. The TTL bounds RESURRECTION, not
// process memory: within one hub lifetime behaviour is byte-identical to today, which keeps
// the flag's blast radius to exactly the bug being fixed.
//
// Fail-closed, never throw on the hot path (house style): every method swallows storage
// errors. A broken card DB degrades to today's in-memory-only behaviour; it never takes a
// card click, or the hub, down with it.
import type { Database } from "bun:sqlite"
import type { CardModal, CardSpec } from "./types"
import { runCardMigrations } from "./cardMigrations"

export interface StoredCard { correlationId: string; chatId: string; messageId: string; card: CardSpec }
export interface StoredButton { customId: string; agentKey: string }
export interface StoredModal { customId: string; modal: CardModal }

/** The persistence port the card subsystem writes through. Implemented by
 *  SqliteCardStore; `null` everywhere the feature is off. */
export interface CardStore {
  putCard(correlationId: string, chatId: string, messageId: string, card: CardSpec): void
  putButtons(customIds: string[], agentKey: string): void
  deleteButtons(customIds: string[]): void
  putModal(customId: string, modal: CardModal): void
  deleteModals(customIds: string[]): void
  /** Every non-expired card/button/modal, for boot-time restore. */
  loadAll(): { cards: StoredCard[]; buttons: StoredButton[]; modals: StoredModal[] }
  /** Delete every expired row. Returns how many rows went. */
  sweep(): number
}

export class SqliteCardStore implements CardStore {
  constructor(
    private readonly db: Database,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    runCardMigrations(db)
  }

  private cutoff(): number { return this.now() - this.ttlMs }

  putCard(correlationId: string, chatId: string, messageId: string, card: CardSpec): void {
    try {
      this.db.query(
        `INSERT INTO card_locations(correlation_id, chat_id, message_id, card_json, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(correlation_id) DO UPDATE SET
           chat_id=excluded.chat_id, message_id=excluded.message_id,
           card_json=excluded.card_json, updated_at=excluded.updated_at`,
      ).run(correlationId, chatId, messageId, JSON.stringify(card), this.now())
    } catch (e) { this.warn("putCard", e) }
  }

  putButtons(customIds: string[], agentKey: string): void {
    if (!customIds.length) return
    try {
      const t = this.now()
      const q = this.db.query(
        `INSERT INTO card_buttons(custom_id, agent_key, updated_at) VALUES (?,?,?)
         ON CONFLICT(custom_id) DO UPDATE SET agent_key=excluded.agent_key, updated_at=excluded.updated_at`)
      this.db.transaction(() => { for (const id of customIds) q.run(id, agentKey, t) })()
    } catch (e) { this.warn("putButtons", e) }
  }

  deleteButtons(customIds: string[]): void {
    if (!customIds.length) return
    try {
      const q = this.db.query("DELETE FROM card_buttons WHERE custom_id = ?")
      this.db.transaction(() => { for (const id of customIds) q.run(id) })()
    } catch (e) { this.warn("deleteButtons", e) }
  }

  putModal(customId: string, modal: CardModal): void {
    try {
      this.db.query(
        `INSERT INTO card_modals(custom_id, modal_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(custom_id) DO UPDATE SET modal_json=excluded.modal_json, updated_at=excluded.updated_at`,
      ).run(customId, JSON.stringify(modal), this.now())
    } catch (e) { this.warn("putModal", e) }
  }

  deleteModals(customIds: string[]): void {
    if (!customIds.length) return
    try {
      const q = this.db.query("DELETE FROM card_modals WHERE custom_id = ?")
      this.db.transaction(() => { for (const id of customIds) q.run(id) })()
    } catch (e) { this.warn("deleteModals", e) }
  }

  loadAll(): { cards: StoredCard[]; buttons: StoredButton[]; modals: StoredModal[] } {
    const cutoff = this.cutoff()
    const cards: StoredCard[] = []
    const buttons: StoredButton[] = []
    const modals: StoredModal[] = []
    try {
      for (const r of this.db.query<{ correlation_id: string; chat_id: string; message_id: string; card_json: string }, [number]>(
        "SELECT correlation_id, chat_id, message_id, card_json FROM card_locations WHERE updated_at > ?").all(cutoff)) {
        const card = parse<CardSpec>(r.card_json)
        // A card with no buttons array would break every consumer; drop it rather than
        // restore something malformed into the hot path.
        if (!card || !Array.isArray(card.buttons)) continue
        cards.push({ correlationId: r.correlation_id, chatId: r.chat_id, messageId: r.message_id, card })
      }
      for (const r of this.db.query<{ custom_id: string; agent_key: string }, [number]>(
        "SELECT custom_id, agent_key FROM card_buttons WHERE updated_at > ?").all(cutoff)) {
        buttons.push({ customId: r.custom_id, agentKey: r.agent_key })
      }
      for (const r of this.db.query<{ custom_id: string; modal_json: string }, [number]>(
        "SELECT custom_id, modal_json FROM card_modals WHERE updated_at > ?").all(cutoff)) {
        const modal = parse<CardModal>(r.modal_json)
        if (modal) modals.push({ customId: r.custom_id, modal })
      }
    } catch (e) { this.warn("loadAll", e) }
    return { cards, buttons, modals }
  }

  sweep(): number {
    const cutoff = this.cutoff()
    try {
      let n = 0
      this.db.transaction(() => {
        for (const table of ["card_locations", "card_buttons", "card_modals"]) {
          n += this.db.query(`DELETE FROM ${table} WHERE updated_at <= ?`).run(cutoff).changes
        }
      })()
      return n
    } catch (e) { this.warn("sweep", e); return 0 }
  }

  private warn(op: string, e: unknown): void {
    process.stderr.write(`card-store: ${op} failed: ${e}\n`)
  }
}

function parse<T>(json: string): T | null {
  try { return JSON.parse(json) as T } catch { return null }
}
