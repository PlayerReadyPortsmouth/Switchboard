import type {
  AgentActionPreview,
  AgentActionResult,
  AgentConfig,
  AgentConfigCommitResult,
  AgentConfigPreview,
  AgentDetail,
  EditableAgentConfig,
  AgentRuntimeAction,
  AgentSummary,
  Conversation,
  ConversationInput,
  ConversationUpdate,
  Message,
  PostMessageInput,
  Session,
  TransportLink,
  CardInfo,
  CardInteractionResult,
  DocumentAttachment,
  DocumentSummary,
  UploadDocumentResult,
} from "./types"

export class ApiError extends Error {
  /** `reason` is the hub's optional human-readable elaboration on `code` — card interactions
   *  send one with `unroutable` and with every denial, and the card surfaces it verbatim so a
   *  refused click says WHY rather than just failing. */
  constructor(readonly status: number, readonly code: string, readonly reason?: string) {
    super(code)
    this.name = "ApiError"
  }
}

export type Fetcher = (input: Request) => Promise<Response>

export class WorkspaceApi {
  constructor(
    private readonly fetcher: Fetcher = input => fetch(input),
    private readonly baseUrl = globalThis.location?.origin ?? "http://localhost",
    private readonly basePath = "/",
  ) {}

  session(): Promise<Session> {
    return this.request("/api/session")
  }

  listConversations(includeArchived = false): Promise<Conversation[]> {
    return this.request(`/api/conversations${includeArchived ? "?includeArchived=true" : ""}`)
  }

  createConversation(input: ConversationInput): Promise<Conversation> {
    return this.request("/api/conversations", { method: "POST", json: input })
  }

  updateConversation(conversationId: string, input: ConversationUpdate): Promise<Conversation> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "PATCH", json: input })
  }

  archiveConversation(conversationId: string): Promise<Conversation> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" })
  }

  listMessages(conversationId: string, after = 0, limit = 100): Promise<Message[]> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/messages?after=${after}&limit=${limit}`)
  }

  postMessage(conversationId: string, input: PostMessageInput): Promise<Message> {
    const { clientKey, ...json } = input
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      json,
      headers: { "idempotency-key": clientKey },
    })
  }

  /** The transcript's attachment cards, for hydration on conversation load. `attachment`
   *  events are live-only, so without this a remount loses every card already on screen. */
  listConversationDocuments(conversationId: string): Promise<DocumentAttachment[]> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/documents`)
  }

  /** The transcript's interactive agent cards, for hydration on conversation load. `card`
   *  events are live-only — exactly like `attachment` — so without this a remount loses every
   *  card already on screen, buttons and all. */
  listConversationCards(conversationId: string): Promise<CardInfo[]> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/cards`)
  }

  /** A card button click. Resolves to one of the three 200 shapes; every documented failure
   *  (403 `unmapped_identity`/`not_allowlisted`/`forbidden_action`, 409 `unroutable`,
   *  503 `web_cards_disabled`) arrives as a rejected `ApiError` carrying that code. */
  submitCardInteraction(conversationId: string, input: { customId: string; fields?: Record<string, string> }): Promise<CardInteractionResult> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/interactions`, { method: "POST", json: input })
  }

  listLinks(conversationId: string): Promise<TransportLink[]> {
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}/links`)
  }

  listAgents(): Promise<AgentSummary[]> {
    return this.request("/api/operations/agents")
  }

  getAgent(agent: string): Promise<AgentDetail> {
    return this.request(`/api/operations/agents/${encodeURIComponent(agent)}`)
  }

  previewAgentConfig(agent: string, config: EditableAgentConfig | AgentConfig | null, expectedVersion: string): Promise<AgentConfigPreview> {
    return this.request(`/api/operations/agents/${encodeURIComponent(agent)}/config/preview`, {
      method: "POST",
      json: { config, expectedVersion },
    })
  }

  confirmAgentConfig(agent: string, previewId: string, hard: boolean): Promise<AgentConfigCommitResult> {
    return this.request(`/api/operations/agents/${encodeURIComponent(agent)}/config/confirm`, {
      method: "POST",
      json: { id: previewId, hard },
    })
  }

  previewAgentAction(agent: string, action: AgentRuntimeAction): Promise<AgentActionPreview> {
    return this.request(`/api/operations/agents/${encodeURIComponent(agent)}/actions/preview`, {
      method: "POST",
      json: { action },
    })
  }

  confirmAgentAction(agent: string, previewId: string, idempotencyKey: string): Promise<AgentActionResult> {
    return this.request(`/api/operations/agents/${encodeURIComponent(agent)}/actions/confirm`, {
      method: "POST",
      json: { id: previewId },
      headers: { "idempotency-key": idempotencyKey },
    })
  }

  listDocuments(scope: "mine" | "org" = "mine"): Promise<DocumentSummary[]> {
    return this.request(`/api/documents?scope=${scope}`)
  }

  uploadDocument(file: File, options: { title?: string; visibility?: "private" | "org" } = {}): Promise<UploadDocumentResult> {
    const form = new FormData()
    form.set("file", file)
    if (options.title !== undefined) form.set("title", options.title)
    if (options.visibility !== undefined) form.set("visibility", options.visibility)
    return this.requestForm("/api/documents", form)
  }

  setDocumentVisibility(token: string, visibility: "private" | "org"): Promise<{ ok: true }> {
    return this.request(`/api/documents/${encodeURIComponent(token)}`, { method: "PATCH", json: { visibility } })
  }

  deleteDocument(token: string): Promise<{ ok: true }> {
    return this.request(`/api/documents/${encodeURIComponent(token)}`, { method: "DELETE" })
  }

  /** Absolute URL of a document's bytes — used directly as an `<img>`/`<object>` source and as
   *  the download href, so the browser fetches it with the session's cookies rather than us
   *  buffering binaries through JS. */
  documentContentUrl(token: string): string {
    return this.endpoint(`/api/documents/${encodeURIComponent(token)}/content`).toString()
  }

  /** Text-shaped documents (markdown, plain text, CSV) are pulled into JS so the viewer can
   *  render them itself. `send` is JSON-only, hence the separate path. */
  async fetchDocumentText(token: string): Promise<string> {
    const response = await this.fetcher(new Request(this.documentContentUrl(token)))
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null
      throw new ApiError(response.status, typeof body?.error === "string" ? body.error : "request_failed")
    }
    return await response.text()
  }

  // basePath has a trailing slash and path a leading slash; drop one to avoid "//". "/" → "".
  private endpoint(path: string): URL {
    return new URL(`${this.basePath.replace(/\/$/, "")}${path}`, this.baseUrl)
  }

  private async send<T>(request: Request): Promise<T> {
    const response = await this.fetcher(request)
    const contentType = response.headers.get("content-type") ?? ""
    const value = contentType.includes("application/json") ? await response.json().catch(() => null) : null
    if (!response.ok) {
      const body = value && typeof value === "object" ? value as { error?: unknown; reason?: unknown } : null
      const code = typeof body?.error === "string" ? body.error : "request_failed"
      const reason = typeof body?.reason === "string" ? body.reason : undefined
      throw new ApiError(response.status, code, reason)
    }
    if (value === null) throw new ApiError(response.status, "invalid_response")
    return value as T
  }

  private request<T>(path: string, options: { method?: string; json?: unknown; headers?: HeadersInit } = {}): Promise<T> {
    const headers = new Headers(options.headers)
    const body = options.json === undefined ? undefined : JSON.stringify(options.json)
    if (body !== undefined) headers.set("content-type", "application/json")
    return this.send<T>(new Request(this.endpoint(path), { method: options.method, headers, body }))
  }

  // Multipart uploads omit an explicit content-type so the runtime sets the
  // multipart boundary itself (the proxy forwards it verbatim to the hub).
  private requestForm<T>(path: string, form: FormData): Promise<T> {
    return this.send<T>(new Request(this.endpoint(path), { method: "POST", body: form }))
  }
}
