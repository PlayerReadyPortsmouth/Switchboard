import { DASHBOARD_HTML, renderDashboardJson, type WebInput } from "./web"
import type { ChannelEvent } from "./channelStream"
import type { TraceRecord } from "./turnTrace"
import type { AgentConfig, HubConfig } from "./types"
import type { HubChangeClassification } from "./hubConfigDraft"
import { AgentOperationsError, type AgentOperationsService } from "./operations/agentService"
import type { AgentOperationsEvent } from "./operations/agentEvents"
import type { WorkspaceRole } from "./operations/access"
import { ApprovalOperationsError, type ApprovalAccessContext, type ApprovalOperationsService } from "./approvalService"
import type { ApprovalListQuery, ApprovalPrincipal } from "./approvalTypes"
import type { ApprovalOperationsEvent } from "./approvalEvents"
import type { Conversation, ConversationUpdate, Message, SyncMode, TransportLink } from "./conversations/types"
import type { ConversationEvent } from "./conversations/events"
import { ConversationForbiddenError, ConversationValidationError, MAX_MESSAGES_PAGE_SIZE } from "./conversations/service"
import { RepositoryConflictError, RepositoryNotFoundError, type AppendMessageResult } from "./conversations/repository"
import { createBuiltWorkspaceAssets, type WorkspaceAssetHandler } from "./webAssets"

export interface ChannelInfo { channelId: string; name?: string; agent: string }

export interface WebDeps {
  collect: () => WebInput
  requireUser: (req: Request) => string | null
  approvalOperations: Pick<ApprovalOperationsService, "session" | "list" | "get" | "decide" | "subscribe">
  listChannels: () => ChannelInfo[]
  fetchChannelHistory: (channelId: string) => Promise<ChannelEvent[]>
  fetchChannelTimeline: (channelId: string) => Promise<TraceRecord[]>
  subscribeChannel: (channelId: string, cb: (evt: ChannelEvent) => void) => () => void
  sendChannelMessage: (channelId: string, email: string, text: string) => Promise<void>
  runCommand: (name: string, channelId: string) => Promise<string | null>
  agentOperations: Pick<AgentOperationsService,
    "list" | "get" | "listLegacyConfigs" | "previewLegacyConfig" | "confirmLegacyConfig" |
    "previewConfig" | "confirmConfig" | "previewAction" | "confirmAction" | "subscribe">
  agentSessionAccess: (actor: string) => { feature: boolean; role: WorkspaceRole }
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
  updateConversation?: (identity: string, conversationId: string, input: ConversationUpdate) => Conversation
  archiveConversation?: (identity: string, conversationId: string) => Conversation
  appendConversationMessage?: (identity: string, conversationId: string, input: { content: string; clientKey: string; replyTo?: string }) => AppendMessageResult | Promise<AppendMessageResult>
  listConversationMessages?: (identity: string, conversationId: string, afterSequence?: number, limit?: number) => Message[]
  addConversationLink?: (identity: string, conversationId: string, input: { adapter: string; externalLocationId: string; label?: string | null; syncMode?: SyncMode; enabled?: boolean }) => TransportLink
  listConversationLinks?: (identity: string, conversationId: string) => TransportLink[]
  subscribeConversation?: (identity: string, conversationId: string, afterSequence: number, cb: (event: ConversationEvent) => void) => () => void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const approvalJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
})

const invalidApprovalRequest = (): ApprovalOperationsError =>
  new ApprovalOperationsError(400, "invalid_request", "none")

function approvalErrorResponse(error: unknown): Response {
  if (error instanceof ApprovalOperationsError) {
    return approvalJson({
      error: error.code,
      recovery: error.recovery,
      ...(error.status === 409 && error.canonical !== null ? { canonical: error.canonical } : {}),
    }, error.status)
  }
  if (error instanceof URIError) {
    return approvalJson({ error: "invalid_request", recovery: "none" }, 400)
  }
  return approvalJson({ error: "approval_unavailable", recovery: "reload" }, 500)
}

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

function agentOperationsSseResponse(subscribe: (cb: (event: AgentOperationsEvent) => void) => { unsubscribe(): void }): Response {
  let unsubscribe: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const subscription = subscribe(event => {
        controller.enqueue(encoder.encode(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`))
      })
      unsubscribe = () => subscription.unsubscribe()
    },
    cancel() { unsubscribe() },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

function safeApprovalEvent(event: ApprovalOperationsEvent): ApprovalOperationsEvent {
  if (event.kind === "approval_changed") {
    return {
      kind: event.kind,
      approvalId: event.approvalId,
      pendingCount: event.pendingCount,
      ts: event.ts,
      sequence: event.sequence,
    }
  }
  if (event.kind === "approvals_snapshot") {
    return {
      kind: event.kind,
      pendingCount: event.pendingCount,
      ts: event.ts,
      sequence: event.sequence,
    }
  }
  return {
    kind: event.kind,
    ...(event.pendingCount === undefined ? {} : { pendingCount: event.pendingCount }),
    ts: event.ts,
    sequence: event.sequence,
  }
}

function approvalOperationsSseResponse(
  subscribe: (cb: (event: ApprovalOperationsEvent) => void) => { unsubscribe(): void },
): Response {
  let unsubscribe: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const subscription = subscribe(event => {
        const safe = safeApprovalEvent(event)
        controller.enqueue(encoder.encode(`id: ${safe.sequence}\ndata: ${JSON.stringify(safe)}\n\n`))
      })
      unsubscribe = () => subscription.unsubscribe()
    },
    cancel() { unsubscribe() },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  })
}

const bodyJson = async (req: Request) => await req.json().catch(() => null) as Record<string, unknown> | null
const nonNegativeInteger = (value: string | null, fallback: number): number | null => {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const APPROVAL_QUERY_KEYS = new Set([
  "group", "state", "risk", "kind", "requester", "conversationId", "createdFrom", "createdTo",
  "decisionFrom", "decisionTo", "search", "cursor", "limit",
])
const APPROVAL_GROUPS = new Set(["pending", "history"])
const APPROVAL_STATES = new Set(["pending", "granted", "denied", "expired", "interrupted"])
const APPROVAL_RISKS = new Set(["low", "elevated", "destructive"])

function validateRawQueryEncoding(url: URL): void {
  if (url.search.length <= 1) return
  for (const pair of url.search.slice(1).split("&")) {
    const separator = pair.indexOf("=")
    const rawName = separator < 0 ? pair : pair.slice(0, separator)
    const rawValue = separator < 0 ? "" : pair.slice(separator + 1)
    decodeURIComponent(rawName.replace(/\+/g, " "))
    decodeURIComponent(rawValue.replace(/\+/g, " "))
  }
}

function approvalInteger(value: string, limit: boolean): number {
  const syntax = limit ? /^(?:0|[1-9][0-9]*)$/ : /^-?(?:0|[1-9][0-9]*)$/
  if (!syntax.test(value)) throw invalidApprovalRequest()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw invalidApprovalRequest()
  return parsed
}

function approvalListQuery(url: URL, defaultGroup?: "pending"): ApprovalListQuery {
  try {
    validateRawQueryEncoding(url)
  } catch (error) {
    if (error instanceof URIError) throw error
    throw invalidApprovalRequest()
  }
  const values = new Map<string, string>()
  for (const [key, value] of url.searchParams) {
    if (!APPROVAL_QUERY_KEYS.has(key) || values.has(key)) throw invalidApprovalRequest()
    values.set(key, value)
  }

  const group = values.get("group") ?? defaultGroup
  if (group === undefined || !APPROVAL_GROUPS.has(group)) throw invalidApprovalRequest()
  const state = values.get("state")
  if (state !== undefined && (!APPROVAL_STATES.has(state)
    || (group === "pending" && state !== "pending")
    || (group === "history" && state === "pending"))) {
    throw invalidApprovalRequest()
  }
  const risk = values.get("risk")
  if (risk !== undefined && !APPROVAL_RISKS.has(risk)) throw invalidApprovalRequest()
  const requester = values.get("requester")
  if (requester !== undefined) {
    const separator = requester.indexOf(":")
    if (separator <= 0 || separator === requester.length - 1
      || !/^[a-z0-9_-]+$/.test(requester.slice(0, separator))) {
      throw invalidApprovalRequest()
    }
  }

  const nonEmpty = (key: string): string | undefined => {
    const value = values.get(key)
    if (value !== undefined && value.length === 0) throw invalidApprovalRequest()
    return value
  }
  const createdFrom = values.has("createdFrom") ? approvalInteger(values.get("createdFrom")!, false) : undefined
  const createdTo = values.has("createdTo") ? approvalInteger(values.get("createdTo")!, false) : undefined
  const decisionFrom = values.has("decisionFrom") ? approvalInteger(values.get("decisionFrom")!, false) : undefined
  const decisionTo = values.has("decisionTo") ? approvalInteger(values.get("decisionTo")!, false) : undefined
  if (createdFrom !== undefined && createdTo !== undefined && createdFrom > createdTo) throw invalidApprovalRequest()
  if (decisionFrom !== undefined && decisionTo !== undefined && decisionFrom > decisionTo) throw invalidApprovalRequest()
  const limit = values.has("limit") ? approvalInteger(values.get("limit")!, true) : undefined
  if (limit !== undefined && (limit < 1 || limit > 100)) throw invalidApprovalRequest()

  return {
    group: group as "pending" | "history",
    ...(state === undefined ? {} : { state: state as ApprovalListQuery["state"] }),
    ...(risk === undefined ? {} : { risk: risk as ApprovalListQuery["risk"] }),
    ...(nonEmpty("kind") === undefined ? {} : { kind: values.get("kind")! }),
    ...(requester === undefined ? {} : { requester }),
    ...(nonEmpty("conversationId") === undefined ? {} : { conversationId: values.get("conversationId")! }),
    ...(createdFrom === undefined ? {} : { createdFrom }),
    ...(createdTo === undefined ? {} : { createdTo }),
    ...(decisionFrom === undefined ? {} : { decisionFrom }),
    ...(decisionTo === undefined ? {} : { decisionTo }),
    ...(nonEmpty("search") === undefined ? {} : { search: values.get("search")! }),
    ...(nonEmpty("cursor") === undefined ? {} : { cursor: values.get("cursor")! }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function requireApprovalAccess(
  operations: WebDeps["approvalOperations"],
  principal: ApprovalPrincipal,
  context: Exclude<ApprovalAccessContext, "adapter">,
): void {
  const access = operations.session(principal, context)
  const visible = access.role !== "hidden"
    && (context === "workspace" ? access.feature : access.coreEnabled)
  if (!visible) throw new ApprovalOperationsError(404, "not_found", "none")
}

/** Route a workspace/legacy dashboard/API request. Workspace GETs and
 *  `GET /api/status` are unauthenticated; every guarded API route requires the
 *  configured trusted identity header (via `deps.requireUser`) and is otherwise
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
  const approvalsMatch = path === "/api/approvals"
  const approvalDecisionMatch = /^\/api\/approvals\/([^/]+)$/.exec(path)
  const operationsApprovalsMatch = path === "/api/operations/approvals"
  const operationsApprovalEventsMatch = path === "/api/operations/approvals/events"
  const operationsApprovalDecisionMatch = /^\/api\/operations\/approvals\/([^/]+)\/decision$/.exec(path)
  const operationsApprovalDetailMatch = /^\/api\/operations\/approvals\/([^/]+)$/.exec(path)
  const isApprovalRoute = approvalsMatch || approvalDecisionMatch || operationsApprovalsMatch
    || operationsApprovalEventsMatch || operationsApprovalDecisionMatch || operationsApprovalDetailMatch
  const channelHistoryMatch = /^\/api\/channel\/([^/]+)\/history$/.exec(path)
  const channelTimelineMatch = /^\/api\/channel\/([^/]+)\/timeline$/.exec(path)
  const channelStreamMatch = /^\/api\/channel\/([^/]+)\/stream$/.exec(path)
  const channelMessageMatch = /^\/api\/channel\/([^/]+)\/message$/.exec(path)
  const commandMatch = /^\/api\/command\/([^/]+)$/.exec(path)
  const agentsMatch = path === "/api/agents"
  const agentPreviewMatch = /^\/api\/agents\/([^/]+)\/preview$/.exec(path)
  const agentConfirmMatch = /^\/api\/agents\/([^/]+)\/confirm$/.exec(path)
  const operationsAgentsMatch = path === "/api/operations/agents"
  const operationsAgentEventsMatch = path === "/api/operations/agents/events"
  const operationsAgentDetailMatch = /^\/api\/operations\/agents\/([^/]+)$/.exec(path)
  const operationsAgentConfigPreviewMatch = /^\/api\/operations\/agents\/([^/]+)\/config\/preview$/.exec(path)
  const operationsAgentConfigConfirmMatch = /^\/api\/operations\/agents\/([^/]+)\/config\/confirm$/.exec(path)
  const operationsAgentActionPreviewMatch = /^\/api\/operations\/agents\/([^/]+)\/actions\/preview$/.exec(path)
  const operationsAgentActionConfirmMatch = /^\/api\/operations\/agents\/([^/]+)\/actions\/confirm$/.exec(path)
  const hubConfigMatch = path === "/api/hub-config"
  const hubConfigPreviewMatch = path === "/api/hub-config/preview"
  const hubConfigConfirmMatch = path === "/api/hub-config/confirm"
  const conversationsMatch = path === "/api/conversations"
  const sessionMatch = path === "/api/session"
  const conversationItemMatch = /^\/api\/conversations\/([^/]+)$/.exec(path)
  const conversationMessagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path)
  const conversationEventsMatch = /^\/api\/conversations\/([^/]+)\/events$/.exec(path)
  const conversationLinksMatch = /^\/api\/conversations\/([^/]+)\/links$/.exec(path)
  const isGuardedRoute = path === "/api/channels" || isApprovalRoute || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch ||
    agentsMatch || agentPreviewMatch || agentConfirmMatch || operationsAgentsMatch || operationsAgentEventsMatch ||
    operationsAgentDetailMatch || operationsAgentConfigPreviewMatch || operationsAgentConfigConfirmMatch ||
    operationsAgentActionPreviewMatch || operationsAgentActionConfirmMatch ||
    hubConfigMatch || hubConfigPreviewMatch || hubConfigConfirmMatch || sessionMatch || conversationsMatch ||
    conversationItemMatch || conversationMessagesMatch || conversationEventsMatch || conversationLinksMatch

  if (isGuardedRoute) {
    // Auth runs before method dispatch below, so a wrong-method request without
    // the identity header returns 400 (missing_identity) rather than 405 — intentional,
    // so an unauthenticated caller can't probe which methods/routes exist.
    const email = deps.requireUser(req)
    if (!email) {
      return isApprovalRoute
        ? approvalJson({ error: "missing_identity" }, 400)
        : json({ error: "missing_identity" }, 400)
    }

    if (sessionMatch && method === "GET") {
      try {
        const agentAccess = deps.agentSessionAccess(email)
        const approvalAccess = deps.approvalOperations.session({ surface: "web", id: email }, "workspace")
        return approvalJson({
          identity: email,
          agents: deps.collect().status.agents.filter(({ mode }) => mode === "persistent").map(({ name, alive, busy }) => ({ name, alive, busy })),
          features: { agents: agentAccess.feature, approvals: approvalAccess.feature },
          permissions: { agents: agentAccess.role, approvals: approvalAccess.role },
          approvalState: {
            producing: approvalAccess.coreEnabled,
            canDecide: approvalAccess.canDecide,
            pendingCount: approvalAccess.feature && approvalAccess.role !== "hidden"
              ? approvalAccess.pendingCount
              : 0,
          },
        })
      } catch (error) {
        return approvalErrorResponse(error)
      }
    }

    const conversationAction = (conversationsMatch && (method === "GET" || method === "POST")) ||
      (conversationItemMatch && (method === "GET" || method === "PATCH" || method === "DELETE")) ||
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
      if (conversationItemMatch && method === "PATCH") {
        if (!deps.updateConversation) return json({ error: "conversation_service_unavailable" }, 503)
        const body = await bodyJson(req)
        if (!body || (body.title === undefined && body.primaryAgent === undefined) ||
          (body.title !== undefined && typeof body.title !== "string") ||
          (body.primaryAgent !== undefined && typeof body.primaryAgent !== "string")) return json({ error: "missing_fields" }, 400)
        return json(deps.updateConversation!(email, decodeId(conversationItemMatch), {
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.primaryAgent === "string" ? { primaryAgent: body.primaryAgent } : {}),
        }))
      }
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

    if (isApprovalRoute) {
      const principal: ApprovalPrincipal = { surface: "web", id: email }
      try {
        if (method === "GET" && operationsApprovalEventsMatch) {
          requireApprovalAccess(deps.approvalOperations, principal, "workspace")
          validateRawQueryEncoding(url)
          for (const key of url.searchParams.keys()) {
            if (key !== "after") throw invalidApprovalRequest()
          }
          if (url.searchParams.getAll("after").length > 1) throw invalidApprovalRequest()
          const cursorText = url.searchParams.has("after")
            ? url.searchParams.get("after")
            : req.headers.get("last-event-id")
          const after = nonNegativeInteger(cursorText, 0)
          if (after === null) throw invalidApprovalRequest()
          return approvalOperationsSseResponse(callback => deps.approvalOperations.subscribe(after, callback))
        }

        if (method === "GET" && operationsApprovalsMatch) {
          requireApprovalAccess(deps.approvalOperations, principal, "workspace")
          return approvalJson(deps.approvalOperations.list(
            principal,
            "workspace",
            approvalListQuery(url),
          ))
        }
        if (method === "GET" && approvalsMatch) {
          requireApprovalAccess(deps.approvalOperations, principal, "legacy")
          return approvalJson(deps.approvalOperations.list(
            principal,
            "legacy",
            approvalListQuery(url, "pending"),
          ))
        }

        if (method === "POST" && (operationsApprovalDecisionMatch || approvalDecisionMatch)) {
          const context = operationsApprovalDecisionMatch ? "workspace" : "legacy"
          const match = operationsApprovalDecisionMatch ?? approvalDecisionMatch!
          requireApprovalAccess(deps.approvalOperations, principal, context)
          const approvalId = decodeURIComponent(match[1])
          // Establish resource visibility before parsing attacker-controlled body fields.
          const approval = deps.approvalOperations.get(principal, context, approvalId)
          if (!approval.permissions.canDecide) {
            // The service authorizes and audits before it validates version/key. Empty sentinels
            // preserve that service-owned evidence without permitting a mutation if access changes
            // between this projection and the authorization probe.
            try {
              await deps.approvalOperations.decide(principal, context, {
                approvalId,
                decision: "grant",
                expectedVersion: "",
                idempotencyKey: "",
              })
            } catch (error) {
              if (!(error instanceof ApprovalOperationsError) || error.status !== 400) throw error
            }
            throw new ApprovalOperationsError(403, "forbidden", "none")
          }
          const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
          if (contentType !== "application/json") throw invalidApprovalRequest()
          const idempotencyKey = req.headers.get("idempotency-key")
          if (idempotencyKey === null || idempotencyKey.trim().length === 0) throw invalidApprovalRequest()
          const body = await bodyJson(req)
          if ((body?.decision !== "grant" && body?.decision !== "deny")
            || typeof body.expectedVersion !== "string" || body.expectedVersion.trim().length === 0) {
            throw invalidApprovalRequest()
          }
          return approvalJson(await deps.approvalOperations.decide(principal, context, {
            approvalId,
            decision: body.decision,
            expectedVersion: body.expectedVersion,
            idempotencyKey,
          }))
        }

        if (method === "GET" && operationsApprovalDetailMatch) {
          requireApprovalAccess(deps.approvalOperations, principal, "workspace")
          return approvalJson(deps.approvalOperations.get(
            principal,
            "workspace",
            decodeURIComponent(operationsApprovalDetailMatch[1]),
          ))
        }

        return new Response("method", { status: 405, headers: { "cache-control": "no-store" } })
      } catch (error) {
        return approvalErrorResponse(error)
      }
    }

    if (method === "GET" && path === "/api/channels") return json(deps.listChannels())

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

    try {
      const decodeAgent = (match: RegExpExecArray): string => decodeURIComponent(match[1])

      if (method === "GET" && agentsMatch) return json(deps.agentOperations.listLegacyConfigs(email))
      if (method === "POST" && agentPreviewMatch) {
        const body = (await req.json().catch(() => null)) as { config?: AgentConfig | null } | null
        if (body?.config === undefined) return json({ error: "missing_config" }, 400)
        return json(await deps.agentOperations.previewLegacyConfig(email, decodeAgent(agentPreviewMatch), body.config))
      }
      if (method === "POST" && agentConfirmMatch) {
        const body = (await req.json().catch(() => null)) as { id?: string; hard?: boolean } | null
        if (!body?.id) return json({ error: "missing_id" }, 400)
        return json(await deps.agentOperations.confirmLegacyConfig(email, decodeAgent(agentConfirmMatch), body.id, body.hard === true))
      }

      if (method === "GET" && operationsAgentsMatch) return json(deps.agentOperations.list(email))
      if (method === "GET" && operationsAgentEventsMatch) {
        const cursorText = url.searchParams.has("after") ? url.searchParams.get("after") : req.headers.get("last-event-id")
        const after = nonNegativeInteger(cursorText, 0)
        if (after === null) return json({ error: "invalid_after" }, 400)
        deps.agentOperations.list(email)
        return agentOperationsSseResponse(callback => deps.agentOperations.subscribe(after, callback))
      }
      if (method === "GET" && operationsAgentDetailMatch) {
        return json(deps.agentOperations.get(email, decodeAgent(operationsAgentDetailMatch)))
      }
      if (method === "POST" && operationsAgentConfigPreviewMatch) {
        const body = await bodyJson(req)
        if (body?.config === undefined) return json({ error: "missing_config" }, 400)
        if (body.expectedVersion === undefined) return json({ error: "missing_expected_version" }, 400)
        if (typeof body.expectedVersion !== "string" || body.expectedVersion.trim() === "") return json({ error: "invalid_expected_version" }, 400)
        return json(await deps.agentOperations.previewConfig(email, decodeAgent(operationsAgentConfigPreviewMatch), body.config as AgentConfig | null, body.expectedVersion))
      }
      if (method === "POST" && operationsAgentConfigConfirmMatch) {
        const body = await bodyJson(req)
        if (typeof body?.id !== "string" || !body.id) return json({ error: "missing_id" }, 400)
        return json(await deps.agentOperations.confirmConfig(email, decodeAgent(operationsAgentConfigConfirmMatch), body.id, body.hard === true))
      }
      if (method === "POST" && operationsAgentActionPreviewMatch) {
        const body = await bodyJson(req)
        if (body?.action !== "reset" && body?.action !== "restart") return json({ error: "invalid_action" }, 400)
        return json(deps.agentOperations.previewAction(email, decodeAgent(operationsAgentActionPreviewMatch), body.action))
      }
      if (method === "POST" && operationsAgentActionConfirmMatch) {
        const body = await bodyJson(req)
        if (typeof body?.id !== "string" || !body.id) return json({ error: "missing_id" }, 400)
        const idempotencyKey = req.headers.get("idempotency-key")
        if (!idempotencyKey) return json({ error: "missing_idempotency_key" }, 400)
        return json(await deps.agentOperations.confirmAction(email, decodeAgent(operationsAgentActionConfirmMatch), body.id, idempotencyKey))
      }
    } catch (error) {
      if (error instanceof AgentOperationsError) return json({ error: error.code }, error.status)
      if (error instanceof URIError) return json({ error: "malformed_agent_name" }, 400)
      throw error
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
