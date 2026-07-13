import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { RepositoryConflictError, RepositoryNotFoundError } from "../hub/conversations/repository"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"

const makeRepo = () => new SqliteConversationRepository(new Database(":memory:"))
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("persists conversations and messages across a file database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-conversations-"))
  tempDirs.push(dir)
  const file = join(dir, "switchboard.sqlite")
  let db = new Database(file, { create: true })
  let repo = new SqliteConversationRepository(db)
  repo.createConversation({ id: "c1", title: "Durable", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "saved", clientKey: "key-1", createdAt: 11 })
  db.close()

  db = new Database(file)
  repo = new SqliteConversationRepository(db)
  expect(repo.getConversation("c1")?.title).toBe("Durable")
  expect(repo.listMessages("c1").map(({ content }) => content)).toEqual(["saved"])
  db.close()
})

test("updates supplied conversation fields durably without replacing messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-conversations-")); tempDirs.push(dir)
  const file = join(dir, "switchboard.sqlite")
  let db = new Database(file, { create: true }); let repo = new SqliteConversationRepository(db)
  repo.createConversation({ id: "c1", title: "Build", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 11 })
  expect(repo.updateConversation("c1", { primaryAgent: "qa" }, 12)).toMatchObject({ title: "Build", primaryAgent: "qa", updatedAt: 12 })
  db.close(); db = new Database(file); repo = new SqliteConversationRepository(db)
  expect(repo.getConversation("c1")).toMatchObject({ title: "Build", primaryAgent: "qa", updatedAt: 12 })
  expect(repo.listMessages("c1").map(({ id }) => id)).toEqual(["m1"])
  expect(() => repo.updateConversation("missing", { title: "No" }, 13)).toThrow(RepositoryNotFoundError)
  db.close()
})

test("assigns ordered message sequences and returns a duplicate client key once", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Plan", primaryAgent: "architect", createdBy: "a@example.com", createdAt: 10 })
  const first = repo.appendMessage({ id: "m1", conversationId: "c1", author: "a@example.com", origin: "web", content: "one", clientKey: "k1", createdAt: 11 })
  const duplicate = repo.appendMessage({ id: "m2", conversationId: "c1", author: "a@example.com", origin: "web", content: "one", clientKey: "k1", createdAt: 12 })
  const second = repo.appendMessage({ id: "m3", conversationId: "c1", author: "a@example.com", origin: "web", content: "two", clientKey: "k2", createdAt: 13 })
  expect([first.message.sequence, first.inserted, duplicate.message.id, duplicate.inserted, second.message.sequence]).toEqual([1, true, "m1", false, 2])
})

test("accepts replies only to messages in the same conversation", () => {
  const repo = makeRepo()
  for (const id of ["c1", "c2"]) repo.createConversation({ id, title: id, primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  repo.appendMessage({ id: "parent", conversationId: "c1", author: "owner", origin: "web", content: "parent", createdAt: 11 })
  expect(repo.appendMessage({ id: "reply", conversationId: "c1", author: "owner", origin: "web", content: "reply", replyTo: "parent", createdAt: 12 }).message.replyTo).toBe("parent")
  expect(() => repo.appendMessage({ id: "missing-reply", conversationId: "c1", author: "owner", origin: "web", content: "reply", replyTo: "missing", createdAt: 13 })).toThrow(RepositoryConflictError)
  expect(() => repo.appendMessage({ id: "cross-reply", conversationId: "c2", author: "owner", origin: "web", content: "reply", replyTo: "parent", createdAt: 14 })).toThrow(RepositoryConflictError)
  for (const replyTo of ["", "   "]) {
    expect(() => repo.appendMessage({ id: `blank-${replyTo.length}`, conversationId: "c1", author: "owner", origin: "web", content: "reply", replyTo, createdAt: 15 })).toThrow(RepositoryConflictError)
  }
  expect(repo.listMessages("c2")).toEqual([])
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

test("records inbound external message ids per link without cross-link leakage", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Mirror", primaryAgent: "architect", createdBy: "owner", createdAt: 1 })
  const first = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "one", label: null, syncMode: "two_way", enabled: true }, 2)
  const second = repo.createTransportLink({ id: "l2", conversationId: "c1", adapter: "discord", externalLocationId: "two", label: null, syncMode: "two_way", enabled: true }, 2)
  const input = { id: "m1", conversationId: "c1", author: "discord:u", origin: "transport" as const, content: "hello", createdAt: 3 }
  expect(repo.recordExternalMessage("discord", "evt", input, { linkId: first.id, externalMessageId: "discord-1" }).id).toBe("m1")
  expect(repo.recordExternalMessage("discord", "evt", { ...input, id: "duplicate" }, { linkId: first.id, externalMessageId: "discord-1" }).id).toBe("m1")
  expect(repo.resolveDeliveredExternalMessageId("m1", first.id)).toBe("discord-1")
  expect(repo.resolveDeliveredExternalMessageId("m1", second.id)).toBeNull()
})

test("resolves a delivered external message id for a canonical message and link", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Thread", primaryAgent: "architect", createdBy: "owner", createdAt: 1 })
  const link = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 2)
  repo.appendMessage({ id: "parent", conversationId: "c1", author: "owner", origin: "web", content: "parent", createdAt: 3 })
  const [delivery] = repo.createDeliveries("parent", [link], "message", 4)
  expect(repo.resolveDeliveredExternalMessageId("parent", "l1")).toBeNull()
  repo.markDeliveryDelivered(delivery!.id, "discord-parent", 5)
  expect(repo.resolveDeliveredExternalMessageId("parent", "l1")).toBe("discord-parent")
  expect(repo.resolveDeliveredExternalMessageId("parent", "missing")).toBeNull()
})

test("resolves a transport link by adapter and external location", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Links", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const saved = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 11)
  expect(repo.resolveTransportLink("discord", "room")).toEqual(saved)
  expect(repo.resolveTransportLink("discord", "missing")).toBeNull()
})

test("atomically appends an agent message and its unique deliveries", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Agent", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const links = ["l1", "l2"].map((id, index) => repo.createTransportLink({ id, conversationId: "c1", adapter: `adapter-${id}`, externalLocationId: `room-${id}`, label: null, syncMode: "two_way", enabled: true }, 11 + index))
  const input = { id: "m1", conversationId: "c1", author: "architect", origin: "agent" as const, content: "answer", clientKey: "agent-turn-1", createdAt: 20 }

  const first = repo.appendAgentMessage(input, links, 21)
  const duplicate = repo.appendAgentMessage({ ...input, id: "m2", createdAt: 22 }, links, 23)

  expect(first.inserted).toBe(true)
  expect(first.deliveries.map(({ linkId }) => linkId)).toEqual(["l1", "l2"])
  expect(first.deliveries.every(({ eventKind, state, attempts }) => eventKind === "message" && state === "pending" && attempts === 0)).toBe(true)
  expect(duplicate.inserted).toBe(false)
  expect(duplicate.message.id).toBe("m1")
  expect(duplicate.deliveries.map(({ id }) => ({ id }))).toEqual(first.deliveries.map(({ id }) => ({ id })))
})

test("rolls back an agent message when delivery creation fails", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Agent", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const missingLink = { id: "missing", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way" as const, enabled: true, createdAt: 11, updatedAt: 11 }
  expect(() => repo.appendAgentMessage({ id: "m1", conversationId: "c1", author: "architect", origin: "agent", content: "answer", createdAt: 20 }, [missingLink], 21)).toThrow()
  expect(repo.getMessage("m1")).toBeNull()
})

test("rejects cross-conversation delivery links and rolls back agent messages", () => {
  const repo = makeRepo()
  for (const id of ["c1", "c2"]) repo.createConversation({ id, title: id, primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const foreignLink = repo.createTransportLink({ id: "l2", conversationId: "c2", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 11)
  repo.appendMessage({ id: "web", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 12 })

  expect(() => repo.createDeliveries("web", [foreignLink], "message", 13)).toThrow(RepositoryConflictError)
  expect(() => repo.appendAgentMessage({ id: "agent", conversationId: "c1", author: "architect", origin: "agent", content: "answer", createdAt: 14 }, [foreignLink], 15)).toThrow(RepositoryConflictError)
  expect(repo.getMessage("agent")).toBeNull()
  expect(repo.listDueDeliveries(20)).toEqual([])
})

test("creates each delivery tuple once", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Delivery", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const link = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 11)
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 12 })
  const first = repo.createDeliveries("m1", [link, link], "message", 13)
  const duplicate = repo.createDeliveries("m1", [link], "message", 14)
  expect(first).toHaveLength(1)
  expect(duplicate).toEqual(first)
})

test("persists delivered and retry state transitions", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Delivery", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const link = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 11)
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 12 })
  const retry = repo.markDeliveryRetry(repo.createDeliveries("m1", [link], "message", 13)[0]!.id, "x".repeat(600), 30, false, 14)
  expect({ state: retry.state, attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt, errorLength: retry.error?.length }).toEqual({ state: "retry_wait", attempts: 1, nextAttemptAt: 30, errorLength: 500 })
  const delivered = repo.markDeliveryDelivered(retry.id, "external-1", 31)
  expect({ state: delivered.state, externalMessageId: delivered.externalMessageId, error: delivered.error, nextAttemptAt: delivered.nextAttemptAt }).toEqual({ state: "delivered", externalMessageId: "external-1", error: null, nextAttemptAt: null })
})

test("rejects retries without a schedule and keeps the pending delivery due", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Delivery", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const link = repo.createTransportLink({ id: "l1", conversationId: "c1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 11)
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 12 })
  const pending = repo.createDeliveries("m1", [link], "message", 13)[0]!

  expect(() => repo.markDeliveryRetry(pending.id, "missing schedule", null, false, 14)).toThrow(RepositoryConflictError)
  expect(repo.listDueDeliveries(14)).toEqual([pending])
})

test("does not reopen delivered or exhausted deliveries", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Delivery", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const links = ["l1", "l2"].map((id) => repo.createTransportLink({ id, conversationId: "c1", adapter: id, externalLocationId: id, label: null, syncMode: "two_way", enabled: true }, 11))
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 12 })
  const [delivered, exhausted] = repo.createDeliveries("m1", links, "message", 13)
  repo.markDeliveryDelivered(delivered!.id, "external", 14)
  repo.markDeliveryRetry(exhausted!.id, "dead", null, true, 14)

  expect(() => repo.markDeliveryRetry(delivered!.id, "reopen", 20, false, 15)).toThrow(RepositoryConflictError)
  expect(() => repo.markDeliveryDelivered(exhausted!.id, "external-2", 15)).toThrow(RepositoryConflictError)
  expect(repo.listDueDeliveries(30)).toEqual([])
})

test("marks retries exhausted and lists only due deliveries in deterministic order", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Delivery", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  const links = Array.from({ length: 4 }, (_, index) => repo.createTransportLink({ id: `l${index}`, conversationId: "c1", adapter: `a${index}`, externalLocationId: `room${index}`, label: null, syncMode: "two_way", enabled: true }, 11 + index))
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 20 })
  const deliveries = repo.createDeliveries("m1", links, "message", 20)
  repo.markDeliveryRetry(deliveries[0]!.id, "later", 40, false, 21)
  repo.markDeliveryRetry(deliveries[1]!.id, "due", 25, false, 22)
  const exhausted = repo.markDeliveryRetry(deliveries[2]!.id, "dead", null, true, 23)
  expect({ state: exhausted.state, attempts: exhausted.attempts, nextAttemptAt: exhausted.nextAttemptAt }).toEqual({ state: "exhausted", attempts: 1, nextAttemptAt: null })
  expect(repo.listDueDeliveries(30).map(({ id }) => id)).toEqual([deliveries[3]!.id, deliveries[1]!.id])
  expect(repo.listDueDeliveries(50, 1).map(({ id }) => id)).toEqual([deliveries[3]!.id])
})

test("caps due-delivery batches at 200", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Delivery", primaryAgent: "architect", createdBy: "owner", createdAt: 10 })
  repo.appendMessage({ id: "m1", conversationId: "c1", author: "owner", origin: "web", content: "hello", createdAt: 20 })
  const links = Array.from({ length: 201 }, (_, index) => repo.createTransportLink({ id: `l${index}`, conversationId: "c1", adapter: `a${index}`, externalLocationId: `room${index}`, label: null, syncMode: "two_way", enabled: true }, 21 + index))
  repo.createDeliveries("m1", links, "message", 30)
  expect(repo.listDueDeliveries(30, 500)).toHaveLength(200)
})

test("claims deliveries atomically and recovers them only after lease expiry", () => {
  const repo = makeRepo()
  repo.createConversation({ id: "c1", title: "Lease", primaryAgent: "a", createdBy: "o", createdAt: 1 })
  const link = repo.createTransportLink({ id: "l", conversationId: "c1", adapter: "discord", externalLocationId: "x", label: null, syncMode: "two_way", enabled: true }, 1)
  const message = repo.appendMessage({ id: "m", conversationId: "c1", author: "a", origin: "agent", content: "x", createdAt: 1 }).message
  const [delivery] = repo.createDeliveries(message.id, [link], "message", 1)
  expect(repo.claimDeliveries([delivery!.id], "worker-a", 10, 20)).toHaveLength(1)
  expect(repo.claimDeliveries([delivery!.id], "worker-b", 19, 30)).toHaveLength(0)
  expect(repo.claimDueDeliveries("worker-b", 20, 30)).toHaveLength(1)
  expect(() => repo.markDeliveryDelivered(delivery!.id, "wrong", 21, "worker-a")).toThrow(RepositoryConflictError)
  expect(repo.markDeliveryDelivered(delivery!.id, "ok", 21, "worker-b").state).toBe("delivered")
  expect(repo.claimDueDeliveries("worker-c", 99, 109)).toHaveLength(0)
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

test("atomic transport ensure rejects a link for another conversation and rolls back", () => {
  const db = new Database(":memory:"); const repo = new SqliteConversationRepository(db)
  expect(() => repo.ensureConversationForTransport({
    conversation: { id: "c-new", title: "new", primaryAgent: "a", createdBy: "owner", createdAt: 1 },
    owner: { conversationId: "c-new", identity: "owner", kind: "user", role: "owner", createdAt: 1 },
    link: { id: "l-new", conversationId: "wrong", adapter: "discord", externalLocationId: "channel", label: null, syncMode: "two_way", enabled: true }, now: 1,
  })).toThrow("Transport link conversation must match")
  expect(repo.getConversation("c-new")).toBeNull()
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM transport_links WHERE id='l-new'").get()?.n).toBe(0)
})
