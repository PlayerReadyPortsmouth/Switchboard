// The canonical card record: does a card survive a reload, and does an edit express
// "this card is now in state X" rather than appending a second card?
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteWebCardStore } from "./webCardStore"
import type { CardSpec } from "./types"

const card = (title: string, body: string, buttons: CardSpec["buttons"] = []): CardSpec =>
  ({ title, body, buttons })

const store = (maxHistory = 20, clock = { t: 1_000 }) => ({
  store: new SqliteWebCardStore(new Database(":memory:"), maxHistory, () => clock.t),
  clock,
})

describe("posting", () => {
  test("a card is persisted and rehydrates by conversation", () => {
    const { store: s } = store()
    s.record({ correlationId: "c1", conversationId: "conv", agent: "triage", card: card("T", "B") })
    const rows = s.listByConversation("conv")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ correlationId: "c1", agent: "triage", revision: 1 })
    expect(rows[0]!.card).toEqual(card("T", "B"))
    expect(rows[0]!.history).toBeUndefined()
  })

  test("cards from another conversation are not returned", () => {
    const { store: s } = store()
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "B") })
    s.record({ correlationId: "c2", conversationId: "other", agent: "a", card: card("T2", "B2") })
    expect(s.listByConversation("conv").map(c => c.correlationId)).toEqual(["c1"])
  })
})

describe("edit in place", () => {
  test("an update replaces the card's state rather than adding a second card", () => {
    const { store: s, clock } = store()
    s.record({ correlationId: "c1", conversationId: "conv", agent: "triage", card: card("Ticket 7", "🚀 Fix ready…") })
    clock.t = 2_000
    s.record({ correlationId: "c1", conversationId: "conv", agent: "triage", card: card("Ticket 7", "✅ Deployed to live.") })

    const rows = s.listByConversation("conv")
    expect(rows).toHaveLength(1)                       // one card, not two
    expect(rows[0]!.revision).toBe(2)
    expect(rows[0]!.card.body).toBe("✅ Deployed to live.")
  })

  test("the anchor is the FIRST post, so an edit never reorders the transcript", () => {
    const { store: s, clock } = store()
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "one") })
    clock.t = 9_000
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "two") })
    const row = s.listByConversation("conv")[0]!
    expect(row.createdAt).toBe(1_000)
    expect(row.updatedAt).toBe(9_000)
  })

  test("prior states are kept as an inert trail, oldest first", () => {
    const { store: s, clock } = store()
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "one") })
    clock.t = 2_000
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "two") })
    clock.t = 3_000
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "three") })

    const row = s.listByConversation("conv")[0]!
    expect(row.revision).toBe(3)
    expect(row.card.body).toBe("three")
    expect(row.history?.map(h => [h.revision, h.card.body])).toEqual([[1, "one"], [2, "two"]])
  })

  test("an unchanged repost does not burn a revision", () => {
    // cardLifecycle can re-emit the same card; a transcript claiming "revision 4" for a card
    // that never changed would overstate what happened.
    const { store: s, clock } = store()
    const spec = card("T", "same")
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: spec })
    clock.t = 2_000
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: spec })
    const row = s.listByConversation("conv")[0]!
    expect(row.revision).toBe(1)
    expect(row.history).toBeUndefined()
  })

  test("the trail is bounded by maxHistory, dropping the oldest", () => {
    const { store: s, clock } = store(2)
    for (let i = 1; i <= 5; i++) {
      clock.t = i * 1_000
      s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", `v${i}`) })
    }
    const row = s.listByConversation("conv")[0]!
    expect(row.revision).toBe(5)
    expect(row.history?.map(h => h.card.body)).toEqual(["v3", "v4"])
  })

  test("maxHistory 0 keeps latest state only", () => {
    const { store: s, clock } = store(0)
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "one") })
    clock.t = 2_000
    s.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "two") })
    const row = s.listByConversation("conv")[0]!
    expect(row.revision).toBe(2)
    expect(row.history).toBeUndefined()
  })
})

describe("buttons across revisions", () => {
  test("only the current revision carries live buttons; history keeps its own inertly", () => {
    const { store: s, clock } = store()
    s.record({
      correlationId: "c1", conversationId: "conv", agent: "a",
      card: card("Ticket", "🚀 Fix ready…", [{ customId: "deploy:go:7", label: "Deploy" }]),
    })
    clock.t = 2_000
    const done = s.record({
      correlationId: "c1", conversationId: "conv", agent: "a",
      card: card("Ticket", "✅ Deployed to live.", []),
    })!
    // The live card is terminal — no controls to misclick.
    expect(done.card.buttons).toEqual([])
    // The superseded state is retained verbatim, including the button Lane D must NOT
    // render as clickable.
    expect(done.history?.[0]!.card.buttons).toEqual([{ customId: "deploy:go:7", label: "Deploy" }])
  })
})

describe("durability", () => {
  test("cards survive a store restart against the same database (the reload path)", () => {
    const db = new Database(":memory:")
    const first = new SqliteWebCardStore(db, 20, () => 1_000)
    first.record({ correlationId: "c1", conversationId: "conv", agent: "a", card: card("T", "B") })
    // A fresh store over the same DB is what a hub restart / page reload sees.
    const second = new SqliteWebCardStore(db, 20, () => 2_000)
    expect(second.listByConversation("conv")[0]).toMatchObject({ correlationId: "c1", revision: 1 })
  })

  test("a corrupt row is dropped, not surfaced half-built", () => {
    const db = new Database(":memory:")
    const s = new SqliteWebCardStore(db, 20, () => 1_000)
    s.record({ correlationId: "ok", conversationId: "conv", agent: "a", card: card("T", "B") })
    db.query(`INSERT INTO web_cards(correlation_id, conversation_id, agent, revision, card_json, created_at, updated_at)
              VALUES ('bad','conv','a',1,'{not json',1,1)`).run()
    expect(s.listByConversation("conv").map(c => c.correlationId)).toEqual(["ok"])
  })
})
