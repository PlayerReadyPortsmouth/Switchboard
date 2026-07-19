import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import type { CardInfo, Message } from "../types"
import { Transcript } from "./Transcript"
import { anchorCards } from "./TranscriptCards"

const screen = within(document.body)
afterEach(cleanup)

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "m1", conversationId: "c1", sequence: 1, author: "Ada", origin: "web", content: "Ship it",
  replyTo: null, state: "committed", clientKey: null, createdAt: 1_000, ...overrides,
})
const card = (correlationId: string, createdAt: number, overrides: Partial<CardInfo> = {}): CardInfo => ({
  correlationId, conversationId: "c1", agent: "triage", revision: 1, createdAt, updatedAt: createdAt,
  card: { title: `Card ${correlationId}`, body: "", buttons: [{ customId: `act:${correlationId}`, label: "Fix now" }] },
  ...overrides,
})

test("a card anchors to the nearest FOLLOWING agent message, matching how it is produced", () => {
  const messages = [
    message({ id: "m1", origin: "web", createdAt: 1_000 }),
    message({ id: "m2", origin: "agent", author: "triage", sequence: 2, createdAt: 3_000 }),
    message({ id: "m3", origin: "agent", author: "triage", sequence: 3, createdAt: 9_000 }),
  ]
  // Posted mid-turn at 2_000 — before the reply that closes the turn at 3_000.
  const { byMessage, trailing } = anchorCards(messages, [card("a", 2_000), card("b", 5_000)])
  expect(byMessage.get("m2")?.map(item => item.correlationId)).toEqual(["a"])
  expect(byMessage.get("m3")?.map(item => item.correlationId)).toEqual(["b"])
  expect(trailing).toEqual([])
})

test("a card with no agent message after it yet falls to the trailing group", () => {
  const { byMessage, trailing } = anchorCards([message({ id: "m1", origin: "agent", createdAt: 1_000 })], [card("a", 5_000)])
  expect(byMessage.size).toBe(0)
  expect(trailing.map(item => item.correlationId)).toEqual(["a"])
})

test("anchoring uses createdAt, so an edit never moves a card to a later message", () => {
  const messages = [
    message({ id: "m2", origin: "agent", sequence: 2, createdAt: 3_000 }),
    message({ id: "m3", origin: "agent", sequence: 3, createdAt: 9_000 }),
  ]
  // Revision 3, updated long after m3 — but createdAt still puts it under m2.
  const edited = card("a", 2_000, { revision: 3, updatedAt: 20_000 })
  expect(anchorCards(messages, [edited]).byMessage.get("m2")?.map(item => item.correlationId)).toEqual(["a"])
})

test("a card renders nested inside the agent message that posted it", () => {
  const messages = [
    message({ id: "m1", origin: "web", createdAt: 1_000 }),
    message({ id: "m2", origin: "agent", author: "triage", sequence: 2, createdAt: 3_000, content: "Triaged." }),
  ]
  render(<Transcript messages={messages} cards={[card("a", 2_000)]} onReply={() => {}} onCardInteract={async () => ({ status: "ok" })} />)
  const group = screen.getByRole("region", { name: "1 card" })
  expect(group.getAttribute("data-nested")).toBe("true")
  // Inside the agent's article, not floating between messages.
  expect(group.closest("article")?.getAttribute("aria-label")).toBe("Message from triage (Agent)")
  expect(within(group).getByRole("button", { name: /Fix now/ })).toBeTruthy()
})

test("an unanchored card renders once at the tail, not nested", () => {
  render(<Transcript messages={[message({ id: "m1", origin: "web", createdAt: 1_000 })]} cards={[card("a", 5_000)]} onReply={() => {}} />)
  const group = screen.getByRole("region", { name: "1 card" })
  expect(group.getAttribute("data-nested")).toBe("false")
  expect(group.closest("article")).toBeNull()
})

test("a transcript with no messages but a pending card is not the empty state", () => {
  render(<Transcript messages={[]} cards={[card("a", 5_000)]} onReply={() => {}} />)
  expect(document.querySelector(".transcript-record-empty")).toBeNull()
  expect(screen.getByText("Card a")).toBeTruthy()
})

test("without an interaction handler a nested card is rendered but read-only", () => {
  const messages = [message({ id: "m2", origin: "agent", author: "triage", createdAt: 3_000 })]
  render(<Transcript messages={messages} cards={[card("a", 2_000)]} onReply={() => {}} />)
  const group = screen.getByRole("region", { name: "1 card" })
  expect(within(group).getByText("Card a")).toBeTruthy()
  expect(within(group).queryAllByRole("button")).toEqual([])
})

test("no cards means no card region at all — the transcript is unchanged", () => {
  render(<Transcript messages={[message()]} onReply={() => {}} />)
  expect(screen.queryByRole("region", { name: /card/ })).toBeNull()
})
