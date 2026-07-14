import { createHash } from "node:crypto"
import type { AgentStatus, OverseerStatus } from "../statusRegistry"
import type { AgentConfig } from "../types"
import type { WorkspaceRole } from "./access"

export interface AgentPermissions {
  configure: boolean
  reset: boolean
  restart: boolean
  remove: boolean
}

export interface AgentSummaryView {
  name: string
  emoji: string
  description: string
  mode: "persistent" | "ephemeral"
  status: "offline" | "idle" | "busy"
  queueDepth: number
  contextFill: number
  costUsd: number
  replicas: number
  lastActivityMs: number
  currentTool: string | null
  lastTool: { name: string; error: boolean } | null
  currentWork: { state: "prodding" | "compacting"; goal: string; round: number; max: number } | null
  model: string | null
  version: string
  permissions: AgentPermissions
}

export interface RedactedConfiguredValue {
  redacted: true
  configured: true
}

export interface EditableAgentConfig {
  emoji: string
  description: string
  mode: "persistent" | "ephemeral"
  access: AgentConfig["access"]
  runtime: Omit<AgentConfig["runtime"], "claudeArgs" | "appendSystemPrompt"> & {
    claudeArgs?: string[] | RedactedConfiguredValue
    appendSystemPrompt?: string | RedactedConfiguredValue
  }
}

export interface AgentDetailView extends AgentSummaryView {
  config: EditableAgentConfig
}

const configuredValue = (): RedactedConfiguredValue => ({ redacted: true, configured: true })

function safeAccess(access: AgentConfig["access"]): AgentConfig["access"] {
  const safe: AgentConfig["access"] = { roles: [...access.roles] }
  if (access.users !== undefined) safe.users = [...access.users]
  if (access.consultableBy !== undefined) safe.consultableBy = [...access.consultableBy]
  if (access.peerableBy !== undefined) safe.peerableBy = [...access.peerableBy]
  return safe
}

function safeOverseer(value: NonNullable<AgentConfig["runtime"]["overseer"]>): NonNullable<AgentConfig["runtime"]["overseer"]> {
  const safe: NonNullable<AgentConfig["runtime"]["overseer"]> = { enabled: value.enabled }
  if (value.maxIterations !== undefined) safe.maxIterations = value.maxIterations
  if (value.maxWallclockMs !== undefined) safe.maxWallclockMs = value.maxWallclockMs
  if (value.model !== undefined) safe.model = value.model
  return safe
}

function safeGovernor(value: NonNullable<AgentConfig["runtime"]["sessionGovernor"]>): NonNullable<AgentConfig["runtime"]["sessionGovernor"]> {
  const safe: NonNullable<AgentConfig["runtime"]["sessionGovernor"]> = { enabled: value.enabled }
  if (value.softPct !== undefined) safe.softPct = value.softPct
  if (value.hardPct !== undefined) safe.hardPct = value.hardPct
  if (value.strategy !== undefined) safe.strategy = value.strategy
  return safe
}

function safePool(value: NonNullable<AgentConfig["runtime"]["pool"]>): NonNullable<AgentConfig["runtime"]["pool"]> {
  const safe: NonNullable<AgentConfig["runtime"]["pool"]> = {}
  if (value.min !== undefined) safe.min = value.min
  if (value.max !== undefined) safe.max = value.max
  if (value.scaleUpQueue !== undefined) safe.scaleUpQueue = value.scaleUpQueue
  if (value.scaleUpSustainMs !== undefined) safe.scaleUpSustainMs = value.scaleUpSustainMs
  if (value.replicaIdleMs !== undefined) safe.replicaIdleMs = value.replicaIdleMs
  if (value.isolateCwd !== undefined) safe.isolateCwd = value.isolateCwd
  return safe
}

export function agentConfigVersion(config: AgentConfig | null): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex")
}

function editableConfig(config: AgentConfig, role: WorkspaceRole): EditableAgentConfig {
  const { claudeArgs, appendSystemPrompt, ...safeRuntime } = config.runtime
  const runtime: EditableAgentConfig["runtime"] = {
    cwd: role === "operator" ? safeRuntime.cwd : "[redacted]",
  }
  if (safeRuntime.model !== undefined) runtime.model = safeRuntime.model
  if (safeRuntime.allowedTools !== undefined) runtime.allowedTools = [...safeRuntime.allowedTools]
  if (safeRuntime.resumable !== undefined) runtime.resumable = safeRuntime.resumable
  if (safeRuntime.useMemory !== undefined) runtime.useMemory = safeRuntime.useMemory
  if (safeRuntime.injectContext !== undefined) runtime.injectContext = safeRuntime.injectContext
  if (safeRuntime.overseer !== undefined) runtime.overseer = safeOverseer(safeRuntime.overseer)
  if (safeRuntime.sessionGovernor !== undefined) runtime.sessionGovernor = safeGovernor(safeRuntime.sessionGovernor)
  if (safeRuntime.maxQueueDepth !== undefined) runtime.maxQueueDepth = safeRuntime.maxQueueDepth
  if (safeRuntime.coalesceBurst !== undefined) runtime.coalesceBurst = safeRuntime.coalesceBurst
  if (safeRuntime.pool !== undefined) runtime.pool = safePool(safeRuntime.pool)
  if (safeRuntime.audit !== undefined) runtime.audit = safeRuntime.audit

  if (role === "operator") {
    if (claudeArgs !== undefined) runtime.claudeArgs = configuredValue()
    if (appendSystemPrompt !== undefined) runtime.appendSystemPrompt = configuredValue()
  }

  return {
    emoji: config.emoji,
    description: config.description,
    mode: config.mode,
    access: safeAccess(config.access),
    runtime,
  }
}

function projectedStatus(config: AgentConfig, status: AgentStatus | undefined): AgentSummaryView["status"] {
  if (config.mode === "ephemeral") return "idle"
  if (status?.alive !== true) return "offline"
  return status.busy ? "busy" : "idle"
}

export function projectAgentViews(
  configs: Record<string, AgentConfig>,
  statuses: AgentStatus[],
  overseers: OverseerStatus[],
  role: WorkspaceRole,
): AgentDetailView[] {
  const statusesByName = new Map(statuses.map(status => [status.name, status]))
  const overseersByName = new Map(overseers.map(overseer => [overseer.agent, overseer]))

  return Object.keys(configs).sort().map(name => {
    const config = configs[name]
    const runtime = statusesByName.get(name)
    const overseer = overseersByName.get(name)
    const currentWork = overseer === undefined
      ? null
      : { state: overseer.state, goal: overseer.goal, round: overseer.round, max: overseer.max }
    const operator = role === "operator"
    const persistentOperator = operator && config.mode === "persistent" && config.runtime.pool === undefined

    return {
      name,
      emoji: config.emoji,
      description: config.description,
      mode: config.mode,
      status: projectedStatus(config, runtime),
      queueDepth: runtime?.queueDepth ?? 0,
      contextFill: runtime?.fillPct ?? 0,
      costUsd: runtime?.costUsd ?? 0,
      replicas: runtime?.replicas ?? 1,
      lastActivityMs: runtime?.lastActivityMs ?? 0,
      currentTool: runtime?.currentTool ?? null,
      lastTool: runtime?.lastTool === undefined ? null : { ...runtime.lastTool },
      currentWork,
      model: config.runtime.model ?? null,
      version: agentConfigVersion(config),
      permissions: {
        configure: operator,
        reset: persistentOperator,
        restart: persistentOperator,
        remove: operator,
      },
      config: editableConfig(config, role),
    }
  })
}
