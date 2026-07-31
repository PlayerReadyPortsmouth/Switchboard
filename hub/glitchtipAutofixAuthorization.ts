const READYAPP_BUG_BOARD = "cmqdu2yui0000qybb4x2uyhwp"
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{32}$/
const GLITCHTIP_SIGNATURE = /^glitchtip:\d+$/

export type GlitchtipAuthorizationReason =
  | "authorized"
  | "missing"
  | "stale"
  | "wrong_agent"
  | "wrong_channel"
  | "credentials_missing"
  | "board_fetch_failed"
  | "board_payload_invalid"
  | "task_missing"
  | "task_old"
  | "label_missing"
  | "signature_mismatch"

export type GlitchtipAuthorizationResult =
  | { ok: true; reason: "authorized"; signature: string }
  | { ok: false; reason: Exclude<GlitchtipAuthorizationReason, "authorized"> }

interface PendingAuthorization {
  id: string
  agent: "prod-sentinel"
  channelId: string
  signature: string
  receivedAt: number
  expiresAt: number
}

interface BoardTask {
  id: string
  createdAt: string
  labels: string[]
  description: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function parseVerifiedPayload(rawBody: string): {
  id: string
  signature: string
} | null {
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!isRecord(parsed)) return null
    if (parsed.autofixHandoff !== true || parsed.count !== 1) return null
    if (typeof parsed.autofixAuthorizationId !== "string" || !AUTHORIZATION_ID.test(parsed.autofixAuthorizationId)) return null
    if (typeof parsed.signature !== "string" || !GLITCHTIP_SIGNATURE.test(parsed.signature)) return null
    return { id: parsed.autofixAuthorizationId, signature: parsed.signature }
  } catch {
    return null
  }
}

function matchingBoardTasks(payload: unknown, taskId: string): BoardTask[] | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.stages)) return null
  const out: BoardTask[] = []
  for (const stage of payload.data.stages) {
    if (!isRecord(stage) || !Array.isArray(stage.tasks)) return null
    for (const task of stage.tasks) {
      if (!isRecord(task) || task.id !== taskId) continue
      if (typeof task.createdAt !== "string" || !Array.isArray(task.labels) ||
          !task.labels.every((label) => typeof label === "string") || typeof task.description !== "string") return null
      out.push({ id: task.id, createdAt: task.createdAt, labels: task.labels, description: task.description })
    }
  }
  return out
}

export class GlitchtipAutofixAuthorizationRegistry {
  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly seen = new Map<string, number>()

  constructor(private readonly deps: {
    now: () => number
    ttlMs: number
    cardClockToleranceMs: number
  }) {}

  registerVerifiedBody(rawBody: string, binding: { agent: string; channelId: string }): boolean {
    const now = this.deps.now()
    this.prune(now)
    const parsed = parseVerifiedPayload(rawBody)
    if (!parsed || binding.agent !== "prod-sentinel" || !binding.channelId) return false
    if (this.seen.has(parsed.id)) {
      this.pending.delete(parsed.id)
      return false
    }
    const expiresAt = now + this.deps.ttlMs
    this.seen.set(parsed.id, expiresAt)
    this.pending.set(parsed.id, {
      id: parsed.id,
      agent: "prod-sentinel",
      channelId: binding.channelId,
      signature: parsed.signature,
      receivedAt: now,
      expiresAt,
    })
    return true
  }

  async consumeAndAuthorize(input: {
    authorizationId: string
    taskId: string
    sourceAgent: string
    channelId: string
    apiBase: string | undefined
    apiToken: string | undefined
    fetch: typeof fetch
  }): Promise<GlitchtipAuthorizationResult> {
    const now = this.deps.now()
    const authorization = this.pending.get(input.authorizationId)
    if (authorization) this.pending.delete(input.authorizationId)
    if (!authorization) {
      for (const [id, pending] of this.pending) {
        if (pending.agent === input.sourceAgent && pending.channelId === input.channelId) this.pending.delete(id)
      }
      return { ok: false, reason: "missing" }
    }
    if (now > authorization.expiresAt) return { ok: false, reason: "stale" }
    if (input.sourceAgent !== authorization.agent) return { ok: false, reason: "wrong_agent" }
    if (input.channelId !== authorization.channelId) return { ok: false, reason: "wrong_channel" }
    if (!input.apiBase || !input.apiToken) return { ok: false, reason: "credentials_missing" }

    let response: Response
    try {
      response = await input.fetch(`${input.apiBase.replace(/\/$/, "")}/boards/${READYAPP_BUG_BOARD}`, {
        headers: { "x-mcp-token": input.apiToken },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return { ok: false, reason: "board_fetch_failed" }
    } catch {
      return { ok: false, reason: "board_fetch_failed" }
    }

    let parsed: unknown
    try { parsed = await response.json() } catch { return { ok: false, reason: "board_payload_invalid" } }
    const tasks = matchingBoardTasks(parsed, input.taskId)
    if (!tasks) return { ok: false, reason: "board_payload_invalid" }
    if (tasks.length !== 1) return { ok: false, reason: "task_missing" }
    const task = tasks[0]
    const createdAt = Date.parse(task.createdAt)
    if (!Number.isFinite(createdAt) || createdAt < authorization.receivedAt - this.deps.cardClockToleranceMs || createdAt > now + this.deps.cardClockToleranceMs) {
      return { ok: false, reason: "task_old" }
    }
    if (!task.labels.includes("prod-sentinel")) return { ok: false, reason: "label_missing" }
    if (!task.description.includes(`sentinel-sig:${authorization.signature}`)) return { ok: false, reason: "signature_mismatch" }
    return { ok: true, reason: "authorized", signature: authorization.signature }
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.seen) {
      if (now > expiresAt) {
        this.seen.delete(id)
        this.pending.delete(id)
      }
    }
  }
}
