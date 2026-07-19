import { expect, test } from "bun:test"
import { resolveConversationId, type ConversationIdLookup } from "./resolveConversation"

const CONV = "e9c1dc62-cddb-4499-85b7-030126f26a3e"
const CHANNEL = "1511807891881853139"

function repo(over: Partial<ConversationIdLookup> = {}): ConversationIdLookup {
  return {
    getConversation: id => (id === CONV ? { id: CONV } : null),
    resolveTransportLink: (adapter, external) =>
      adapter === "discord" && external === CHANNEL ? { conversationId: CONV } : null,
    ...over,
  }
}

test("a conversation UUID resolves to itself", () => {
  expect(resolveConversationId(repo(), CONV)).toBe(CONV)
})

test("a linked Discord channel id resolves to its conversation UUID", () => {
  expect(resolveConversationId(repo(), CHANNEL)).toBe(CONV)
})

test("an unknown chat id resolves to nothing", () => {
  expect(resolveConversationId(repo(), "999")).toBeNull()
  expect(resolveConversationId(repo(), "")).toBeNull()
})

test("a link pointing at a deleted conversation does not resolve", () => {
  const r = repo({ getConversation: () => null })
  expect(resolveConversationId(r, CHANNEL)).toBeNull()
})

test("only the listed adapters are consulted", () => {
  const seen: string[] = []
  const r = repo({
    getConversation: () => null,
    resolveTransportLink: adapter => { seen.push(adapter); return null },
  })
  resolveConversationId(r, CHANNEL, ["matrix"])
  expect(seen).toEqual(["matrix"])
})

test("a throwing repository degrades to null rather than failing the reply", () => {
  const r = repo({ getConversation: () => { throw new Error("db gone") } })
  expect(resolveConversationId(r, CONV)).toBeNull()
})
