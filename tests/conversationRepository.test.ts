import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { RepositoryConflictError } from "../hub/conversations/repository"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"

const makeRepo = () => new SqliteConversationRepository(new Database(":memory:"))

test("assigns ordered message sequences and returns a duplicate client key once", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Plan", primaryAgent: "architect", createdBy: "a@example.com", createdAt: 10 })
  const first = repo.appendMessage({ id: "m1", conversationId: "c1", author: "a@example.com", origin: "web", content: "one", clientKey: "k1", createdAt: 11 })
  const duplicate = repo.appendMessage({ id: "m2", conversationId: "c1", author: "a@example.com", origin: "web", content: "one", clientKey: "k1", createdAt: 12 })
  const second = repo.appendMessage({ id: "m3", conversationId: "c1", author: "a@example.com", origin: "web", content: "two", clientKey: "k2", createdAt: 13 })
  expect([first.message.sequence, first.inserted, duplicate.message.id, duplicate.inserted, second.message.sequence]).toEqual([1, true, "m1", false, 2])
})

test("deduplicates an external event and returns its canonical message", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Mirror", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const input = { id: "m1", conversationId: "c1", author: "discord:u1", origin: "transport" as const, content: "hello", createdAt: 11 }
  expect(repo.recordExternalMessage("discord", "evt-1", input).id).toBe("m1")
  expect(repo.recordExternalMessage("discord", "evt-1", { ...input, id: "m2" }).id).toBe("m1")
})

test("looks up participants and lists conversations visible to the owner", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Owned", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  repo.addParticipant({ conversationId: "c1", identity: "member", kind: "user", role: "member", createdAt: 11 })
  expect(repo.getParticipant("c1", "member")?.role).toBe("member")
  expect(repo.listConversations("owner").map(({ id }) => id)).toEqual(["c1"])
  expect(repo.listConversations("member").map(({ id }) => id)).toEqual(["c1"])
})

test("excludes archived conversations unless requested", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Old", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  repo.archiveConversation("c1", 20)
  expect(repo.listConversations("owner")).toEqual([])
  expect(repo.listConversations("owner", true)[0]?.archivedAt).toBe(20)
})

test("paginates messages after a sequence", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Chat", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  for (let i = 1; i <= 4; i++) repo.appendMessage({ id: `m${i}`, conversationId: "c1", author: "owner", origin: "web", content: `${i}`, createdAt: 10 + i })
  expect(repo.listMessages("c1", 1, 2).map(({ id }) => id)).toEqual(["m2", "m3"])
})

test("persists default two-way transport links", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Links", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const link = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 12)
  expect(link.syncMode).toBe("two_way")
  expect(repo.listTransportLinks("c1")).toEqual([link])
})

test("rejects duplicate external transport locations", () => {
  const repo = makeRepo()
  for (const id of ["c1", "c2"]) repo.createConversation({ id, title: id, primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const link = { id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way" as const, enabled: true }
  repo.createTransportLink(link, 12)
  expect(() => repo.createTransportLink({ ...link, id: "l2", conversationId: "c2" }, 13)).toThrow(RepositoryConflictError)
})

test("rejects foreign-key violations", () => {
  const repo = makeRepo()
  expect(() => repo.addParticipant({ conversationId: "missing", identity: "user", kind: "user", role: "member", createdAt: 1 })).toThrow()
})

test("rejects mismatched conversation owners without persisting transaction changes", () => {
  const mismatches = [
    { conversationId: "other", identity: "creator", kind: "user" as const, role: "owner" as const, createdAt: 10 },
    { conversationId: "c1", identity: "other", kind: "user" as const, role: "owner" as const, createdAt: 10 },
    { conversationId: "c1", identity: "creator", kind: "user" as const, role: "member" as const, createdAt: 10 },
  ]

  for (const owner of mismatches) {
    const db = new Database(":memory:")
    const repo = new SqliteConversationRepository(db)
    expect(() => repo.createConversationWithOwner({ id: "c1", title: "Invalid", primaryAgent: "architect", createdBy: "creator", createdAt: 10 }, owner)).toThrow(RepositoryConflictError)
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM conversations").get()?.count).toBe(0)
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM participants").get()?.count).toBe(0)
  }
})
