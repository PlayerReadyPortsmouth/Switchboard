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
  ApprovalDecision,
  ApprovalDecisionResult,
  ApprovalDetail,
  ApprovalListPage,
  ApprovalListQuery,
  Conversation,
  ConversationInput,
  ConversationUpdate,
  Message,
  PostMessageInput,
  Session,
  TransportLink,
} from "./types"

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly payload: unknown = null) {
    super(code)
    this.name = "ApiError"
  }
}

export type Fetcher = (input: Request) => Promise<Response>

export class WorkspaceApi {
  constructor(
    private readonly fetcher: Fetcher = input => fetch(input),
    private readonly baseUrl = globalThis.location?.origin ?? "http://localhost",
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

  listApprovals(query: ApprovalListQuery): Promise<ApprovalListPage> {
    const parameters = new URLSearchParams()
    const append = (key: string, value: string | number | undefined): void => {
      if (value !== undefined) parameters.set(key, String(value))
    }
    append("group", query.group)
    append("search", query.search)
    append("risk", query.risk)
    append("kind", query.kind)
    append("requester", query.requester)
    append("state", query.state)
    append("conversationId", query.conversationId)
    append("createdFrom", query.createdFrom)
    append("createdTo", query.createdTo)
    append("decisionFrom", query.decisionFrom)
    append("decisionTo", query.decisionTo)
    append("limit", query.limit)
    append("cursor", query.cursor)
    return this.request(`/api/operations/approvals?${parameters.toString()}`)
  }

  getApproval(approvalId: string): Promise<ApprovalDetail> {
    return this.request(`/api/operations/approvals/${encodeURIComponent(approvalId)}`)
  }

  decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    expectedVersion: string,
    idempotencyKey: string,
  ): Promise<ApprovalDecisionResult> {
    return this.request(`/api/operations/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      json: { decision, expectedVersion },
      headers: { "idempotency-key": idempotencyKey },
    })
  }

  private async request<T>(path: string, options: { method?: string; json?: unknown; headers?: HeadersInit } = {}): Promise<T> {
    const headers = new Headers(options.headers)
    const body = options.json === undefined ? undefined : JSON.stringify(options.json)
    if (body !== undefined) headers.set("content-type", "application/json")
    const request = new Request(new URL(path, this.baseUrl), { method: options.method, headers, body })
    let response: Response
    try {
      response = await this.fetcher(request)
    } catch {
      throw new ApiError(0, "request_failed")
    }
    const contentType = response.headers.get("content-type") ?? ""
    const value = contentType.includes("application/json") ? await response.json().catch(() => null) : null
    if (!response.ok) {
      const code = value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : "request_failed"
      throw new ApiError(response.status, code, value)
    }
    if (value === null || typeof value !== "object") throw new ApiError(response.status, "invalid_response")
    return value as T
  }
}
