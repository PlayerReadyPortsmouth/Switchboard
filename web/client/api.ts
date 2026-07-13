import type { Conversation, ConversationInput, ConversationUpdate, Message, PostMessageInput, Session, TransportLink } from "./types"

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
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

  private async request<T>(path: string, options: { method?: string; json?: unknown; headers?: HeadersInit } = {}): Promise<T> {
    const headers = new Headers(options.headers)
    const body = options.json === undefined ? undefined : JSON.stringify(options.json)
    if (body !== undefined) headers.set("content-type", "application/json")
    const response = await this.fetcher(new Request(new URL(path, this.baseUrl), { method: options.method, headers, body }))
    const contentType = response.headers.get("content-type") ?? ""
    const value = contentType.includes("application/json") ? await response.json().catch(() => null) : null
    if (!response.ok) {
      const code = value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : "request_failed"
      throw new ApiError(response.status, code)
    }
    if (value === null) throw new ApiError(response.status, "invalid_response")
    return value as T
  }
}
