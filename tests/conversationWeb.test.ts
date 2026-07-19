import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { handleWebRequest, type WebDeps } from "../hub/webServer"
import { ConversationForbiddenError, ConversationService, ConversationValidationError } from "../hub/conversations/service"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"
import { RepositoryConflictError, RepositoryNotFoundError } from "../hub/conversations/repository"
import type { ConversationEvent } from "../hub/conversations/events"
import type { WebInteractionResult } from "../hub/webInteraction"
import type { Conversation, Message, TransportLink } from "../hub/conversations/types"
import { AgentOperationsError } from "../hub/operations/agentService"

const conversation: Conversation = { id: "c/1", title: "Design", primaryAgent: "architect", createdBy: "owner@example.com", createdAt: 1, updatedAt: 1, archivedAt: null }
const message: Message = { id: "m1", conversationId: "c/1", sequence: 1, author: "owner@example.com", origin: "web", content: "hello", replyTo: null, state: "committed", clientKey: "key-1", createdAt: 2 }
const link: TransportLink = { id: "l1", conversationId: "c/1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true, createdAt: 3, updatedAt: 3 }

function deps(overrides: Partial<WebDeps> = {}): WebDeps {
  return {
    collect: () => ({ now: 1, startedAt: 0, status: { now: 1, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] }, audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 }, recent: [], pendingApprovals: 0, pendingApprovalList: [] }),
    requireUser: req => req.headers.get("x-switchboard-user"), resolveApproval: async () => "not_found", listChannels: () => [], fetchChannelHistory: async () => [], fetchChannelTimeline: async () => [], subscribeChannel: () => () => {}, sendChannelMessage: async () => {}, runCommand: async () => null,
    agentOperations: { list: () => [], get: () => { throw new AgentOperationsError(404, "not_found") }, listLegacyConfigs: () => ({}), previewLegacyConfig: async () => { throw new AgentOperationsError(400, "unused") }, confirmLegacyConfig: async () => { throw new AgentOperationsError(409, "unused") }, previewConfig: async () => { throw new AgentOperationsError(400, "unused") }, confirmConfig: async () => { throw new AgentOperationsError(409, "unused") }, previewAction: () => { throw new AgentOperationsError(400, "unused") }, confirmAction: async () => { throw new AgentOperationsError(409, "unused") }, subscribe: () => ({ unsubscribe() {} }) },
    agentSessionAccess: () => ({ feature: true, role: "operator" }), listHubConfig: async () => ({}), previewHubConfigChange: async () => ({ error: "unused" }), confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }),
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
  expect(await response.json()).toEqual({ identity: "ada@example.com", agents: [{ name: "qa", alive: true, busy: false }], features: { agents: true, documents: false, turnSteps: false, cards: false }, permissions: { agents: "operator" } })
  expect((await handleWebRequest(new Request("http://x/api/session"), deps())).status).toBe(400)
})

test("workspace session reports the UI feature gates, defaulting both off when unwired", async () => {
  const session = async (extra: Parameters<typeof deps>[0] = {}) => {
    const response = await handleWebRequest(req("/api/session", "GET"), deps(extra))
    return (await response.json() as { features: Record<string, boolean> }).features
  }
  // No gate dependency supplied at all ⇒ off, exactly as before the feature existed.
  expect(await session()).toEqual({ agents: true, documents: false, turnSteps: false, cards: false })
  expect(await session({ turnStepsEnabled: () => false })).toEqual({ agents: true, documents: false, turnSteps: false, cards: false })
  expect(await session({ turnStepsEnabled: () => true })).toEqual({ agents: true, documents: false, turnSteps: true, cards: false })
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

// ---------------------------------------------------------------------------
// Lane C: canonical cards + the web interaction endpoint (hub.webCards).
// ---------------------------------------------------------------------------

const cardInfo = {
  correlationId: "corr-1", conversationId: "c/1", agent: "triage", revision: 2,
  createdAt: 10, updatedAt: 20,
  card: { title: "Ticket 7", body: "✅ Deployed to live.", buttons: [] },
  history: [{ revision: 1, card: { title: "Ticket 7", body: "🚀 Fix ready…", buttons: [{ customId: "deploy:go:7", label: "Deploy" }] }, updatedAt: 10 }],
}

test("card routes are inert with the flag off — byte-identical to before the feature", async () => {
  // Wired but disabled, and unwired entirely: both must 503 and neither may call through.
  let touched = 0
  const disabled = deps({
    webCardsEnabled: () => false,
    listConversationCards: () => { touched++; return [] },
    submitCardInteraction: () => { touched++; return { status: "ok" as const } },
  })
  expect((await handleWebRequest(req("/api/conversations/c%2F1/cards"), disabled)).status).toBe(503)
  expect((await handleWebRequest(req("/api/conversations/c%2F1/interactions", "POST", { customId: "x:y:z" }), disabled)).status).toBe(503)
  expect(touched).toBe(0)

  const unwired = deps()
  expect((await handleWebRequest(req("/api/conversations/c%2F1/cards"), unwired)).status).toBe(503)
  expect((await handleWebRequest(req("/api/conversations/c%2F1/interactions", "POST", { customId: "x:y:z" }), unwired)).status).toBe(503)
})

test("card routes require the identity header", async () => {
  const on = deps({ webCardsEnabled: () => true, listConversationCards: () => [cardInfo], submitCardInteraction: () => ({ status: "ok" }) })
  expect((await handleWebRequest(new Request("http://x/api/conversations/c1/cards"), on)).status).toBe(400)
  expect((await handleWebRequest(new Request("http://x/api/conversations/c1/interactions", { method: "POST" }), on)).status).toBe(400)
})

test("card hydration returns the stored cards for the caller's conversation", async () => {
  const seen: string[] = []
  const on = deps({
    webCardsEnabled: () => true,
    listConversationCards: (identity, conversationId) => { seen.push(identity, conversationId); return [cardInfo] },
  })
  const response = await handleWebRequest(req("/api/conversations/c%2F1/cards"), on)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual([cardInfo])
  expect(seen).toEqual(["owner@example.com", "c/1"])
})

test("interaction results map onto the documented HTTP envelope", async () => {
  const cases: [WebInteractionResult, number, unknown][] = [
    [{ status: "ok" }, 200, { status: "ok" }],
    [{ status: "handled", action: "approval" }, 200, { status: "handled", action: "approval" }],
    [{ status: "modal", modal: { title: "Note", inputs: [] } }, 200, { status: "modal", modal: { title: "Note", inputs: [] } }],
    [{ status: "unroutable", reason: "agent gone" }, 409, { error: "unroutable", reason: "agent gone" }],
    [{ status: "denied", error: "unmapped_identity", reason: "no link" }, 403, { error: "unmapped_identity", reason: "no link" }],
    [{ status: "denied", error: "not_allowlisted", reason: "nope" }, 403, { error: "not_allowlisted", reason: "nope" }],
    [{ status: "denied", error: "forbidden_action", reason: "nope" }, 403, { error: "forbidden_action", reason: "nope" }],
  ]
  for (const [result, status, body] of cases) {
    const response = await handleWebRequest(
      req("/api/conversations/c1/interactions", "POST", { customId: "ticket:ack:7" }),
      deps({ webCardsEnabled: () => true, submitCardInteraction: () => result }))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual(body)
  }
})

test("interaction rejects a malformed body before any gate or agent is reached", async () => {
  let calls = 0
  const on = deps({ webCardsEnabled: () => true, submitCardInteraction: () => { calls++; return { status: "ok" } } })
  const bad = [
    {}, { customId: "" }, { customId: "   " }, { customId: 7 },
    { customId: "a:b:c", fields: "no" }, { customId: "a:b:c", fields: [] },
    { customId: "a:b:c", fields: { note: 7 } },       // non-string value would corrupt the frame
    { customId: "a:b:c", fields: { note: { nested: 1 } } },
  ]
  for (const body of bad) {
    expect((await handleWebRequest(req("/api/conversations/c1/interactions", "POST", body), on)).status).toBe(400)
  }
  expect(calls).toBe(0)
  // …and a well-formed one passes its fields straight through.
  const seen: unknown[] = []
  const ok = deps({ webCardsEnabled: () => true, submitCardInteraction: (identity, id, input) => { seen.push(identity, id, input); return { status: "ok" } } })
  expect((await handleWebRequest(req("/api/conversations/c1/interactions", "POST", { customId: " ticket:ack:7 ", fields: { note: "hi" } }), ok)).status).toBe(200)
  expect(seen).toEqual(["owner@example.com", "c1", { customId: "ticket:ack:7", fields: { note: "hi" } }])
})

// Both card routes assert conversation membership through `ConversationService.get`
// before they touch a card row, so both can surface the same domain errors every other
// conversation route already maps. They were added outside the shared try/catch, so a
// non-participant click escaped the handler and Bun answered with an HTML 500 whose body
// carried real source lines from hub/conversations/service.ts. Regression test for that.
test("card routes map conversation domain errors onto the shared JSON envelope", async () => {
  const cases: [unknown, number][] = [
    [new ConversationForbiddenError("Identity nobody@x cannot access conversation c1"), 403],
    [new RepositoryNotFoundError("Conversation c1 not found"), 404],
    [new RepositoryConflictError("conflict"), 409],
    [new ConversationValidationError("bad"), 400],
  ]
  for (const [error, status] of cases) {
    const thrower = () => { throw error }
    const on = deps({ webCardsEnabled: () => true, listConversationCards: thrower, submitCardInteraction: thrower })
    for (const request of [
      req("/api/conversations/c1/cards"),
      req("/api/conversations/c1/interactions", "POST", { customId: "ticket:ack:7" }),
    ]) {
      const response = await handleWebRequest(request, on)
      expect(response.status).toBe(status)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(await response.json()).toEqual({ error: (error as Error).message })
    }
  }
})

// A URI-decode failure is a client error on both routes, never a 500.
test("card routes reject an undecodable conversation id", async () => {
  const on = deps({ webCardsEnabled: () => true, listConversationCards: () => [cardInfo], submitCardInteraction: () => ({ status: "ok" }) })
  const bad = "/api/conversations/%E0%A4%A/"
  for (const request of [req(`${bad}cards`), req(`${bad}interactions`, "POST", { customId: "a:b:c" })]) {
    const response = await handleWebRequest(request, on)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "malformed_conversation_id" })
  }
})

// A body that is not JSON at all (not merely the wrong shape) — the browser can send one.
test("interaction rejects a body that is not JSON", async () => {
  const on = deps({ webCardsEnabled: () => true, submitCardInteraction: () => ({ status: "ok" }) })
  const response = await handleWebRequest(new Request("http://x/api/conversations/c1/interactions", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{not json",
  }), on)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: "malformed_body" })
})

// The two cases that were already correct on the live hub. Pinned byte-for-byte so the
// forbidden fix cannot quietly reshape them.
test("card interaction keeps its already-correct unroutable and missing-identity answers", async () => {
  const on = deps({ webCardsEnabled: () => true, submitCardInteraction: () => ({ status: "unroutable", reason: "no card 7" }) })
  const routed = await handleWebRequest(req("/api/conversations/c1/interactions", "POST", { customId: "ticket:ack:7" }), on)
  expect(routed.status).toBe(409)
  expect(await routed.text()).toBe(JSON.stringify({ error: "unroutable", reason: "no card 7" }))

  const anonymous = await handleWebRequest(new Request("http://x/api/conversations/c1/interactions", { method: "POST" }), on)
  expect(anonymous.status).toBe(400)
  expect(await anonymous.text()).toBe(JSON.stringify({ error: "missing_identity" }))
})

test("the session feature flag reports card capability honestly", async () => {
  const features = async (enabled: boolean) => {
    const response = await handleWebRequest(req("/api/session"), deps({ webCardsEnabled: () => enabled }))
    return (await response.json() as { features: Record<string, boolean> }).features.cards
  }
  expect(await features(false)).toBe(false)
  expect(await features(true)).toBe(true)
})
