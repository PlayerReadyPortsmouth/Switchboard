// hub/webCardStore.ts
// Durable record of every card posted into a conversation, so the web transcript can render
// it and it survives a page reload.
//
// This exists because the live `card` SSE event is not enough on its own — attachments hit
// exactly this bug: they were live-only and vanished on navigate-away. Reload is served by
// `listByConversation`, not by replaying events.
//
// Edit semantics: `record()` is idempotent per (correlationId, card content). A repost of the
// SAME card content does not burn a revision — cardLifecycle can re-emit, and a transcript
// that showed "revision 7" for an unchanged card would be lying about how much happened.
//
// Fail-closed, never throw on the hot path (house style): every method swallows storage
// errors. A broken card DB degrades to "the web shows no cards"; it never takes an agent
// reply, or the hub, down with it.
import type { Database } from "bun:sqlite"
import type { CardInFlight, CardInfo, CardRevision } from "./conversations/events"
import type { CardSpec } from "./types"
import { runWebCardMigrations } from "./webCardMigrations"

export interface WebCardStore {
  /** Persist a post or an edit, returning the card's new canonical state — or `null` when
   *  nothing was stored (storage error), so the caller publishes no event.
   *
   *  A real content change also clears any in-flight marker: the edit IS the answer to the
   *  click that set it, so nothing has to remember to release it. */
  record(input: { correlationId: string; conversationId: string; agent: string; card: CardSpec }): CardInfo | null
  /** Set or clear the transient "a click is running" marker WITHOUT minting a revision.
   *  Returns the card's state so the caller can publish it, or null when the card is unknown
   *  (nothing to mark) or storage failed. */
  setInFlight(correlationId: string, inFlight: CardInFlight | null): CardInfo | null
  /** One card's current state, or null. Used to reuse a card's stored `agent` when the hub
   *  edits it without an owning agent reply to hand. */
  get(correlationId: string): CardInfo | null
  /** Every card in a conversation, oldest first by anchor. The hydration path. */
  listByConversation(conversationId: string): CardInfo[]
}

export class SqliteWebCardStore implements WebCardStore {
  constructor(
    private readonly db: Database,
    private readonly maxHistory: number,
    private readonly now: () => number = Date.now,
  ) {
    runWebCardMigrations(db)
  }

  record(input: { correlationId: string; conversationId: string; agent: string; card: CardSpec }): CardInfo | null {
    const { correlationId, conversationId, agent, card } = input
    const cardJson = JSON.stringify(card)
    const t = this.now()
    try {
      let result: CardInfo | null = null
      this.db.transaction(() => {
        const existing = this.db.query<{ revision: number; card_json: string; created_at: number; in_flight_json: string | null }, [string]>(
          "SELECT revision, card_json, created_at, in_flight_json FROM web_cards WHERE correlation_id = ?").get(correlationId)

        if (!existing) {
          this.db.query(
            `INSERT INTO web_cards(correlation_id, conversation_id, agent, revision, card_json, created_at, updated_at)
             VALUES (?,?,?,1,?,?,?)`).run(correlationId, conversationId, agent, cardJson, t, t)
          result = { correlationId, conversationId, agent, revision: 1, createdAt: t, updatedAt: t, card }
          return
        }

        // An unchanged repost is not an edit. Return the current state untouched so the
        // revision counter tracks real state changes, not delivery retries — including any
        // in-flight marker, which a redelivery has not answered either.
        if (existing.card_json === cardJson) {
          result = this.hydrate({
            correlation_id: correlationId, conversation_id: conversationId, agent,
            revision: existing.revision, card_json: existing.card_json,
            created_at: existing.created_at, updated_at: t, in_flight_json: existing.in_flight_json,
          })
          return
        }

        // The state being replaced becomes history BEFORE the row is overwritten.
        this.db.query(
          `INSERT INTO web_card_revisions(correlation_id, revision, card_json, updated_at)
           VALUES (?,?,?,?) ON CONFLICT(correlation_id, revision) DO NOTHING`,
        ).run(correlationId, existing.revision, existing.card_json, t)

        const revision = existing.revision + 1
        // in_flight_json is cleared here, unconditionally: this new content IS the outcome of
        // whatever click was running, so the marker has nothing left to guard against.
        this.db.query(
          `UPDATE web_cards SET conversation_id=?, agent=?, revision=?, card_json=?, updated_at=?, in_flight_json=NULL
           WHERE correlation_id=?`).run(conversationId, agent, revision, cardJson, t, correlationId)

        // Bound the trail. Oldest revisions go first; `maxHistory` 0 keeps none.
        this.db.query(
          `DELETE FROM web_card_revisions WHERE correlation_id = ? AND revision NOT IN (
             SELECT revision FROM web_card_revisions WHERE correlation_id = ?
             ORDER BY revision DESC LIMIT ?)`,
        ).run(correlationId, correlationId, Math.max(0, this.maxHistory))

        result = this.hydrate({
          correlation_id: correlationId, conversation_id: conversationId, agent,
          revision, card_json: cardJson, created_at: existing.created_at, updated_at: t,
          in_flight_json: null,
        })
      })()
      return result
    } catch (e) { this.warn("record", e); return null }
  }

  /** Set/clear the in-flight marker in place. `revision` is deliberately untouched — the
   *  client accepts an equal-revision event only when this field changed, so the marker
   *  propagates without ever letting a transient state impersonate a content edit.
   *
   *  `updated_at` IS bumped: the row genuinely changed, and it is the only thing that lets the
   *  client order a "cleared" state against a "marked" one when they share a revision. Without
   *  it a stale hydration snapshot could reinstate a marker the live stream had already
   *  cleared, freezing the card as busy. */
  setInFlight(correlationId: string, inFlight: CardInFlight | null): CardInfo | null {
    try {
      const json = inFlight ? JSON.stringify(inFlight) : null
      const changed = this.db.query(
        "UPDATE web_cards SET in_flight_json = ?, updated_at = ? WHERE correlation_id = ?")
        .run(json, this.now(), correlationId)
      // An unknown correlation is not an error: hub-owned cards, cards posted before the flag
      // went on, and Discord-only channels all have no row. Nothing to mark, nothing to publish.
      if (!changed.changes) return null
      return this.get(correlationId)
    } catch (e) { this.warn("setInFlight", e); return null }
  }

  get(correlationId: string): CardInfo | null {
    try {
      const row = this.db.query<CardRow, [string]>(
        `SELECT ${CARD_COLUMNS} FROM web_cards WHERE correlation_id = ?`).get(correlationId)
      return row ? this.hydrate(row) : null
    } catch (e) { this.warn("get", e); return null }
  }

  listByConversation(conversationId: string): CardInfo[] {
    try {
      return this.db.query<CardRow, [string]>(
        `SELECT ${CARD_COLUMNS}
         FROM web_cards WHERE conversation_id = ? ORDER BY created_at, correlation_id`,
      ).all(conversationId).map(row => this.hydrate(row)).filter((c): c is CardInfo => c !== null)
    } catch (e) { this.warn("listByConversation", e); return [] }
  }

  /** Attach the revision trail and parse the stored spec. A row whose JSON no longer parses
   *  is dropped rather than surfaced half-built — the transcript shows one fewer card, which
   *  is honest, instead of a card with no body. */
  private hydrate(row: CardRow): CardInfo | null {
    const card = parse<CardSpec>(row.card_json)
    if (!card || !Array.isArray(card.buttons)) return null
    const info: CardInfo = {
      correlationId: row.correlation_id,
      conversationId: row.conversation_id,
      agent: row.agent,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      card,
    }
    const history = this.historyFor(row.correlation_id)
    if (history.length) info.history = history
    // A marker whose JSON no longer parses is dropped, not surfaced: the failure mode of a
    // missing marker (a button offered once too often) is milder than a card frozen as
    // "working" by a corrupt row nobody can clear.
    const inFlight = row.in_flight_json ? parse<CardInFlight>(row.in_flight_json) : null
    if (inFlight && inFlight.surface && typeof inFlight.at === "number") info.inFlight = inFlight
    return info
  }

  private historyFor(correlationId: string): CardRevision[] {
    if (this.maxHistory <= 0) return []
    try {
      return this.db.query<{ revision: number; card_json: string; updated_at: number }, [string]>(
        `SELECT revision, card_json, updated_at FROM web_card_revisions
         WHERE correlation_id = ? ORDER BY revision`).all(correlationId)
        .map(r => {
          const card = parse<CardSpec>(r.card_json)
          return card ? { revision: r.revision, card, updatedAt: r.updated_at } : null
        })
        .filter((r): r is CardRevision => r !== null)
    } catch (e) { this.warn("historyFor", e); return [] }
  }

  private warn(op: string, e: unknown): void {
    process.stderr.write(`web-card-store: ${op} failed: ${e}\n`)
  }
}

const CARD_COLUMNS = "correlation_id, conversation_id, agent, revision, card_json, created_at, updated_at, in_flight_json"

interface CardRow {
  correlation_id: string
  conversation_id: string
  agent: string
  revision: number
  card_json: string
  created_at: number
  updated_at: number
  in_flight_json: string | null
}

function parse<T>(json: string): T | null {
  try { return JSON.parse(json) as T } catch { return null }
}
