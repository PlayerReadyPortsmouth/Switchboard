import { expect, test } from "bun:test"
import { handleWebRequest, type WebDeps } from "../hub/webServer"
import { ConversationForbiddenError, ConversationValidationError } from "../hub/conversations/service"
import type { ConversationEvent } from "../hub/conversations/events"
import type { Conversation, Message, TransportLink } from "../hub/conversations/types"

const conversation: Conversation = { id: "c/1", title: "Design", primaryAgent: "architect", createdBy: "owner@example.com", createdAt: 1, updatedAt: 1, archivedAt: null }
const message: Message = { id: "m1", conversationId: "c/1", sequence: 1, author: "owner@example.com", origin: "web", content: "hello", replyTo: null, state: "committed", clientKey: "key-1", createdAt: 2 }
const link: TransportLink = { id: "l1", conversationId: "c/1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true, createdAt: 3, updatedAt: 3 }

function deps(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    collect: () => ({ now: 1, startedAt: 0, status: { now: 1, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] }, audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 }, recent: [], pendingApprovals: 0, pendingApprovalList: [] }),
    requireUser: req => req.headers.get("x-switchboard-user"), resolveApproval: async () => "not_found", listChannels: () => [], fetchChannelHistory: async () => [], fetchChannelTimeline: async () => [], subscribeChannel: () => () => {}, sendChannelMessage: async () => {}, runCommand: async () => null, listAgents: async () => ({}), previewAgentChange: async () => ({ error: "unused" }), confirmAgentChange: async () => ({ state: "not_found", restarted: [], fullRestart: [] }), listHubConfig: async () => ({}), previewHubConfigChange: async () => ({ error: "unused" }), confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }),
    createConversation: () => conversation, listConversations: () => [conversation], getConversation: () => conversation, archiveConversation: () => conversation,
    appendConversationMessage: () => message, listConversationMessages: () => [message], addConversationLink: () => link, listConversationLinks: () => [link], subscribeConversation: () => () => {},
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

test("conversation collection and item routes dispatch decoded IDs", async () => {
  const seen: string[] = []
  const d = deps({ getConversation: (_user, id) => { seen.push(id); return conversation }, archiveConversation: (_user, id) => { seen.push(id); return conversation } })
  expect((await handleWebRequest(req("/api/conversations?includeArchived=true"), d)).status).toBe(200)
  expect((await handleWebRequest(req("/api/conversations/c%2F1"), d)).status).toBe(200)
  expect((await handleWebRequest(req("/api/conversations/c%2F1", "DELETE"), d)).status).toBe(200)
  expect(seen).toEqual(["c/1", "c/1"])
  expect((await handleWebRequest(req("/api/conversations/c%2F1", "PATCH"), d)).status).toBe(405)
})

test("posting the same Idempotency-Key returns 201 then 200 with the same message", async () => {
  const d = deps()
  const headers = { "idempotency-key": "key-1" }
  const first = await handleWebRequest(req("/api/conversations/c%2F1/messages", "POST", { content: "hello" }, headers), d)
  const duplicate = await handleWebRequest(req("/api/conversations/c%2F1/messages", "POST", { content: "hello" }, headers), d)
  expect(first.status).toBe(201); expect(duplicate.status).toBe(200)
  expect((await first.json()).id).toBe((await duplicate.json()).id)
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
})

test("events validate cursor, accept Last-Event-ID, and emit resumable SSE IDs", async () => {
  expect((await handleWebRequest(req("/api/conversations/c1/events?after=bad"), deps())).status).toBe(400)
  let after = -1
  const event: ConversationEvent = { kind: "activity", conversationId: "c1", sequence: 7, ts: 2, detail: { working: true } }
  const response = await handleWebRequest(req("/api/conversations/c1/events", "GET", undefined, { "last-event-id": "6" }), deps({ subscribeConversation: (_id, cursor, cb) => { after = cursor; cb(event); return () => {} } }))
  expect(after).toBe(6); expect(response.status).toBe(200)
  const { value } = await response.body!.getReader().read()
  expect(new TextDecoder().decode(value)).toBe(`id: 7\ndata: ${JSON.stringify(event)}\n\n`)
})
