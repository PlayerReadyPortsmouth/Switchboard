import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { ConversationForbiddenError, ConversationService, ConversationValidationError } from "../hub/conversations/service"
import { ConversationEventStream } from "../hub/conversations/events"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"
import { RepositoryNotFoundError } from "../hub/conversations/repository"

const fixture = () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let timestamp = 0
  let identifier = 0
  const service = new ConversationService(repo, () => ++timestamp, () => `id-${++identifier}`)
  return { service, repo }
}

test("owner can write and viewer can only read", () => {
  const { service, repo } = fixture()
  const c = service.create("owner@example.com", { title: "Design", primaryAgent: "architect" })
  repo.addParticipant({ conversationId: c.id, identity: "viewer@example.com", kind: "user", role: "viewer", createdAt: 2 })
  expect(service.history("viewer@example.com", c.id)).toEqual([])
  expect(() => service.appendUserMessage("viewer@example.com", c.id, { content: "no", clientKey: "v1" })).toThrow(ConversationForbiddenError)
  expect(service.appendUserMessage("owner@example.com", c.id, { content: "yes", clientKey: "o1" }).message.sequence).toBe(1)
})

test("supports lifecycle access rules and rejects writes after archive", () => {
  const { service, repo } = fixture()
  const c = service.create("owner", { title: "  Plan  ", primaryAgent: "architect" })
  repo.addParticipant({ conversationId: c.id, identity: "member", kind: "user", role: "member", createdAt: 2 })
  expect(c.title).toBe("Plan")
  expect(service.get("member", c.id).id).toBe(c.id)
  expect(service.list("member").map(({ id }) => id)).toEqual([c.id])
  expect(service.appendUserMessage("member", c.id, { content: "hello", clientKey: "m1" }).message.author).toBe("member")
  expect(() => service.get("stranger", c.id)).toThrow(ConversationForbiddenError)
  expect(() => service.get("owner", "missing")).toThrow(RepositoryNotFoundError)
  expect(() => service.archive("member", c.id)).toThrow(ConversationForbiddenError)
  expect(service.archive("owner", c.id).archivedAt).not.toBeNull()
  expect(() => service.appendUserMessage("member", c.id, { content: "late", clientKey: "m2" })).toThrow(ConversationValidationError)
})

test("validates creation and message input", () => {
  const { service } = fixture()
  expect(() => service.create("owner", { title: "  ", primaryAgent: "architect" })).toThrow(ConversationValidationError)
  expect(() => service.create("owner", { title: "Title", primaryAgent: " " })).toThrow(ConversationValidationError)
  const c = service.create("owner", { title: "Title", primaryAgent: "architect" })
  expect(() => service.appendUserMessage("owner", c.id, { content: " ", clientKey: "m1" })).toThrow(ConversationValidationError)
  expect(() => service.appendUserMessage("owner", c.id, { content: "ok", clientKey: "" })).toThrow(ConversationValidationError)
})

test("transport links default to two-way and creation is owner-only", () => {
  const { service, repo } = fixture()
  const c = service.create("owner", { title: "Links", primaryAgent: "architect" })
  repo.addParticipant({ conversationId: c.id, identity: "member", kind: "user", role: "member", createdAt: 2 })
  const input = { adapter: "discord", externalLocationId: "room", label: "Chat" }
  expect(() => service.addTransportLink("member", c.id, input)).toThrow(ConversationForbiddenError)
  const saved = service.addTransportLink("owner", c.id, input)
  expect(saved.syncMode).toBe("two_way")
  expect(service.listTransportLinks("member", c.id)).toEqual([saved])
  expect(() => service.listTransportLinks("stranger", c.id)).toThrow(ConversationForbiddenError)
})

test("a duplicate client key emits one committed event", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const stream = new ConversationEventStream((conversationId, after) => repo.listMessages(conversationId, after))
  let identifier = 0
  const service = new ConversationService(repo, () => 10, () => `id-${++identifier}`, stream)
  const conversation = service.create("owner", { title: "Events", primaryAgent: "architect" })
  const seen: number[] = []
  stream.subscribe(conversation.id, 0, (event) => seen.push(event.sequence))

  const first = service.appendUserMessage("owner", conversation.id, { content: "hello", clientKey: "same" })
  const duplicate = service.appendUserMessage("owner", conversation.id, { content: "hello", clientKey: "same" })

  expect(seen).toEqual([1])
  expect(first.inserted).toBe(true)
  expect(duplicate.inserted).toBe(false)
  expect(duplicate.message.id).toBe(first.message.id)
})

test("a throwing event subscriber does not make a persisted append appear failed", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const stream = new ConversationEventStream((conversationId, after) => repo.listMessages(conversationId, after))
  let identifier = 0
  const service = new ConversationService(repo, () => 10, () => `id-${++identifier}`, stream)
  const conversation = service.create("owner", { title: "Events", primaryAgent: "architect" })
  stream.subscribe(conversation.id, 0, () => { throw new Error("subscriber failed") })

  expect(() => service.appendUserMessage("owner", conversation.id, { content: "hello", clientKey: "key" })).not.toThrow()
  expect(repo.listMessages(conversation.id).map(({ content }) => content)).toEqual(["hello"])
})
