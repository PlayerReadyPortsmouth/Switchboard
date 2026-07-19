// The bug this pins: a card posted by an agent into a DISCORD CHANNEL never reached the
// web transcript. The publisher looked the chat id up as a conversation UUID, a Discord
// channel snowflake is not one, the guard returned early, and `web_cards` stayed empty in
// prod while the separate cards.sqlite store captured the very same cards.
//
// Real shapes from the live incident: agent `triage` posted a card into channel
// 1511807891881853139, which is linked to conversation e9c1dc62-… (#feedback-triage).
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { publishCardToWeb, type WebCardPublishDeps } from "./webCardPublisher"
import { SqliteWebCardStore } from "./webCardStore"
import { resolveConversationId, type ConversationIdLookup } from "./conversations/resolveConversation"
import type { CardInfo } from "./conversations/events"
import type { CardSpec } from "./types"

const CONV = "e9c1dc62-cddb-4499-85b7-030126f26a3e"
const CHANNEL = "1511807891881853139"

const card = (title: string, body = "B"): CardSpec => ({ title, body, buttons: [] })

/** The hub's real link topology for the incident: one conversation, one Discord link. */
const repo: ConversationIdLookup = {
  getConversation: id => (id === CONV ? { id: CONV } : null),
  resolveTransportLink: (adapter, external) =>
    adapter === "discord" && external === CHANNEL ? { conversationId: CONV } : null,
}

function harness(over: Partial<WebCardPublishDeps> = {}) {
  const published: CardInfo[] = []
  const store = new SqliteWebCardStore(new Database(":memory:"), 20)
  const deps: WebCardPublishDeps = {
    store,
    resolveConversation: chatId => resolveConversationId(repo, chatId),
    publish: info => { published.push(info) },
    ...over,
  }
  return { store, deps, published }
}

describe("posting a card", () => {
  test("a card posted with a linked DISCORD CHANNEL id is recorded against the conversation UUID and published", () => {
    const { store, deps, published } = harness()

    const outcome = publishCardToWeb(
      { chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("🐛 Test card"), deps)

    expect(outcome).toBe("published")
    // Filed under the conversation, not the channel — this is what the web transcript reads.
    const rows = store.listByConversation(CONV)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ correlationId: "corr-1", conversationId: CONV, agent: "triage", revision: 1 })
    // And nothing filed under the raw channel id.
    expect(store.listByConversation(CHANNEL)).toHaveLength(0)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ conversationId: CONV, correlationId: "corr-1" })
  })

  test("a card posted with a conversation UUID still works", () => {
    const { store, deps, published } = harness()

    expect(publishCardToWeb({ chatId: CONV, agent: "triage", correlationId: "corr-1" }, card("T"), deps))
      .toBe("published")
    expect(store.listByConversation(CONV)).toHaveLength(1)
    expect(published).toHaveLength(1)
  })

  test("a chat with no conversation and no link records nothing and publishes nothing", () => {
    const { store, deps, published } = harness()

    expect(publishCardToWeb({ chatId: "222222222222", agent: "triage", correlationId: "corr-1" }, card("T"), deps))
      .toBe("no_conversation")
    expect(store.listByConversation(CONV)).toHaveLength(0)
    expect(store.listByConversation("222222222222")).toHaveLength(0)
    expect(published).toHaveLength(0)
  })

  test("a card with no correlationId is not stored under a synthetic id", () => {
    const { store, deps, published } = harness()

    expect(publishCardToWeb({ chatId: CHANNEL, agent: "triage" }, card("T"), deps)).toBe("no_correlation")
    expect(store.listByConversation(CONV)).toHaveLength(0)
    expect(published).toHaveLength(0)
  })

  test("the feature being off is inert", () => {
    const { deps, published } = harness({ store: null })
    expect(publishCardToWeb({ chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("T"), deps))
      .toBe("disabled")
    expect(published).toHaveLength(0)
  })
})

describe("updating a card", () => {
  // `triage` edits one card repeatedly via correlation_id. Updates run through the same
  // publisher, so they shared the same resolution bug — and are fixed by the same change.
  test("an update from a DISCORD CHANNEL id revises the SAME card in place, not a second one", () => {
    const { store, deps, published } = harness()

    publishCardToWeb({ chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("🐛 Test card"), deps)
    const outcome = publishCardToWeb(
      { chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("✅ Test card — done"), deps)

    expect(outcome).toBe("published")
    const rows = store.listByConversation(CONV)
    expect(rows).toHaveLength(1)                                  // in place, not stale + new
    expect(rows[0]).toMatchObject({ conversationId: CONV, revision: 2 })
    expect(rows[0]!.card.title).toBe("✅ Test card — done")
    expect(published).toHaveLength(2)
    expect(published[1]).toMatchObject({ conversationId: CONV, revision: 2 })
  })

  test("a card posted by UUID and updated by its channel id stays one card", () => {
    const { store, deps } = harness()

    publishCardToWeb({ chatId: CONV, agent: "triage", correlationId: "corr-1" }, card("v1"), deps)
    publishCardToWeb({ chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("v2"), deps)

    const rows = store.listByConversation(CONV)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ revision: 2, conversationId: CONV })
  })

  test("an update for an unresolvable chat stores nothing", () => {
    const { store, deps, published } = harness()
    publishCardToWeb({ chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("v1"), deps)

    expect(publishCardToWeb({ chatId: "999", agent: "triage", correlationId: "corr-1" }, card("v2"), deps))
      .toBe("no_conversation")
    expect(store.listByConversation(CONV)[0]).toMatchObject({ revision: 1 })
    expect(published).toHaveLength(1)
  })
})

test("a store error is swallowed and reported, never thrown at the agent", () => {
  const errors: unknown[] = []
  const { deps, published } = harness({
    store: { record: () => { throw new Error("db gone") }, listByConversation: () => [] },
    onError: e => { errors.push(e) },
  })

  expect(publishCardToWeb({ chatId: CHANNEL, agent: "triage", correlationId: "corr-1" }, card("T"), deps))
    .toBe("error")
  expect(errors).toHaveLength(1)
  expect(published).toHaveLength(0)
})
