export type AgentRuntimeAction = "reset" | "restart"

export interface AgentActionPreview {
  id: string
  actor: string
  agent: string
  action: AgentRuntimeAction
  statusVersion: string
  impact: { busy: boolean; queueDepth: number }
  expiresAt: number
}

export function agentActionPreviewMissState(
  preview: AgentActionPreview | undefined,
  actor: string,
  agent: string,
  statusVersion: string,
  now: number,
): "state_changed" | "not_found" {
  return preview !== undefined
    && preview.expiresAt > now
    && preview.actor === actor
    && preview.agent === agent
    && preview.statusVersion !== statusVersion
    ? "state_changed"
    : "not_found"
}

const previewCopy = (preview: AgentActionPreview): AgentActionPreview => ({
  ...preview,
  impact: { ...preview.impact },
})

export class AgentActionPreviewRegistry {
  private pending = new Map<string, AgentActionPreview>()

  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  create(
    actor: string,
    agent: string,
    action: AgentRuntimeAction,
    statusVersion: string,
    impact: AgentActionPreview["impact"],
  ): AgentActionPreview {
    const preview: AgentActionPreview = {
      id: this.genId(),
      actor,
      agent,
      action,
      statusVersion,
      impact: { ...impact },
      expiresAt: this.now() + this.ttlMs,
    }
    this.pending.set(preview.id, preview)
    return preview
  }

  get(id: string): AgentActionPreview | undefined {
    const preview = this.pending.get(id)
    return preview === undefined ? undefined : previewCopy(preview)
  }

  consume(id: string, actor: string, agent: string, statusVersion: string): AgentActionPreview | null {
    const preview = this.pending.get(id)
    if (!preview) return null
    this.pending.delete(id)
    if (preview.expiresAt <= this.now()) return null
    if (preview.actor !== actor || preview.agent !== agent || preview.statusVersion !== statusVersion) return null
    return preview
  }
}

interface IdempotencyEntry<Result> {
  promise: Promise<Result>
  expiresAt: number | null
}

export class IdempotencyRegistry<Result> {
  private entries = new Map<string, IdempotencyEntry<Result>>()

  constructor(
    private now: () => number,
    private ttlMs: number,
  ) {}

  run(actor: string, key: string, operation: () => Promise<Result>): Promise<Result> {
    const scopedKey = `${actor}\0${key}`
    const existing = this.entries.get(scopedKey)
    if (existing && (existing.expiresAt === null || existing.expiresAt > this.now())) return existing.promise
    if (existing) this.entries.delete(scopedKey)

    let resolveCached!: (result: Result) => void
    let rejectCached!: (error: unknown) => void
    const cached = new Promise<Result>((resolve, reject) => {
      resolveCached = resolve
      rejectCached = reject
    })
    const entry: IdempotencyEntry<Result> = { promise: cached, expiresAt: null }
    this.entries.set(scopedKey, entry)

    const reject = (error: unknown) => {
      if (this.entries.get(scopedKey) === entry) this.entries.delete(scopedKey)
      rejectCached(error)
    }

    try {
      operation().then(result => {
        if (this.entries.get(scopedKey) === entry) entry.expiresAt = this.now() + this.ttlMs
        resolveCached(result)
      }, reject)
    } catch (error) {
      reject(error)
    }
    return cached
  }
}
