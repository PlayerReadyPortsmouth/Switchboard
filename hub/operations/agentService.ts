import { createHash } from "node:crypto"
import { classifyAgentChange, invalidAgentConfigShape, type AgentChangeClassification } from "../agentConfigDraft"
import { agentConfigPreviewMissState, type AgentConfigPreview, type AgentConfigPreviewRegistry } from "../agentConfigPreview"
import type { AgentStatus, OverseerStatus } from "../statusRegistry"
import type { AgentConfig, AgentRegistry, HubConfig, WorkspaceConfig } from "../types"
import { agentsFeatureEnabled, resolveWorkspaceRole, type WorkspaceRole } from "./access"
import type { AgentEventStream, AgentOperationsEvent } from "./agentEvents"
import { agentConfigVersion, projectAgentViews, type AgentDetailView, type AgentSummaryView, type EditableAgentConfig, type RedactedConfiguredValue } from "./agentViews"
import { agentActionPreviewMissState, type AgentActionPreview, type AgentActionPreviewRegistry, type AgentRuntimeAction, type IdempotencyRegistry } from "./operationPreview"
import { editableAgentConfigError, isConfiguredValueSentinel } from "./editableAgentConfigValidation"

export class AgentOperationsError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code)
    this.name = "AgentOperationsError"
  }
}

export interface AgentConfigCommitResult {
  state: "applied"
  restarted: string[]
  fullRestart: string[]
}

export interface AgentActionResult {
  state: "applied"
  agent: string
  action: AgentRuntimeAction
}

export interface AgentConfigPreviewResult {
  id: string
  before: EditableAgentConfig | null
  after: EditableAgentConfig | null
  classification: AgentChangeClassification
  expiresAt: number
}

export interface LegacyAgentConfigPreviewResult {
  id: string
  before: AgentConfig | null
  after: AgentConfig | null
  classification: AgentChangeClassification
}

export interface AgentOperationsDeps {
  workspace: WorkspaceConfig | undefined
  hub: HubConfig
  readAgents(): AgentRegistry
  statuses(): { agents: AgentStatus[]; overseers: OverseerStatus[] }
  commitConfig(input: {
    actor: string
    agent: string
    before: AgentConfig | null
    after: AgentConfig | null
    classification: AgentChangeClassification
    hard: boolean
  }): Promise<AgentConfigCommitResult>
  runAction(input: { actor: string; agent: string; action: AgentRuntimeAction }): Promise<AgentActionResult>
  audit(input: {
    actor: string
    action: string
    target: string
    outcome: "ok" | "deny" | "error"
    detail?: Record<string, unknown>
  }): void
  now(): number
  events: AgentEventStream
  configPreviews: AgentConfigPreviewRegistry
  actionPreviews: AgentActionPreviewRegistry
  idempotency: IdempotencyRegistry<AgentActionResult>
}

const cloneConfig = (config: AgentConfig | null): AgentConfig | null =>
  config === null ? null : structuredClone(config)

const statusSnapshot = (status: AgentStatus | undefined) => ({
  alive: status?.alive ?? false,
  busy: status?.busy ?? false,
  queueDepth: status?.queueDepth ?? 0,
  lastActivityMs: status?.lastActivityMs ?? 0,
})

const statusVersion = (status: AgentStatus | undefined): string =>
  createHash("sha256").update(JSON.stringify(statusSnapshot(status))).digest("hex")

const auditFailureOutcome = (error: unknown): "deny" | "error" =>
  error instanceof AgentOperationsError && (error.status === 403 || error.status === 404) ? "deny" : "error"

function withoutConfig(view: AgentDetailView): AgentSummaryView {
  const { config: _config, ...summary } = view
  return summary
}

function editable(config: AgentConfig | null): EditableAgentConfig | null {
  if (config === null) return null
  return projectAgentViews({ preview: config }, [], [], "operator")[0]!.config
}

function redactedAuditConfig(config: AgentConfig | EditableAgentConfig | null): Record<string, unknown> | null {
  if (config === null) return null
  const projected = projectAgentViews({ audit: config as AgentConfig }, [], [], "operator")[0]!.config
  const { claudeArgs, appendSystemPrompt, cwd: _cwd, ...runtime } = projected.runtime
  return {
    emoji: projected.emoji,
    description: projected.description,
    mode: projected.mode,
    access: structuredClone(projected.access),
    runtime: {
      ...structuredClone(runtime),
      cwd: "[redacted]",
      claudeArgsConfigured: claudeArgs !== undefined,
      appendSystemPromptConfigured: appendSystemPrompt !== undefined,
    },
  }
}

function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => changedPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key))
  }
  return [prefix || "config"]
}

function configPreviewAuditDetail(result: LegacyAgentConfigPreviewResult | AgentConfigPreviewResult): Record<string, unknown> {
  const before = redactedAuditConfig(result.before)
  const after = redactedAuditConfig(result.after)
  const diff = changedPaths(before, after)
  for (const key of ["claudeArgs", "appendSystemPrompt"] as const) {
    if (JSON.stringify(result.before?.runtime[key]) !== JSON.stringify(result.after?.runtime[key])) diff.push(`runtime.${key}`)
  }
  return {
    previewId: result.id,
    before,
    after,
    diff: [...new Set(diff)].sort(),
    classification: structuredClone(result.classification),
    restartScope: { tier: result.classification.tier, fullRestart: [...result.classification.fullRestart] },
  }
}

export class AgentOperationsService {
  constructor(private readonly deps: AgentOperationsDeps) {}

  list(actor: string): AgentSummaryView[] {
    const role = this.requireVisible(actor, true)
    const { agents, overseers } = this.deps.statuses()
    return projectAgentViews(this.deps.readAgents(), agents, overseers, role).map(withoutConfig)
  }

  get(actor: string, agent: string): AgentDetailView {
    const role = this.requireVisible(actor, true)
    const registry = this.deps.readAgents()
    if (!registry[agent]) throw new AgentOperationsError(404, "not_found")
    const { agents, overseers } = this.deps.statuses()
    return projectAgentViews({ [agent]: registry[agent] }, agents, overseers, role)[0]!
  }

  listLegacyConfigs(actor: string): Record<string, EditableAgentConfig> {
    const role = this.requireVisible(actor, false)
    const registry = this.deps.readAgents()
    return Object.fromEntries(projectAgentViews(registry, [], [], role).map(view => [view.name, view.config]))
  }

  previewLegacyConfig(actor: string, agent: string, submitted: EditableAgentConfig | AgentConfig | null): Promise<LegacyAgentConfigPreviewResult> {
    return this.auditMutation(actor, "agent_config_preview", agent, async () => {
      this.requireOperator(actor, false)
      const preview = this.createConfigPreview(actor, agent, submitted)
      return {
        id: preview.id,
        before: cloneConfig(preview.before),
        after: cloneConfig(preview.after),
        classification: structuredClone(preview.classification),
      }
    }, result => configPreviewAuditDetail(result))
  }

  confirmLegacyConfig(actor: string, agent: string, previewId: string, hard: boolean): Promise<AgentConfigCommitResult> {
    return this.auditMutation(actor, "agent_config_confirm", agent, async () => {
      this.requireOperator(actor, false)
      return this.applyConfigPreview(actor, agent, previewId, hard)
    }, result => ({ previewId, hard, restartScope: { restarted: result.restarted, fullRestart: result.fullRestart } }))
  }

  previewConfig(actor: string, agent: string, submitted: EditableAgentConfig | AgentConfig | null, expectedVersion: string): Promise<AgentConfigPreviewResult> {
    let auditDetail: Record<string, unknown> | undefined
    return this.auditMutation(actor, "agent_config_preview", agent, async () => {
      this.requireOperator(actor, true)
      if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") throw new AgentOperationsError(400, "invalid_expected_version")
      const preview = this.createConfigPreview(actor, agent, submitted, expectedVersion)
      auditDetail = configPreviewAuditDetail({ id: preview.id, before: preview.before, after: preview.after, classification: preview.classification })
      return {
        id: preview.id,
        before: editable(preview.before),
        after: editable(preview.after),
        classification: structuredClone(preview.classification),
        expiresAt: preview.expiresAt,
      }
    }, () => auditDetail!)
  }

  confirmConfig(actor: string, agent: string, previewId: string, hard: boolean): Promise<AgentConfigCommitResult> {
    return this.auditMutation(actor, "agent_config_confirm", agent, async () => {
      this.requireOperator(actor, true)
      return this.applyConfigPreview(actor, agent, previewId, hard)
    }, result => ({ previewId, hard, restartScope: { restarted: result.restarted, fullRestart: result.fullRestart } }))
  }

  previewAction(actor: string, agent: string, action: AgentRuntimeAction): AgentActionPreview {
    return this.auditMutationSync(actor, "agent_action_preview", agent, () => {
      this.requireOperator(actor, true)
      const config = this.deps.readAgents()[agent]
      if (!config) throw new AgentOperationsError(404, "not_found")
      if (config.mode !== "persistent" || config.runtime.pool !== undefined) throw new AgentOperationsError(409, "action_unavailable")
      const current = this.findStatus(agent)
      const snapshot = statusSnapshot(current)
      return this.deps.actionPreviews.create(actor, agent, action, statusVersion(current), {
        busy: snapshot.busy,
        queueDepth: snapshot.queueDepth,
      })
    }, { action })
  }

  confirmAction(actor: string, agent: string, previewId: string, idempotencyKey: string): Promise<AgentActionResult> {
    try {
      this.requireOperator(actor, true)
      if (!idempotencyKey) throw new AgentOperationsError(400, "missing_idempotency_key")
      const config = this.deps.readAgents()[agent]
      if (!config) throw new AgentOperationsError(404, "not_found")
      if (config.mode !== "persistent" || config.runtime.pool !== undefined) throw new AgentOperationsError(409, "action_unavailable")
    } catch (error) {
      this.deps.audit({
        actor,
        action: "agent_action_confirm",
        target: agent,
        outcome: auditFailureOutcome(error),
      })
      return Promise.reject(error)
    }

    const requestKey = `${agent}\0${previewId}\0${idempotencyKey}`
    return this.deps.idempotency.run(actor, requestKey, () =>
      this.auditMutation(actor, "agent_action_confirm", agent, async () => {
        const current = this.findStatus(agent)
        const currentVersion = statusVersion(current)
        const pending = this.deps.actionPreviews.get(previewId)
        const preview = this.deps.actionPreviews.consume(previewId, actor, agent, currentVersion)
        if (!preview) {
          const state = agentActionPreviewMissState(pending, actor, agent, currentVersion, this.deps.now())
          throw new AgentOperationsError(409, state === "state_changed" ? "action_state_changed" : "preview_not_found")
        }
        let result: AgentActionResult
        try {
          result = await this.deps.runAction({ actor, agent, action: preview.action })
        } catch {
          throw new AgentOperationsError(500, "runtime_failure")
        }
        this.deps.events.publish({ kind: "action_completed", agent, action: preview.action, ts: this.deps.now() })
        return result
      }),
    )
  }

  subscribe(after: number, callback: (event: AgentOperationsEvent) => void): { unsubscribe(): void } {
    return this.deps.events.subscribe(after, callback)
  }

  private createConfigPreview(
    actor: string,
    agent: string,
    submitted: EditableAgentConfig | AgentConfig | null,
    expectedVersion?: string,
  ): AgentConfigPreview {
    const liveBefore = cloneConfig(this.deps.readAgents()[agent] ?? null)
    if (expectedVersion !== undefined && expectedVersion !== agentConfigVersion(liveBefore)) throw new AgentOperationsError(409, "stale_config")
    const after = this.resolveSubmittedConfig(submitted, liveBefore)
    if (after !== null) {
      const shapeError = invalidAgentConfigShape(after)
      if (shapeError) throw new AgentOperationsError(400, "invalid_config")
    }
    const classification = classifyAgentChange(agent, liveBefore, after, this.deps.hub)
    return this.deps.configPreviews.create(
      actor,
      agent,
      agentConfigVersion(liveBefore),
      liveBefore,
      after,
      classification,
    )
  }

  private async applyConfigPreview(actor: string, agent: string, previewId: string, hard: boolean): Promise<AgentConfigCommitResult> {
    const liveBefore = cloneConfig(this.deps.readAgents()[agent] ?? null)
    const liveVersion = agentConfigVersion(liveBefore)
    const pending = this.deps.configPreviews.get(previewId)
    const preview = this.deps.configPreviews.consume(previewId, actor, agent, liveVersion)
    if (!preview) {
      const state = agentConfigPreviewMissState(pending, actor, agent, liveVersion, this.deps.now())
      throw new AgentOperationsError(409, state === "conflict" ? "stale_preview" : "preview_not_found")
    }
    const result = await this.deps.commitConfig({
      actor,
      agent,
      before: cloneConfig(preview.before),
      after: cloneConfig(preview.after),
      classification: structuredClone(preview.classification),
      hard,
    })
    this.deps.events.publish({ kind: "config_applied", agent, ts: this.deps.now() })
    return result
  }

  private resolveSubmittedConfig(
    submitted: EditableAgentConfig | AgentConfig | null,
    liveBefore: AgentConfig | null,
  ): AgentConfig | null {
    if (submitted === null) return null
    const original = editable(liveBefore)
    if (typeof submitted === "object" && submitted !== null && "runtime" in submitted && submitted.runtime && typeof submitted.runtime === "object") {
      const submittedRuntime = submitted.runtime as Record<string, unknown>
      if (isConfiguredValueSentinel(submittedRuntime.claudeArgs) && liveBefore?.runtime.claudeArgs === undefined) throw new AgentOperationsError(400, "configured_value_missing")
      if (isConfiguredValueSentinel(submittedRuntime.appendSystemPrompt) && liveBefore?.runtime.appendSystemPrompt === undefined) throw new AgentOperationsError(400, "configured_value_missing")
    }
    if (editableAgentConfigError(submitted, original) !== null) throw new AgentOperationsError(400, "invalid_config")
    const after = structuredClone(submitted) as AgentConfig
    const runtime = after.runtime as AgentConfig["runtime"] & {
      claudeArgs?: AgentConfig["runtime"]["claudeArgs"] | RedactedConfiguredValue
      appendSystemPrompt?: AgentConfig["runtime"]["appendSystemPrompt"] | RedactedConfiguredValue
    }

    if (isConfiguredValueSentinel(runtime.claudeArgs)) {
      if (liveBefore?.runtime.claudeArgs === undefined) throw new AgentOperationsError(400, "configured_value_missing")
      runtime.claudeArgs = structuredClone(liveBefore.runtime.claudeArgs)
    }
    if (isConfiguredValueSentinel(runtime.appendSystemPrompt)) {
      if (liveBefore?.runtime.appendSystemPrompt === undefined) throw new AgentOperationsError(400, "configured_value_missing")
      runtime.appendSystemPrompt = liveBefore.runtime.appendSystemPrompt
    }
    return after
  }

  private findStatus(agent: string): AgentStatus | undefined {
    return this.deps.statuses().agents.find(status => status.name === agent)
  }

  private requireVisible(actor: string, requireFeature: boolean): WorkspaceRole {
    if (requireFeature && !agentsFeatureEnabled(this.deps.workspace)) throw new AgentOperationsError(404, "not_found")
    const role = resolveWorkspaceRole(actor, this.deps.workspace)
    if (role === "hidden") throw new AgentOperationsError(404, "not_found")
    return role
  }

  private requireOperator(actor: string, requireFeature: boolean): void {
    const role = this.requireVisible(actor, requireFeature)
    if (role !== "operator") throw new AgentOperationsError(403, "forbidden")
  }

  private auditMutationSync<Result>(
    actor: string,
    action: string,
    target: string,
    operation: () => Result,
    detail?: Record<string, unknown> | ((result: Result) => Record<string, unknown>),
  ): Result {
    try {
      const result = operation()
      this.deps.audit({ actor, action, target, outcome: "ok", detail: typeof detail === "function" ? detail(result) : detail })
      return result
    } catch (error) {
      this.deps.audit({ actor, action, target, outcome: auditFailureOutcome(error), detail: typeof detail === "function" ? undefined : detail })
      throw error
    }
  }

  private async auditMutation<Result>(
    actor: string,
    action: string,
    target: string,
    operation: () => Promise<Result> | Result,
    detail?: Record<string, unknown> | ((result: Result) => Record<string, unknown>),
  ): Promise<Result> {
    try {
      const result = await operation()
      this.deps.audit({ actor, action, target, outcome: "ok", detail: typeof detail === "function" ? detail(result) : detail })
      return result
    } catch (error) {
      this.deps.audit({ actor, action, target, outcome: auditFailureOutcome(error), detail: typeof detail === "function" ? undefined : detail })
      throw error
    }
  }
}
