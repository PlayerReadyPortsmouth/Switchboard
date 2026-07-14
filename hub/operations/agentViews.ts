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

export function agentConfigVersion(config: AgentConfig | null): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex")
}

function editableConfig(config: AgentConfig, role: WorkspaceRole): EditableAgentConfig {
  const { claudeArgs, appendSystemPrompt, ...safeRuntime } = config.runtime
  const runtime: EditableAgentConfig["runtime"] = {
    cwd: role === "operator" ? safeRuntime.cwd : "[redacted]",
  }
  const safeKeys = ["model", "allowedTools", "resumable", "useMemory", "injectContext", "overseer", "sessionGovernor", "maxQueueDepth", "coalesceBurst", "pool", "audit"] as const
  const runtimeRecord = runtime as unknown as Record<string, unknown>
  for (const key of safeKeys) if (safeRuntime[key] !== undefined) runtimeRecord[key] = structuredClone(safeRuntime[key])

  if (role === "operator") {
    if (claudeArgs !== undefined) runtime.claudeArgs = configuredValue()
    if (appendSystemPrompt !== undefined) runtime.appendSystemPrompt = configuredValue()
  }

  return {
    emoji: config.emoji,
    description: config.description,
    mode: config.mode,
    access: structuredClone(config.access),
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
