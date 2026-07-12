import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { ConversationForbiddenError, ConversationService, ConversationValidationError } from "../hub/conversations/service"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"

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
  expect(service.appendUserMessage("owner@example.com", c.id, { content: "yes", clientKey: "o1" }).sequence).toBe(1)
})

test("supports lifecycle access rules and rejects writes after archive", () => {
  const { service, repo } = fixture()
  const c = service.create("owner", { title: "  Plan  ", primaryAgent: "architect" })
  repo.addParticipant({ conversationId: c.id, identity: "member", kind: "user", role: "member", createdAt: 2 })
  expect(c.title).toBe("Plan")
  expect(service.get("member", c.id).id).toBe(c.id)
  expect(service.list("member").map(({ id }) => id)).toEqual([c.id])
  expect(service.appendUserMessage("member", c.id, { content: "hello", clientKey: "m1" }).author).toBe("member")
  expect(() => service.get("stranger", c.id)).toThrow(ConversationForbiddenError)
  expect(() => service.get("owner", "missing")).toThrow(ConversationValidationError)
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
