import { DASHBOARD_HTML, renderDashboardJson, type WebInput } from "./web"
import type { ChannelEvent } from "./channelStream"
import type { TraceRecord } from "./turnTrace"
import type { AgentConfig, HubConfig } from "./types"
import type { HubChangeClassification } from "./hubConfigDraft"
import { AgentOperationsError, type AgentOperationsService } from "./operations/agentService"
import type { AgentOperationsEvent } from "./operations/agentEvents"
import type { WorkspaceRole } from "./operations/access"
import type { Conversation, ConversationUpdate, Message, SyncMode, TransportLink } from "./conversations/types"
import type { AttachmentInfo, CardInfo, ConversationEvent } from "./conversations/events"
import type { WebInteractionResult } from "./webInteraction"
import { ConversationForbiddenError, ConversationValidationError, MAX_MESSAGES_PAGE_SIZE } from "./conversations/service"
import { RepositoryConflictError, RepositoryNotFoundError, type AppendMessageResult } from "./conversations/repository"
import { createBuiltWorkspaceAssets, type WorkspaceAssetHandler } from "./webAssets"
import type { DocumentContentResult, DocumentRow } from "./documents"
import type { PublishResult } from "./publishLink"

/** Result of an owner-gated document mutation (visibility change / delete). */
export type DocumentMutationResult = { ok: true } | { ok: false; reason: string }

/** Content types the in-app viewer may receive under their own type. Everything else — HTML,
 *  SVG, unknown binaries — is forced to an octet-stream attachment. The ReadyApp `/share`
 *  renderer can afford a broader set because it serves into a sandboxed document; this endpoint
 *  serves onto the workspace origin, so an executable type here would be same-origin XSS. */
const INLINE_DOCUMENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf", "text/plain", "text/markdown", "text/csv",
])

/** Quote/control characters would let a filename break out of the Content-Disposition header. */
const headerFilename = (filename: string): string => filename.replace(/[^\w.\- ]+/g, "_") || "document"

function documentContentResponse(row: DocumentRow, bytes: Buffer): Response {
  const inline = INLINE_DOCUMENT_TYPES.has(row.contentType)
  const contentType = !inline ? "application/octet-stream"
    : row.contentType.startsWith("text/") ? `${row.contentType}; charset=utf-8`
    : row.contentType
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${headerFilename(row.filename)}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  })
}

/** Map a card-interaction outcome onto HTTP. A denial is 403 with its legible reason; an
 *  undeliverable click is 409 (the request was authorised, the target is gone) so the client
 *  can tell "you may not" from "nobody is listening" and say so. */
/** The one mapping from a conversation-domain throw onto HTTP, shared by every conversation
 *  route so none of them can drift. Returns null for anything it does not recognise — the
 *  caller rethrows, which is the existing contract for a genuinely unexpected error. */
function conversationErrorResponse(error: unknown): Response | null {
  if (error instanceof ConversationForbiddenError) return json({ error: error.message }, 403)
  if (error instanceof RepositoryNotFoundError) return json({ error: error.message }, 404)
  if (error instanceof RepositoryConflictError) return json({ error: error.message }, 409)
  if (error instanceof ConversationValidationError || error instanceof URIError) return json({ error: error.message }, 400)
  return null
}

function cardInteractionResponse(result: WebInteractionResult): Response {
  switch (result.status) {
    case "ok": return json({ status: "ok" })
    case "modal": return json({ status: "modal", modal: result.modal })
    case "handled": return json({ status: "handled", action: result.action })
    case "unroutable": return json({ error: "unroutable", reason: result.reason }, 409)
    case "denied":
      return json({ error: result.error, reason: result.reason }, result.error === "web_cards_disabled" ? 503 : 403)
  }
}

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
  listDocuments?: (identity: string, scope: "mine" | "org") => DocumentRow[]
  /** Rehydrates the transcript's attachment cards on load — see `listConversationDocuments`
   *  in hub/documents.ts for why the live `attachment` events aren't enough on their own. */
  listConversationDocuments?: (identity: string, conversationId: string) => AttachmentInfo[]
  uploadDocument?: (identity: string, input: { filename: string; bytes: Buffer; title?: string; visibility?: "private" | "org" }) => Promise<PublishResult>
  setDocumentVisibility?: (identity: string, token: string, visibility: "private" | "org") => Promise<DocumentMutationResult>
  deleteDocument?: (identity: string, token: string) => Promise<DocumentMutationResult>
  readDocumentContent?: (identity: string, token: string) => DocumentContentResult
  documentsUiEnabled?: () => boolean
  turnStepsEnabled?: () => boolean
  /** Rehydrates the transcript's interactive cards on load. The live `card` events are
   *  live-only (like `attachment`), so without this a reload loses every card — the exact
   *  bug attachments shipped with. Enforces conversation membership. */
  listConversationCards?: (identity: string, conversationId: string) => CardInfo[]
  /** A web card click. Resolves the caller's identity to a Discord snowflake and runs the
   *  SAME gates as the Discord path — see hub/webInteraction.ts. */
  submitCardInteraction?: (identity: string, conversationId: string, input: { customId: string; fields?: Record<string, string> }) => WebInteractionResult
  webCardsEnabled?: () => boolean
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

const bodyJson = async (req: Request) => await req.json().catch(() => null) as Record<string, unknown> | null
const nonNegativeInteger = (value: string | null, fallback: number): number | null => {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
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
  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path)
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
  const conversationDocumentsMatch = /^\/api\/conversations\/([^/]+)\/documents$/.exec(path)
  const conversationCardsMatch = /^\/api\/conversations\/([^/]+)\/cards$/.exec(path)
  const conversationInteractionsMatch = /^\/api\/conversations\/([^/]+)\/interactions$/.exec(path)
  const documentsMatch = path === "/api/documents"
  const documentItemMatch = /^\/api\/documents\/([^/]+)$/.exec(path)
  const documentContentMatch = /^\/api\/documents\/([^/]+)\/content$/.exec(path)
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch ||
    agentsMatch || agentPreviewMatch || agentConfirmMatch || operationsAgentsMatch || operationsAgentEventsMatch ||
    operationsAgentDetailMatch || operationsAgentConfigPreviewMatch || operationsAgentConfigConfirmMatch ||
    operationsAgentActionPreviewMatch || operationsAgentActionConfirmMatch ||
    hubConfigMatch || hubConfigPreviewMatch || hubConfigConfirmMatch || sessionMatch || conversationsMatch ||
    conversationItemMatch || conversationMessagesMatch || conversationEventsMatch || conversationLinksMatch ||
    conversationDocumentsMatch || documentsMatch || documentItemMatch || documentContentMatch ||
    conversationCardsMatch || conversationInteractionsMatch

  if (isGuardedRoute) {
    // Auth runs before method dispatch below, so a wrong-method request without
    // the identity header returns 400 (missing_identity) rather than 405 — intentional,
    // so an unauthenticated caller can't probe which methods/routes exist.
    const email = deps.requireUser(req)
    if (!email) return json({ error: "missing_identity" }, 400)

    if (sessionMatch && method === "GET") {
      const access = deps.agentSessionAccess(email)
      return json({
        identity: email,
        agents: deps.collect().status.agents.filter(({ mode }) => mode === "persistent").map(({ name, alive, busy }) => ({ name, alive, busy })),
        features: {
          agents: access.feature,
          documents: deps.documentsUiEnabled?.() ?? false,
          turnSteps: deps.turnStepsEnabled?.() ?? false,
          // Lane D reads this to decide whether to render cards and offer their buttons.
          // It is the web surface's `SurfaceCapabilities.cards`, reported honestly: true
          // only when the hub can actually persist a card AND accept a click back.
          cards: deps.webCardsEnabled?.() ?? false,
        },
        permissions: { agents: access.role },
      })
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

    // The in-app viewer's byte feed. Owned by the same visibility rules as the listing
    // (`readDocumentContent`); no separate gate, and unavailable whenever documents are.
    if (documentContentMatch && method === "GET") {
      if (!deps.readDocumentContent) return json({ error: "documents_unavailable" }, 503)
      let token: string
      try { token = decodeURIComponent(documentContentMatch[1]) } catch { return json({ error: "malformed_token" }, 400) }
      const content = deps.readDocumentContent(email, token)
      if (!content.ok) return json({ error: content.reason }, content.reason === "forbidden" ? 403 : 404)
      return documentContentResponse(content.row, content.bytes)
    }

    // Transcript attachment hydration. A conversation sub-resource (it sits with /messages,
    // /events and /links) rather than a `/api/documents` filter, because its question — "every
    // document in this conversation that I may see" — is org rows PLUS my own private rows,
    // which is neither of `scope`'s two values and would have overloaded it with a third
    // meaning. Visibility is enforced in SQL by `listByConversation`, identical to the contract
    // `/api/documents` and `readDocumentContent` already apply, so this exposes nothing a
    // caller could not already reach: an org row is staff-readable anyway and a private row
    // stays owner-only. Unavailable exactly when documents are.
    if (conversationDocumentsMatch && method === "GET") {
      if (!deps.listConversationDocuments) return json({ error: "documents_unavailable" }, 503)
      let conversationId: string
      try { conversationId = decodeURIComponent(conversationDocumentsMatch[1]) } catch { return json({ error: "malformed_conversation_id" }, 400) }
      return json(deps.listConversationDocuments(email, conversationId))
    }

    // Transcript card hydration — the same contract as /documents above, and for the same
    // reason: `card` events are live-only, so a reload would otherwise show an empty
    // transcript where the interactive cards were. Membership is enforced inside
    // `listConversationCards`, identical to every other conversation sub-resource.
    if (conversationCardsMatch && method === "GET") {
      if (!deps.listConversationCards || !(deps.webCardsEnabled?.() ?? false)) {
        return json({ error: "web_cards_disabled" }, 503)
      }
      let conversationId: string
      try { conversationId = decodeURIComponent(conversationCardsMatch[1]!) } catch { return json({ error: "malformed_conversation_id" }, 400) }
      // `listConversationCards` asserts membership via ConversationService.get, so it throws
      // the same domain errors as /messages and /links and must answer them the same way.
      try {
        return json(deps.listConversationCards(email, conversationId))
      } catch (error) {
        const mapped = conversationErrorResponse(error)
        if (mapped) return mapped
        throw error
      }
    }

    // A web card click. Every authorisation decision lives in hub/webInteraction.ts, which
    // reuses the Discord gates unchanged — this route only shapes the HTTP envelope.
    if (conversationInteractionsMatch && method === "POST") {
      if (!deps.submitCardInteraction || !(deps.webCardsEnabled?.() ?? false)) {
        return json({ error: "web_cards_disabled" }, 503)
      }
      let conversationId: string
      try { conversationId = decodeURIComponent(conversationInteractionsMatch[1]!) } catch { return json({ error: "malformed_conversation_id" }, 400) }
      let body: { customId?: unknown; fields?: unknown }
      try { body = await req.json() as typeof body } catch { return json({ error: "malformed_body" }, 400) }
      const customId = typeof body.customId === "string" ? body.customId.trim() : ""
      if (!customId) return json({ error: "custom_id_required" }, 400)
      // Only a flat string→string map is a valid modal submission. Anything else is
      // rejected rather than coerced — the frame is a text protocol and a nested object
      // would serialise into it unpredictably.
      let fields: Record<string, string> | undefined
      if (body.fields !== undefined) {
        if (typeof body.fields !== "object" || body.fields === null || Array.isArray(body.fields)) {
          return json({ error: "malformed_fields" }, 400)
        }
        const entries = Object.entries(body.fields as Record<string, unknown>)
        if (entries.some(([, v]) => typeof v !== "string")) return json({ error: "malformed_fields" }, 400)
        fields = Object.fromEntries(entries) as Record<string, string>
      }
      // Same membership assertion as /cards above, plus whatever the gate path raises: a card
      // click is a browser-triggered request, so no throw may reach Bun's default HTML 500
      // (which renders hub source lines into the response body).
      try {
        return cardInteractionResponse(deps.submitCardInteraction(email, conversationId, { customId, fields }))
      } catch (error) {
        const mapped = conversationErrorResponse(error)
        if (mapped) return mapped
        throw error
      }
    }

    const documentAction = (documentsMatch && (method === "GET" || method === "POST")) ||
      (documentItemMatch && (method === "PATCH" || method === "DELETE"))
    if (documentAction && (!deps.listDocuments || !deps.uploadDocument || !deps.setDocumentVisibility || !deps.deleteDocument)) {
      return json({ error: "documents_unavailable" }, 503)
    }

    if (documentAction) {
      const mutationResponse = (result: DocumentMutationResult): Response =>
        result.ok ? json({ ok: true }) : json({ error: result.reason },
          result.reason === "not_found" ? 404 : result.reason === "not_owner" ? 403 : 400)
      try {
        if (documentsMatch && method === "GET") {
          const scope = url.searchParams.get("scope") ?? "mine"
          if (scope !== "mine" && scope !== "org") return json({ error: "invalid_scope" }, 400)
          return json(deps.listDocuments!(email, scope))
        }
        if (documentsMatch && method === "POST") {
          const form = await req.formData().catch(() => null)
          const file = form?.get("file")
          if (!(file instanceof File)) return json({ error: "missing_file" }, 400)
          const visibilityRaw = form!.get("visibility")
          if (visibilityRaw !== null && visibilityRaw !== "private" && visibilityRaw !== "org") return json({ error: "invalid_visibility" }, 400)
          const titleRaw = form!.get("title")
          const result = await deps.uploadDocument!(email, {
            filename: file.name, bytes: Buffer.from(await file.arrayBuffer()),
            ...(typeof titleRaw === "string" && titleRaw ? { title: titleRaw } : {}),
            ...(visibilityRaw ? { visibility: visibilityRaw } : {}),
          })
          if (result.ok) return json({ token: result.token, url: result.url }, 201)
          return json({ error: result.reason }, result.reason === "oversize" ? 413 : 400)
        }
        if (documentItemMatch && method === "PATCH") {
          const body = await bodyJson(req)
          if (body?.visibility !== "private" && body?.visibility !== "org") return json({ error: "invalid_visibility" }, 400)
          return mutationResponse(await deps.setDocumentVisibility!(email, decodeURIComponent(documentItemMatch[1]), body.visibility))
        }
        if (documentItemMatch && method === "DELETE") {
          return mutationResponse(await deps.deleteDocument!(email, decodeURIComponent(documentItemMatch[1])))
        }
      } catch (error) {
        if (error instanceof URIError) return json({ error: "malformed_token" }, 400)
        throw error
      }
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
      const mapped = conversationErrorResponse(error)
      if (mapped) return mapped
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
