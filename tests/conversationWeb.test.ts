import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { handleWebRequest, type WebDeps } from "../hub/webServer"
import { ConversationForbiddenError, ConversationService, ConversationValidationError } from "../hub/conversations/service"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"
import { RepositoryConflictError, RepositoryNotFoundError } from "../hub/conversations/repository"
import type { ConversationEvent } from "../hub/conversations/events"
import type { Conversation, Message, TransportLink } from "../hub/conversations/types"

const conversation: Conversation = { id: "c/1", title: "Design", primaryAgent: "architect", createdBy: "owner@example.com", createdAt: 1, updatedAt: 1, archivedAt: null }
const message: Message = { id: "m1", conversationId: "c/1", sequence: 1, author: "owner@example.com", origin: "web", content: "hello", replyTo: null, state: "committed", clientKey: "key-1", createdAt: 2 }
const link: TransportLink = { id: "l1", conversationId: "c/1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true, createdAt: 3, updatedAt: 3 }

function deps(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    collect: () => ({ now: 1, startedAt: 0, status: { now: 1, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] }, audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 }, recent: [], pendingApprovals: 0, pendingApprovalList: [] }),
    requireUser: req => req.headers.get("x-switchboard-user"), resolveApproval: async () => "not_found", listChannels: () => [], fetchChannelHistory: async () => [], fetchChannelTimeline: async () => [], subscribeChannel: () => () => {}, sendChannelMessage: async () => {}, runCommand: async () => null, listAgents: async () => ({}), previewAgentChange: async () => ({ error: "unused" }), confirmAgentChange: async () => ({ state: "not_found", restarted: [], fullRestart: [] }), listHubConfig: async () => ({}), previewHubConfigChange: async () => ({ error: "unused" }), confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }),
    createConversation: () => conversation, listConversations: () => [conversation], getConversation: () => conversation, updateConversation: () => conversation, archiveConversation: () => conversation,
    appendConversationMessage: () => ({ message, inserted: true }), listConversationMessages: () => [message], addConversationLink: () => link, listConversationLinks: () => [link], subscribeConversation: () => () => {},
    ...overrides,
  }
}
const auth = { "x-switchboard-user": "owner@example.com" }
const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => new Request(`http://x${path}`, { method, headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })

test("conversation routes require identity and create a conversation", async () => {
  expect((await handleWebRequest(new Request("http://x/api/conversations"), deps())).status).toBe(400)
  const created = await handleWebRequest(req("/api/conversations", "POST", { title: "Design", primaryAgent: "architect" }), deps())
  expect(created.status).toBe(201)
  expect((await created.json()).title).toBe("Design")
})

test("workspace session uses the configured trusted header and exposes status-safe agents", async () => {
  const response = await handleWebRequest(new Request("http://x/api/session", { headers: { "x-auth-user": "ada@example.com" } }), deps({
    requireUser: req => req.headers.get("x-auth-user"),
    collect: () => ({ now: 1, startedAt: 0, status: { now: 1, agents: [
      { name: "qa", emoji: "Q", alive: true, busy: false, mode: "persistent", queueDepth: 0, fillPct: 0, lastActivityMs: 1 },
      { name: "temp", emoji: "T", alive: true, busy: false, mode: "ephemeral", queueDepth: 0, fillPct: 0, lastActivityMs: 1 },
    ], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] }, audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 }, recent: [], pendingApprovals: 0, pendingApprovalList: [] }),
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ identity: "ada@example.com", agents: [{ name: "qa", alive: true, busy: false }] })
  expect((await handleWebRequest(new Request("http://x/api/session"), deps())).status).toBe(400)
})

test("PATCH conversation validates input and dispatches an owner update", async () => {
  const seen: unknown[] = []
  const d = deps({ updateConversation: (identity, id, input) => { seen.push(identity, id, input); return { ...conversation, ...input } } })
  const response = await handleWebRequest(req("/api/conversations/c%2F1", "PATCH", { title: " Roadmap ", primaryAgent: "qa" }), d)
  expect(response.status).toBe(200)
  expect(seen).toEqual(["owner@example.com", "c/1", { title: " Roadmap ", primaryAgent: "qa" }])
  for (const body of [{}, { title: 1 }, { primaryAgent: null }, { title: "ok", primaryAgent: false }]) {
    expect((await handleWebRequest(req("/api/conversations/c1", "PATCH", body), d)).status).toBe(400)
  }
  expect((await handleWebRequest(new Request("http://x/api/conversations/c1", { method: "PATCH" }), d)).status).toBe(400)
})

test("conversation routes fail closed when Task 6 dependencies are not injected", async () => {
  const incomplete = deps()
  delete incomplete.listConversations
  const response = await handleWebRequest(req("/api/conversations"), incomplete)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: "conversation_service_unavailable" })
})

test("conversation collection and item routes dispatch decoded IDs", async () => {
  const seen: string[] = []
  const d = deps({ getConversation: (_user, id) => { seen.push(id); return conversation }, archiveConversation: (_user, id) => { seen.push(id); return conversation } })
  expect((await handleWebRequest(req("/api/conversations?includeArchived=true"), d)).status).toBe(200)
  expect((await handleWebRequest(req("/api/conversations/c%2F1"), d)).status).toBe(200)
  expect((await handleWebRequest(req("/api/conversations/c%2F1", "DELETE"), d)).status).toBe(200)
  expect(seen).toEqual(["c/1", "c/1"])
  expect((await handleWebRequest(req("/api/conversations/c%2F1", "PATCH"), d)).status).toBe(400)
})

test("posting the same Idempotency-Key returns 201 then 200 with the same message", async () => {
  let firstCall = true
  const append = () => ({ message, inserted: firstCall ? (firstCall = false, true) : false })
  const headers = { "idempotency-key": "key-1" }
  const first = await handleWebRequest(req("/api/conversations/c%2F1/messages", "POST", { content: "hello" }, headers), deps({ appendConversationMessage: append }))
  const duplicate = await handleWebRequest(req("/api/conversations/c%2F1/messages", "POST", { content: "hello" }, headers), deps({ appendConversationMessage: append }))
  expect(first.status).toBe(201); expect(duplicate.status).toBe(200)
  expect((await first.json()).id).toBe((await duplicate.json()).id)
})

test("message POST awaits asynchronous turn submission", async () => {
  let submitted = false
  const response = await handleWebRequest(req("/api/conversations/c%2F1/messages", "POST", { content: "hello" }, { "idempotency-key": "key-1" }), deps({
    appendConversationMessage: async () => { submitted = true; return { message, inserted: true } },
  }))
  expect(submitted).toBe(true)
  expect(response.status).toBe(201)
  expect((await response.json()).id).toBe(message.id)
})

test("concurrent idempotent requests use durable insertion results", async () => {
  let calls = 0
  const append = () => ({ message, inserted: calls++ === 0 })
  const headers = { "idempotency-key": "key-1" }
  const [left, right] = await Promise.all([
    handleWebRequest(req("/api/conversations/c1/messages", "POST", { content: "hello" }, headers), deps({ appendConversationMessage: append })),
    handleWebRequest(req("/api/conversations/c1/messages", "POST", { content: "hello" }, headers), deps({ appendConversationMessage: append })),
  ])
  expect([left.status, right.status].sort()).toEqual([200, 201])
  expect((await left.json()).id).toBe((await right.json()).id)
})

test("message and link reads and creates use documented statuses", async () => {
  const d = deps()
  expect((await handleWebRequest(req("/api/conversations/c%2F1/messages?after=0&limit=10"), d)).status).toBe(200)
  expect((await handleWebRequest(req("/api/conversations/c%2F1/links"), d)).status).toBe(200)
  expect((await handleWebRequest(req("/api/conversations/c%2F1/links", "POST", { adapter: "discord", externalLocationId: "room" }), d)).status).toBe(201)
})

test("conversation errors map to transport statuses", async () => {
  expect((await handleWebRequest(req("/api/conversations", "POST", undefined), deps())).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/c1"), deps({ getConversation: () => { throw new ConversationForbiddenError("no") } }))).status).toBe(403)
  expect((await handleWebRequest(req("/api/conversations", "POST", {}), deps({ createConversation: () => { throw new ConversationValidationError("bad") } }))).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/c1", "PATCH", { primaryAgent: "unknown" }), deps({ updateConversation: () => { throw new ConversationValidationError("Unknown primary agent") } }))).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/missing"), deps({ getConversation: () => { throw new RepositoryNotFoundError("missing") } }))).status).toBe(404)
  expect((await handleWebRequest(req("/api/conversations/c1/links", "POST", { adapter: "discord", externalLocationId: "room" }), deps({ addConversationLink: () => { throw new RepositoryConflictError("duplicate") } }))).status).toBe(409)
})

test("events validate cursor, accept Last-Event-ID, and emit resumable SSE IDs", async () => {
  expect((await handleWebRequest(req("/api/conversations/c1/events?after=bad"), deps())).status).toBe(400)
  let after = -1
  const event: ConversationEvent = { kind: "activity", conversationId: "c1", sequence: 7, ts: 2, detail: { working: true } }
  let unsubscribed = false
  const response = await handleWebRequest(req("/api/conversations/c1/events", "GET", undefined, { "last-event-id": "6" }), deps({ subscribeConversation: (identity, _id, cursor, cb) => { expect(identity).toBe("owner@example.com"); after = cursor; cb(event); return () => { unsubscribed = true } } }))
  expect(after).toBe(6); expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toBe(`id: 7\ndata: ${JSON.stringify(event)}\n\n`)
  await reader.cancel()
  expect(unsubscribed).toBe(true)
})

test("event authorization rejects non-members", async () => {
  const response = await handleWebRequest(req("/api/conversations/c1/events"), deps({ subscribeConversation: () => { throw new ConversationForbiddenError("no") } }))
  expect(response.status).toBe(403)
})

test("query after takes precedence over Last-Event-ID", async () => {
  let after = -1
  const response = await handleWebRequest(req("/api/conversations/c1/events?after=2", "GET", undefined, { "last-event-id": "bad" }), deps({ subscribeConversation: (_identity, _id, cursor) => { after = cursor; return () => {} } }))
  expect(response.status).toBe(200)
  expect(after).toBe(2)
  await response.body!.cancel()
})

test("guarded wrong methods authenticate first and malformed IDs return 400", async () => {
  expect((await handleWebRequest(new Request("http://x/api/conversations", { method: "PATCH" }), deps())).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/%E0%A4%A"), deps())).status).toBe(400)
})

test("conversation query and link option shapes are validated", async () => {
  expect((await handleWebRequest(req("/api/conversations?includeArchived=yes"), deps())).status).toBe(400)
  for (const input of [
    { adapter: "discord", externalLocationId: "room", syncMode: "invalid" },
    { adapter: "discord", externalLocationId: "room", label: 3 },
    { adapter: "discord", externalLocationId: "room", enabled: "yes" },
  ]) expect((await handleWebRequest(req("/api/conversations/c1/links", "POST", input), deps())).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/c1/links", "POST", { adapter: " ", externalLocationId: "room" }), deps())).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/c1/links", "POST", { adapter: "discord", externalLocationId: " " }), deps())).status).toBe(400)
})

test("message routes reject invalid reply targets and oversized pages without leaking errors", async () => {
  for (const replyTo of ["missing", "message-from-another-conversation"]) {
    const response = await handleWebRequest(req("/api/conversations/c1/messages", "POST", { content: "reply", replyTo }, { "idempotency-key": replyTo }), deps({
      appendConversationMessage: () => { throw new ConversationValidationError("Reply target must belong to conversation c1") },
    }))
    expect(response.status).toBe(400)
  }
  expect((await handleWebRequest(req("/api/conversations/c1/messages?limit=201"), deps())).status).toBe(400)
  expect((await handleWebRequest(req("/api/conversations/c1/messages?limit=200"), deps())).status).toBe(200)
})

test("message HTTP replies are committed only within their conversation", async () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let sequence = 0
  const service = new ConversationService(repo, () => ++sequence, () => `generated-${++sequence}`)
  const first = service.create("owner@example.com", { title: "First", primaryAgent: "architect" })
  const second = service.create("owner@example.com", { title: "Second", primaryAgent: "architect" })
  const parent = service.appendUserMessage("owner@example.com", first.id, { content: "parent", clientKey: "parent" }).message
  const integrated = deps({
    appendConversationMessage: (identity, conversationId, input) => service.appendUserMessage(identity, conversationId, input),
  })

  const valid = await handleWebRequest(req(`/api/conversations/${first.id}/messages`, "POST", { content: "valid", replyTo: parent.id }, { "idempotency-key": "valid" }), integrated)
  const missing = await handleWebRequest(req(`/api/conversations/${first.id}/messages`, "POST", { content: "missing", replyTo: "absent" }, { "idempotency-key": "missing" }), integrated)
  const cross = await handleWebRequest(req(`/api/conversations/${second.id}/messages`, "POST", { content: "cross", replyTo: parent.id }, { "idempotency-key": "cross" }), integrated)
  const empty = await handleWebRequest(req(`/api/conversations/${first.id}/messages`, "POST", { content: "empty", replyTo: "" }, { "idempotency-key": "empty" }), integrated)
  const whitespace = await handleWebRequest(req(`/api/conversations/${first.id}/messages`, "POST", { content: "whitespace", replyTo: "   " }, { "idempotency-key": "whitespace" }), integrated)
  const trimmed = await handleWebRequest(req(`/api/conversations/${first.id}/messages`, "POST", { content: "trimmed", replyTo: `  ${parent.id}  ` }, { "idempotency-key": "trimmed" }), integrated)
  expect(valid.status).toBe(201)
  expect((await valid.json()).replyTo).toBe(parent.id)
  expect(missing.status).toBe(400)
  expect(cross.status).toBe(400)
  expect(empty.status).toBe(400)
  expect(whitespace.status).toBe(400)
  expect(trimmed.status).toBe(201)
  expect((await trimmed.json()).replyTo).toBe(parent.id)
})
