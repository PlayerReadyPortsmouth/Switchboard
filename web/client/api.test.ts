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
    {
      identity: "owner@example.com",
      agents: [{ name: "architect", alive: true, busy: false }],
      features: { agents: true, approvals: false },
      permissions: { agents: "operator", approvals: "hidden" },
      approvalState: { producing: false, canDecide: false, pendingCount: 0 },
    },
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

test("typed approval methods use exact query, encoded ID, decision body, and idempotency key", async () => {
  const calls: Request[] = []
  const api = new WorkspaceApi(async input => {
    calls.push(input as Request)
    return Response.json({})
  })

  await api.listApprovals({ group: "history", search: "deploy", risk: "elevated", limit: 25, cursor: "next" })
  await api.getApproval("approval/7")
  await api.decideApproval("approval/7", "grant", "12", "idem-7")

  const seen = calls.map(call => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)
  expect(seen).toContain("GET /api/operations/approvals?group=history&search=deploy&risk=elevated&limit=25&cursor=next")
  expect(seen).toContain("GET /api/operations/approvals/approval%2F7")
  const lastRequest = calls.at(-1)!
  expect(`${lastRequest.method} ${new URL(lastRequest.url).pathname}`).toBe("POST /api/operations/approvals/approval%2F7/decision")
  expect(lastRequest.headers.get("idempotency-key")).toBe("idem-7")
  expect(await lastRequest.clone().json()).toEqual({ decision: "grant", expectedVersion: "12" })
})

test("approval list requests include every supported field but ignore arbitrary caller keys", async () => {
  let request!: Request
  const api = new WorkspaceApi(async input => {
    request = input as Request
    return Response.json({})
  })

  await api.listApprovals({
    group: "pending",
    search: "release plan",
    risk: "destructive",
    kind: "outbound/web",
    requester: "agent:qa@example.com",
    state: "pending",
    conversationId: "conversation/1",
    createdFrom: 0,
    createdTo: 2,
    decisionFrom: 0,
    decisionTo: 4,
    limit: 5,
    cursor: "opaque+cursor",
    ignored: "secret",
  } as Parameters<WorkspaceApi["listApprovals"]>[0] & { ignored: string })

  expect(`${new URL(request.url).pathname}${new URL(request.url).search}`).toBe(
    "/api/operations/approvals?group=pending&search=release+plan&risk=destructive&kind=outbound%2Fweb&requester=agent%3Aqa%40example.com&state=pending&conversationId=conversation%2F1&createdFrom=0&createdTo=2&decisionFrom=0&decisionTo=4&limit=5&cursor=opaque%2Bcursor",
  )
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

test("JSON approval conflicts preserve the safe canonical recovery payload", async () => {
  const payload = {
    error: "stale_version",
    recovery: "reload",
    canonical: { id: "approval-7", version: "13", state: "denied" },
  }
  const api = new WorkspaceApi(async () => Response.json(payload, { status: 409 }))

  expect(api.decideApproval("approval-7", "grant", "12", "idem-7")).rejects.toMatchObject({
    status: 409,
    code: "stale_version",
    payload,
  })
})

test("rejected fetches become safe status-zero ApiErrors without retaining the raw exception", async () => {
  const raw = new Error("private network detail")
  const api = new WorkspaceApi(async () => { throw raw })

  try {
    await api.session()
    throw new Error("expected session to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBe(raw)
    expect(error).toMatchObject({ status: 0, code: "request_failed", payload: null })
    expect(String(error)).not.toContain("private network detail")
  }
})

test("invalid success bodies remain invalid_response errors", async () => {
  const api = new WorkspaceApi(async () => new Response("not-json", {
    status: 200,
    headers: { "content-type": "application/json" },
  }))
  expect(api.session()).rejects.toMatchObject({ status: 200, code: "invalid_response" })
})

test("scalar success JSON remains an invalid_response error", async () => {
  const api = new WorkspaceApi(async () => Response.json("unexpected"))
  expect(api.session()).rejects.toMatchObject({ status: 200, code: "invalid_response" })
})
