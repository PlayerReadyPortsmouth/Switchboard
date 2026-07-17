import { expect, test } from "bun:test"
import { ApiError, WorkspaceApi } from "./api"
import type { AgentConfig, Conversation, Message, TransportLink } from "./types"

const conversation: Conversation = { id: "c/1", title: "Design", primaryAgent: "architect", createdBy: "owner@example.com", createdAt: 1, updatedAt: 1, archivedAt: null }
const message: Message = { id: "m1", conversationId: "c/1", sequence: 1, author: "owner@example.com", origin: "web", content: "hello", replyTo: null, state: "committed", clientKey: "draft-1", createdAt: 2 }
const link: TransportLink = { id: "l1", conversationId: "c/1", adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true, createdAt: 3, updatedAt: 3 }

test("postMessage reuses the supplied idempotency key", async () => {
  const calls: Request[] = []
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json(message, { status: 201 })
  })

  expect(await api.postMessage("c/1", { content: "hello", clientKey: "draft-1" })).toEqual(message)
  expect(calls[0].url).toEndWith("/api/conversations/c%2F1/messages")
  expect(calls[0].headers.get("content-type")).toBe("application/json")
  expect(calls[0].headers.get("idempotency-key")).toBe("draft-1")
  expect(await calls[0].json()).toEqual({ content: "hello" })
})

test("typed conversation methods encode IDs and use documented request shapes", async () => {
  const calls: Request[] = []
  const responses: unknown[] = [
    { identity: "owner@example.com", agents: [{ name: "architect", alive: true, busy: false }] },
    [conversation], conversation, conversation, conversation, [message], [link],
  ]
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json(responses.shift())
  })

  await api.session()
  await api.listConversations(true)
  await api.createConversation({ title: "Design", primaryAgent: "architect" })
  await api.updateConversation("c/1", { title: "Roadmap" })
  await api.archiveConversation("c/1")
  await api.listMessages("c/1", 7, 50)
  await api.listLinks("c/1")

  expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual([
    "GET /api/session",
    "GET /api/conversations?includeArchived=true",
    "POST /api/conversations",
    "PATCH /api/conversations/c%2F1",
    "DELETE /api/conversations/c%2F1",
    "GET /api/conversations/c%2F1/messages?after=7&limit=50",
    "GET /api/conversations/c%2F1/links",
  ])
  expect(calls[2].headers.get("content-type")).toBe("application/json")
  expect(calls[3].headers.get("content-type")).toBe("application/json")
  expect(calls.every((call, index) => index === 2 || index === 3 || call.headers.get("content-type") === null)).toBe(true)
})

test("typed agent methods encode names and use documented request shapes", async () => {
  const calls: Request[] = []
  const config: AgentConfig = {
    emoji: "🧪",
    description: "Quality assurance",
    mode: "persistent",
    access: { roles: ["*"] },
    runtime: { cwd: "C:/workspace", model: "test-model" },
  }
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json({})
  })

  await api.listAgents()
  await api.getAgent("qa/a")
  await api.previewAgentConfig("qa/a", config, "version-7")
  await api.confirmAgentConfig("qa/a", "preview-1", true)
  await api.previewAgentAction("qa/a", "reset")
  await api.confirmAgentAction("qa/a", "action-1", "retry-key")

  expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
    "GET /api/operations/agents",
    "GET /api/operations/agents/qa%2Fa",
    "POST /api/operations/agents/qa%2Fa/config/preview",
    "POST /api/operations/agents/qa%2Fa/config/confirm",
    "POST /api/operations/agents/qa%2Fa/actions/preview",
    "POST /api/operations/agents/qa%2Fa/actions/confirm",
  ])
  expect(await calls[2].json()).toEqual({ config, expectedVersion: "version-7" })
  expect(await calls[3].json()).toEqual({ id: "preview-1", hard: true })
  expect(await calls[4].json()).toEqual({ action: "reset" })
  expect(await calls[5].json()).toEqual({ id: "action-1" })
  expect(calls[5].headers.get("idempotency-key")).toBe("retry-key")
})

test("applies a non-root base path to every request", async () => {
  const calls: Request[] = []
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json(message, { status: 201 })
  }, "http://localhost", "/switchboard/")

  await api.session()
  await api.postMessage("c/1", { content: "hi", clientKey: "draft-1" })

  expect(new URL(calls[0].url).pathname).toBe("/switchboard/api/session")
  expect(new URL(calls[1].url).pathname).toBe("/switchboard/api/conversations/c%2F1/messages")
})

test("the default base path leaves request URLs unprefixed", async () => {
  const calls: Request[] = []
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json(message)
  })
  await api.session()
  expect(new URL(calls[0].url).pathname).toBe("/api/session")
})

test("non-JSON error responses become safe ApiErrors", async () => {
  const api = new WorkspaceApi(async () => new Response("<html>proxy failure</html>", { status: 502, headers: { "content-type": "text/html" } }))
  try {
    await api.session()
    throw new Error("expected session to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, code: "request_failed" })
    expect(String(error)).not.toContain("proxy failure")
  }
})

test("JSON API error codes are preserved", async () => {
  const api = new WorkspaceApi(async () => Response.json({ error: "missing_identity" }, { status: 400 }))
  expect(api.session()).rejects.toMatchObject({ status: 400, code: "missing_identity" })
})
