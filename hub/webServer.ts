import { DASHBOARD_HTML, renderDashboardJson, type WebInput } from "./web"
import type { ChannelEvent } from "./channelStream"
import type { TraceRecord } from "./turnTrace"
import type { AgentConfig, HubConfig } from "./types"
import type { AgentChangeClassification } from "./agentConfigDraft"
import type { HubChangeClassification } from "./hubConfigDraft"
import type { Conversation, Message, SyncMode, TransportLink } from "./conversations/types"
import type { ConversationEvent } from "./conversations/events"
import { ConversationForbiddenError, ConversationValidationError, MAX_MESSAGES_PAGE_SIZE } from "./conversations/service"
import { RepositoryConflictError, RepositoryNotFoundError, type AppendMessageResult } from "./conversations/repository"
import { createBuiltWorkspaceAssets, type WorkspaceAssetHandler } from "./webAssets"

export interface ChannelInfo { channelId: string; name?: string; agent: string }

export interface WebDeps {
  collect: () => WebInput
  requireUser: (req: Request) => string | null
  resolveApproval: (id: string, decision: "grant" | "deny", actor: string) => Promise<"granted" | "denied" | "not_found">
  listChannels: () => ChannelInfo[]
  fetchChannelHistory: (channelId: string) => Promise<ChannelEvent[]>
  fetchChannelTimeline: (channelId: string) => Promise<TraceRecord[]>
  subscribeChannel: (channelId: string, cb: (evt: ChannelEvent) => void) => () => void
  sendChannelMessage: (channelId: string, email: string, text: string) => Promise<void>
  runCommand: (name: string, channelId: string) => Promise<string | null>
  listAgents: () => Promise<Record<string, AgentConfig>>
  previewAgentChange: (name: string, config: AgentConfig | null) => Promise<{
    id: string; before: AgentConfig | null; after: AgentConfig | null; classification: AgentChangeClassification
  } | { error: string }>
  confirmAgentChange: (name: string, id: string, hard: boolean, actor: string) => Promise<{
    state: "applied" | "not_found" | "conflict"; restarted: string[]; fullRestart: string[]
  }>
  listHubConfig: () => Promise<Partial<HubConfig>>
  previewHubConfigChange: (config: HubConfig) => Promise<{
    id: string; before: Partial<HubConfig>; after: Partial<HubConfig>; classification: HubChangeClassification
  } | { error: string }>
  confirmHubConfigChange: (id: string, actor: string) => Promise<{
    state: "applied" | "not_found" | "conflict"; fullRestart: string[]
  }>
  createConversation?: (identity: string, input: { title: string; primaryAgent: string }) => Conversation
  listConversations?: (identity: string, includeArchived?: boolean) => Conversation[]
  getConversation?: (identity: string, conversationId: string) => Conversation
  archiveConversation?: (identity: string, conversationId: string) => Conversation
  appendConversationMessage?: (identity: string, conversationId: string, input: { content: string; clientKey: string; replyTo?: string }) => AppendMessageResult | Promise<AppendMessageResult>
  listConversationMessages?: (identity: string, conversationId: string, afterSequence?: number, limit?: number) => Message[]
  addConversationLink?: (identity: string, conversationId: string, input: { adapter: string; externalLocationId: string; label?: string | null; syncMode?: SyncMode; enabled?: boolean }) => TransportLink
  listConversationLinks?: (identity: string, conversationId: string) => TransportLink[]
  subscribeConversation?: (identity: string, conversationId: string, afterSequence: number, cb: (event: ConversationEvent) => void) => () => void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function sseResponse(subscribe: (cb: (evt: ChannelEvent) => void) => () => void): Response {
  let unsubscribe: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      unsubscribe = subscribe((evt) => controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`)))
    },
    cancel() { unsubscribe() },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

function conversationSseResponse(subscribe: (cb: (event: ConversationEvent) => void) => () => void): Response {
  let unsubscribe: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      unsubscribe = subscribe(event => controller.enqueue(enc.encode(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)))
    },
    cancel() { unsubscribe() },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

const bodyJson = async (req: Request) => await req.json().catch(() => null) as Record<string, unknown> | null
const nonNegativeInteger = (value: string | null, fallback: number): number | null => {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Route a workspace/legacy dashboard/API request. Workspace GETs and
 *  `GET /api/status` are unauthenticated; every guarded API route requires the
 *  X-Switchboard-User identity header (via `deps.requireUser`) and is otherwise
 *  404 (unknown path) or 405 (known path, wrong method). Async — several routes
 *  await injected deps (approval resolution, channel I/O, command execution). */
export async function handleWebRequest(
  req: Request,
  deps: WebDeps,
  workspaceAssets: WorkspaceAssetHandler = async () => null,
): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  if (method === "GET" && path === "/legacy/") {
    return Response.redirect(new URL("/legacy", req.url), 308)
  }
  if (method === "GET" && path === "/legacy") {
    return new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (method === "GET" && !path.startsWith("/api/")) {
    return await workspaceAssets(path) ?? new Response("workspace_not_built", { status: 503 })
  }
  if (method === "GET" && path === "/api/status") {
    return json(renderDashboardJson(deps.collect()))
  }
  // `/` and `/api/status` only support GET above — any other method on those
  // exact paths is a known route used wrong (405), not an unknown route (404).
  if (path === "/" || path === "/api/status") return new Response("method", { status: 405 })

  // Every route below requires the identity header the ReadyApp proxy sets.
  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path)
  const channelHistoryMatch = /^\/api\/channel\/([^/]+)\/history$/.exec(path)
  const channelTimelineMatch = /^\/api\/channel\/([^/]+)\/timeline$/.exec(path)
  const channelStreamMatch = /^\/api\/channel\/([^/]+)\/stream$/.exec(path)
  const channelMessageMatch = /^\/api\/channel\/([^/]+)\/message$/.exec(path)
  const commandMatch = /^\/api\/command\/([^/]+)$/.exec(path)
  const agentsMatch = path === "/api/agents"
  const agentPreviewMatch = /^\/api\/agents\/([^/]+)\/preview$/.exec(path)
  const agentConfirmMatch = /^\/api\/agents\/([^/]+)\/confirm$/.exec(path)
  const hubConfigMatch = path === "/api/hub-config"
  const hubConfigPreviewMatch = path === "/api/hub-config/preview"
  const hubConfigConfirmMatch = path === "/api/hub-config/confirm"
  const conversationsMatch = path === "/api/conversations"
  const conversationItemMatch = /^\/api\/conversations\/([^/]+)$/.exec(path)
  const conversationMessagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path)
  const conversationEventsMatch = /^\/api\/conversations\/([^/]+)\/events$/.exec(path)
  const conversationLinksMatch = /^\/api\/conversations\/([^/]+)\/links$/.exec(path)
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch ||
    agentsMatch || agentPreviewMatch || agentConfirmMatch ||
    hubConfigMatch || hubConfigPreviewMatch || hubConfigConfirmMatch || conversationsMatch ||
    conversationItemMatch || conversationMessagesMatch || conversationEventsMatch || conversationLinksMatch

  if (isGuardedRoute) {
    // Auth runs before method dispatch below, so a wrong-method request without
    // the identity header returns 400 (missing_identity) rather than 405 — intentional,
    // so an unauthenticated caller can't probe which methods/routes exist.
    const email = deps.requireUser(req)
    if (!email) return json({ error: "missing_identity" }, 400)

    const conversationAction = (conversationsMatch && (method === "GET" || method === "POST")) ||
      (conversationItemMatch && (method === "GET" || method === "DELETE")) ||
      (conversationMessagesMatch && (method === "GET" || method === "POST")) ||
      (conversationEventsMatch && method === "GET") || (conversationLinksMatch && (method === "GET" || method === "POST"))
    if (conversationAction && (!deps.createConversation || !deps.listConversations || !deps.getConversation ||
      !deps.archiveConversation || !deps.appendConversationMessage || !deps.listConversationMessages ||
      !deps.addConversationLink || !deps.listConversationLinks || !deps.subscribeConversation)) {
      return json({ error: "conversation_service_unavailable" }, 503)
    }

    try {
      if (conversationsMatch && method === "GET") {
        const includeArchived = url.searchParams.get("includeArchived")
        if (includeArchived !== null && includeArchived !== "true" && includeArchived !== "false") return json({ error: "invalid_includeArchived" }, 400)
        return json(deps.listConversations!(email, includeArchived === "true"))
      }
      if (conversationsMatch && method === "POST") {
        const body = await bodyJson(req)
        if (typeof body?.title !== "string" || typeof body?.primaryAgent !== "string") return json({ error: "missing_fields" }, 400)
        return json(deps.createConversation!(email, { title: body.title, primaryAgent: body.primaryAgent }), 201)
      }

      const decodeId = (match: RegExpExecArray) => decodeURIComponent(match[1])
      if (conversationItemMatch && method === "GET") return json(deps.getConversation!(email, decodeId(conversationItemMatch)))
      if (conversationItemMatch && method === "DELETE") return json(deps.archiveConversation!(email, decodeId(conversationItemMatch)))

      if (conversationMessagesMatch && method === "GET") {
        const after = nonNegativeInteger(url.searchParams.get("after"), 0)
        const limit = nonNegativeInteger(url.searchParams.get("limit"), 100)
        if (after === null || limit === null || limit < 1 || limit > MAX_MESSAGES_PAGE_SIZE) return json({ error: "invalid_cursor" }, 400)
        return json(deps.listConversationMessages!(email, decodeId(conversationMessagesMatch), after, limit))
      }
      if (conversationMessagesMatch && method === "POST") {
        const body = await bodyJson(req)
        const clientKey = req.headers.get("idempotency-key") ?? (typeof body?.clientKey === "string" ? body.clientKey : null)
        if (typeof body?.content !== "string" || !clientKey || (body.replyTo !== undefined && typeof body.replyTo !== "string")) return json({ error: "missing_fields" }, 400)
        const conversationId = decodeId(conversationMessagesMatch)
        const result = await deps.appendConversationMessage!(email, conversationId, { content: body.content, clientKey, ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}) })
        return json(result.message, result.inserted ? 201 : 200)
      }

      if (conversationLinksMatch && method === "GET") return json(deps.listConversationLinks!(email, decodeId(conversationLinksMatch)))
      if (conversationLinksMatch && method === "POST") {
        const body = await bodyJson(req)
        if (typeof body?.adapter !== "string" || typeof body?.externalLocationId !== "string" || !body.adapter.trim() || !body.externalLocationId.trim()) return json({ error: "missing_fields" }, 400)
        const syncModes = ["two_way", "inbound_only", "outbound_only", "notifications_only"]
        if (body.syncMode !== undefined && (typeof body.syncMode !== "string" || !syncModes.includes(body.syncMode))) return json({ error: "invalid_syncMode" }, 400)
        if (body.label !== undefined && body.label !== null && typeof body.label !== "string") return json({ error: "invalid_label" }, 400)
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") return json({ error: "invalid_enabled" }, 400)
        return json(deps.addConversationLink!(email, decodeId(conversationLinksMatch), { ...(body as { adapter: string; externalLocationId: string; label?: string | null; syncMode?: SyncMode; enabled?: boolean }), adapter: body.adapter.trim(), externalLocationId: body.externalLocationId.trim() }), 201)
      }

      if (conversationEventsMatch && method === "GET") {
        const cursorText = url.searchParams.has("after") ? url.searchParams.get("after") : req.headers.get("last-event-id")
        const after = nonNegativeInteger(cursorText, 0)
        if (after === null) return json({ error: "invalid_after" }, 400)
        return conversationSseResponse(cb => deps.subscribeConversation!(email, decodeId(conversationEventsMatch), after, cb))
      }
    } catch (error) {
      if (error instanceof ConversationForbiddenError) return json({ error: error.message }, 403)
      if (error instanceof RepositoryNotFoundError) return json({ error: error.message }, 404)
      if (error instanceof RepositoryConflictError) return json({ error: error.message }, 409)
      if (error instanceof ConversationValidationError || error instanceof URIError) return json({ error: error.message }, 400)
      throw error
    }

    if (method === "GET" && path === "/api/channels") return json(deps.listChannels())

    if (method === "POST" && approvalMatch) {
      const body = (await req.json().catch(() => null)) as { decision?: "grant" | "deny" } | null
      if (body?.decision !== "grant" && body?.decision !== "deny") return json({ error: "bad_decision" }, 400)
      const state = await deps.resolveApproval(approvalMatch[1], body.decision, email)
      return state === "not_found" ? json({ state }, 409) : json({ state })
    }

    if (method === "GET" && channelHistoryMatch) {
      return json(await deps.fetchChannelHistory(channelHistoryMatch[1]))
    }

    if (method === "GET" && channelTimelineMatch) {
      return json(await deps.fetchChannelTimeline(channelTimelineMatch[1]))
    }

    if (method === "GET" && channelStreamMatch) {
      return sseResponse((cb) => deps.subscribeChannel(channelStreamMatch[1], cb))
    }

    if (method === "POST" && channelMessageMatch) {
      const body = (await req.json().catch(() => null)) as { text?: string } | null
      if (!body?.text) return json({ error: "missing_text" }, 400)
      await deps.sendChannelMessage(channelMessageMatch[1], email, body.text)
      return json({ ok: true })
    }

    if (method === "POST" && commandMatch) {
      const body = (await req.json().catch(() => null)) as { channelId?: string } | null
      if (!body?.channelId) return json({ error: "missing_channelId" }, 400)
      const text = await deps.runCommand(commandMatch[1], body.channelId)
      return text === null ? json({ error: "unknown_command" }, 404) : json({ text })
    }

    if (method === "GET" && agentsMatch) {
      return json(await deps.listAgents())
    }

    if (method === "POST" && agentPreviewMatch) {
      const body = (await req.json().catch(() => null)) as { config?: AgentConfig | null } | null
      if (body?.config === undefined) return json({ error: "missing_config" }, 400)
      const preview = await deps.previewAgentChange(agentPreviewMatch[1], body.config)
      return "error" in preview ? json(preview, 400) : json(preview)
    }

    if (method === "POST" && agentConfirmMatch) {
      const body = (await req.json().catch(() => null)) as { id?: string; hard?: boolean } | null
      if (!body?.id) return json({ error: "missing_id" }, 400)
      const result = await deps.confirmAgentChange(agentConfirmMatch[1], body.id, body.hard === true, email)
      return result.state === "applied" ? json(result) : json(result, 409)
    }

    if (method === "GET" && hubConfigMatch) {
      return json(await deps.listHubConfig())
    }

    if (method === "POST" && hubConfigPreviewMatch) {
      const body = (await req.json().catch(() => null)) as { config?: HubConfig } | null
      if (!body?.config) return json({ error: "missing_config" }, 400)
      const preview = await deps.previewHubConfigChange(body.config)
      return "error" in preview ? json(preview, 400) : json(preview)
    }

    if (method === "POST" && hubConfigConfirmMatch) {
      const body = (await req.json().catch(() => null)) as { id?: string } | null
      if (!body?.id) return json({ error: "missing_id" }, 400)
      const result = await deps.confirmHubConfigChange(body.id, email)
      return result.state === "applied" ? json(result) : json(result, 409)
    }

    // Known guarded path, but wrong method for it.
    return new Response("method", { status: 405 })
  }

  return new Response("not found", { status: 404 })
}

/** Start the dashboard/API listener on `port`; returns an async stop fn, or null (no-op)
 *  when `port` is unset — off by default. Binds `host` (default 127.0.0.1 —
 *  loopback-only unless an operator opts in). */
export function startWebServer(port: number, deps: WebDeps, host = "127.0.0.1"): { stopAccepting: () => void; stop: () => Promise<void> } | null {
  if (!port) return null
  const workspaceAssets = createBuiltWorkspaceAssets()
  const server = Bun.serve({ port, hostname: host, fetch: (req) => handleWebRequest(req, deps, workspaceAssets) })
  let stopping: Promise<void> | undefined
  return {
    stopAccepting: () => { stopping ??= server.stop(false) },
    stop: async () => { await (stopping ??= server.stop(true)) },
  }
}
