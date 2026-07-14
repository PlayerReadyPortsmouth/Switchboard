import { Database } from "bun:sqlite"
import { createBuiltWorkspaceAssets } from "../../hub/webAssets"
import { handleWebRequest, type WebDeps } from "../../hub/webServer"
import { ConversationEventStream, ConversationService, SqliteConversationRepository } from "../../hub/conversations"
import type { WebInput } from "../../hub/web"
import { AgentOperationsService } from "../../hub/operations/agentService"
import { AgentEventStream } from "../../hub/operations/agentEvents"
import { AgentActionPreviewRegistry, IdempotencyRegistry } from "../../hub/operations/operationPreview"
import { AgentConfigPreviewRegistry } from "../../hub/agentConfigPreview"
import type { AgentRegistry, HubConfig } from "../../hub/types"
import type { AgentStatus } from "../../hub/statusRegistry"

const HOST = "127.0.0.1"
const PORT = 4173
const IDENTITY = "owner@example.com"
const AGENTS = ["architect", "qa"] as const

const db = new Database(":memory:")
const repository = new SqliteConversationRepository(db)
let serial = 0
let clock = 1_800_000_000_000
const nextId = () => `e2e-${++serial}`
const now = () => ++clock
const events = new ConversationEventStream((conversationId, after, limit) => repository.listMessages(conversationId, after, limit))
const service = new ConversationService(repository, now, nextId, events, agent => AGENTS.includes(agent as typeof AGENTS[number]))
const assets = createBuiltWorkspaceAssets()

const hub: HubConfig = {
  discord: { enabled: false }, guildIds: [], socketPath: "fixture.sock", stateDir: "fixture-state",
  routerModel: "fixture-router", switchThreshold: 0.5, defaultAgent: "architect",
  ephemeralTimeoutMs: 60_000, tagStyle: "prefix", chatKeyScope: "channel",
  workspace: { features: { agents: true }, operators: [IDENTITY] },
}
let agentRegistry: AgentRegistry = {
  architect: { emoji: "A", description: "System architect", mode: "persistent", access: { roles: ["*"] }, runtime: { cwd: "/fixture/architect", model: "fixture-model", resumable: true } },
  qa: { emoji: "Q", description: "Quality assurance", mode: "persistent", access: { roles: ["*"] }, runtime: { cwd: "/fixture/qa", model: "fixture-model", resumable: true, injectContext: "onSwitch", maxQueueDepth: 8 } },
}
let agentStatuses: AgentStatus[] = AGENTS.map(name => ({
  name, emoji: name === "architect" ? "A" : "Q", mode: "persistent", alive: true, busy: false,
  queueDepth: 0, fillPct: name === "architect" ? 0.21 : 0.34, costUsd: name === "architect" ? 0.4 : 0.2,
  replicas: 1, lastActivityMs: clock,
}))
const agentEvents = new AgentEventStream(1)
const actionCounts = { reset: 0, restart: 0 }
const auditRows: Array<Record<string, unknown>> = []
const agentOperations = new AgentOperationsService({
  workspace: hub.workspace,
  hub,
  readAgents: () => agentRegistry,
  statuses: () => ({ agents: agentStatuses, overseers: [] }),
  commitConfig: async ({ agent, after, classification }) => {
    if (after === null) {
      const { [agent]: _removed, ...remaining } = agentRegistry
      agentRegistry = remaining
    } else agentRegistry = { ...agentRegistry, [agent]: structuredClone(after) }
    return { state: "applied", restarted: classification.tier === "hard" ? [agent] : [], fullRestart: [...classification.fullRestart] }
  },
  runAction: async ({ agent, action }) => {
    actionCounts[action]++
    return { state: "applied", agent, action }
  },
  audit: input => { auditRows.push({ sequence: auditRows.length + 1, ts: now(), ...structuredClone(input) }) },
  now,
  events: agentEvents,
  configPreviews: new AgentConfigPreviewRegistry(now, nextId, 60_000),
  actionPreviews: new AgentActionPreviewRegistry(now, nextId, 60_000),
  idempotency: new IdempotencyRegistry(now, 60_000),
})

const designReview = service.create(IDENTITY, { title: "Design review", primaryAgent: "architect" })
service.appendUserMessage(IDENTITY, designReview.id, { content: "Can we review the workspace navigation?", clientKey: "seed-design-user" })
service.appendAgentMessage({
  id: nextId(), conversationId: designReview.id, author: "architect", origin: "agent",
  content: "Yes. I have the responsive navigation notes ready.", state: "completed", createdAt: now(),
}, [])

const longTranscript = service.create(IDENTITY, { title: "Long transcript", primaryAgent: "architect" })
for (let index = 1; index <= 36; index++) {
  service.appendAgentMessage({
    id: nextId(), conversationId: longTranscript.id, author: index % 2 ? "architect" : IDENTITY,
    origin: index % 2 ? "agent" : "web", content: `Canonical history message ${index}`,
    state: index % 2 ? "completed" : "committed", createdAt: now(),
  }, [])
}

const dashboard = (): WebInput => ({
  now: clock,
  startedAt: clock - 1_000,
  status: {
    now: clock,
    agents: AGENTS.map(name => ({
      name, emoji: name === "architect" ? "A" : "Q", mode: "persistent" as const,
      alive: true, busy: false, queueDepth: 0, fillPct: 0, lastActivityMs: clock,
    })),
    overseers: [], routes: [], routeRate10m: 0, ephemerals: [],
  },
  audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 1 },
  recent: [], pendingApprovals: 0, pendingApprovalList: [],
})

const deps: WebDeps = {
  collect: dashboard,
  requireUser: request => request.headers.get("x-switchboard-user"),
  resolveApproval: async () => "not_found",
  listChannels: () => [],
  fetchChannelHistory: async () => [],
  fetchChannelTimeline: async () => [],
  subscribeChannel: () => () => {},
  sendChannelMessage: async () => {},
  runCommand: async () => null,
  agentOperations,
  agentSessionAccess: () => ({ feature: true, role: "operator" }),
  listHubConfig: async () => ({}),
  previewHubConfigChange: async () => ({ id: "fixture", before: {}, after: {}, classification: { tier: "safe", fullRestart: [] } }),
  confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }),
  createConversation: (identity, input) => service.create(identity, input),
  listConversations: (identity, includeArchived) => service.list(identity, includeArchived),
  getConversation: (identity, conversationId) => service.get(identity, conversationId),
  updateConversation: (identity, conversationId, input) => service.update(identity, conversationId, input),
  archiveConversation: (identity, conversationId) => service.archive(identity, conversationId),
  appendConversationMessage: (identity, conversationId, input) => {
    const result = service.appendUserMessage(identity, conversationId, input)
    if (result.inserted) {
      const conversation = service.get(identity, conversationId)
      service.appendAgentMessage({
        id: nextId(), conversationId, author: conversation.primaryAgent, origin: "agent",
        content: `Fixture reply: ${input.content}`, state: "completed", createdAt: now(),
      }, [])
    }
    return result
  },
  listConversationMessages: (identity, conversationId, after, limit) => service.history(identity, conversationId, after, limit),
  addConversationLink: (identity, conversationId, input) => service.addTransportLink(identity, conversationId, input),
  listConversationLinks: (identity, conversationId) => service.listTransportLinks(identity, conversationId),
  subscribeConversation: (identity, conversationId, after, callback) => {
    service.get(identity, conversationId)
    return events.subscribe(conversationId, after, callback)
  },
}

const activeSseDrops = new Map<string, Set<() => void>>()
const activeAgentSseDrops = new Set<() => void>()

function droppableSse(response: Response, conversationId: string): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  let dropped = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const cleanup = () => {
    const drops = activeSseDrops.get(conversationId)
    drops?.delete(drop)
    if (!drops?.size) activeSseDrops.delete(conversationId)
  }
  const drop = () => {
    if (dropped) return
    dropped = true
    cleanup()
    controller?.close()
    void reader.cancel().catch(() => {})
  }
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
      const drops = activeSseDrops.get(conversationId) ?? new Set<() => void>()
      drops.add(drop)
      activeSseDrops.set(conversationId, drops)
      nextController.enqueue(new TextEncoder().encode(": connected\n\n"))
      void (async () => {
        try {
          while (!dropped) {
            const result = await reader.read()
            if (result.done) { cleanup(); nextController.close(); return }
            nextController.enqueue(result.value)
          }
        } catch (error) {
          cleanup()
          if (!dropped) nextController.error(error)
        }
      })()
    },
    cancel() { dropped = true; cleanup(); return reader.cancel() },
  })
  return new Response(stream, { status: response.status, headers: response.headers })
}

function droppableAgentSse(response: Response): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  let dropped = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const drop = () => {
    if (dropped) return
    dropped = true
    activeAgentSseDrops.delete(drop)
    controller?.close()
    void reader.cancel().catch(() => {})
  }
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
      activeAgentSseDrops.add(drop)
      nextController.enqueue(new TextEncoder().encode(": connected\n\n"))
      void (async () => {
        try {
          while (!dropped) {
            const result = await reader.read()
            if (result.done) { activeAgentSseDrops.delete(drop); nextController.close(); return }
            nextController.enqueue(result.value)
          }
        } catch (error) {
          activeAgentSseDrops.delete(drop)
          if (!dropped) nextController.error(error)
        }
      })()
    },
    cancel() { dropped = true; activeAgentSseDrops.delete(drop); return reader.cancel() },
  })
  return new Response(stream, { status: response.status, headers: response.headers })
}

async function fixtureRoute(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/__e2e/")) return null
  if (process.env.NODE_ENV !== "test") return new Response("not found", { status: 404 })
  if (request.method === "POST" && url.pathname === "/__e2e/drop-and-commit") {
    const body = await request.json().catch(() => null) as { conversationId?: string; content?: string } | null
    if (!body?.conversationId || !body.content?.trim()) return Response.json({ error: "missing_fields" }, { status: 400 })
    service.get(IDENTITY, body.conversationId)
    for (const drop of [...activeSseDrops.get(body.conversationId) ?? []]) drop()
    const result = service.appendAgentMessage({
      id: nextId(), conversationId: body.conversationId, author: "architect", origin: "agent",
      content: body.content, state: "completed", createdAt: now(),
    }, [])
    return Response.json(result.message, { status: 201 })
  }
  if (request.method === "POST" && url.pathname === "/__e2e/agents/drop-stream") {
    for (const drop of [...activeAgentSseDrops]) drop()
    return Response.json({ dropped: true })
  }
  if (request.method === "POST" && url.pathname === "/__e2e/agents/status") {
    const body = await request.json().catch(() => null) as { agent?: string; busy?: boolean; queueDepth?: number } | null
    if (!body?.agent || !AGENTS.includes(body.agent as typeof AGENTS[number]) || typeof body.busy !== "boolean" || !Number.isSafeInteger(body.queueDepth) || body.queueDepth! < 0) {
      return Response.json({ error: "invalid_status" }, { status: 400 })
    }
    agentStatuses = agentStatuses.map(status => status.name === body.agent
      ? { ...status, busy: body.busy!, queueDepth: body.queueDepth!, lastActivityMs: now() }
      : status)
    agentEvents.publish({ kind: "agent_changed", agent: "architect", ts: now() })
    agentEvents.publish({ kind: "agents_snapshot", ts: now() })
    return Response.json({ resetCount: actionCounts.reset, restartCount: actionCounts.restart, auditRows: auditRows.length })
  }
  return new Response("not found", { status: 404 })
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    const fixture = await fixtureRoute(request)
    if (fixture) return fixture
    const headers = new Headers(request.headers)
    headers.delete("x-switchboard-user")
    headers.set("x-switchboard-user", IDENTITY)
    const trusted = new Request(request, { headers })
    const response = await handleWebRequest(trusted, deps, assets)
    const pathname = new URL(request.url).pathname
    const eventMatch = /^\/api\/conversations\/([^/]+)\/events$/.exec(pathname)
    if (eventMatch) return droppableSse(response, decodeURIComponent(eventMatch[1]))
    return pathname === "/api/operations/agents/events" ? droppableAgentSse(response) : response
  },
})

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  for (const drops of [...activeSseDrops.values()]) for (const drop of [...drops]) drop()
  for (const drop of [...activeAgentSseDrops]) drop()
  await server.stop(true)
  db.close()
}
process.once("SIGINT", () => { void stop() })
process.once("SIGTERM", () => { void stop() })

console.log(`workspace E2E fixture listening on http://${HOST}:${PORT}`)
