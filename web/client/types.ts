export type MessageOrigin = "web" | "agent" | "transport" | "system"
export type MessageState = "committed" | "queued" | "working" | "streaming" | "completed" | "failed"
export type SyncMode = "two_way" | "inbound_only" | "outbound_only" | "notifications_only"
export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline"

export interface SessionAgentSummary { name: string; alive: boolean; busy: boolean }
export interface Session {
  identity: string
  agents: SessionAgentSummary[]
  features: { agents: boolean; documents: boolean; turnSteps: boolean }
  permissions: { agents: "hidden" | "viewer" | "operator" }
}

export interface AgentPermissions {
  configure: boolean
  reset: boolean
  restart: boolean
  remove: boolean
}

export interface AgentSummary {
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

export interface AgentAccess {
  roles: string[]
  users?: string[]
  consultableBy?: string[]
  peerableBy?: string[]
}

export interface OverseerPolicy {
  enabled: boolean
  maxIterations?: number
  maxWallclockMs?: number
  model?: string
}

export interface GovernorPolicy {
  enabled: boolean
  softPct?: number
  hardPct?: number
  strategy?: "restart" | "cli"
}

export interface PoolPolicy {
  min?: number
  max?: number
  scaleUpQueue?: number
  scaleUpSustainMs?: number
  replicaIdleMs?: number
  isolateCwd?: boolean
}

export interface AgentRuntime {
  cwd: string
  provider?: "claude" | "codex"
  model?: string
  allowedTools?: string[]
  claudeArgs?: string[]
  codexArgs?: string[]
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access"
  appendSystemPrompt?: string
  resumable?: boolean
  useMemory?: boolean
  injectContext?: "always" | "onSwitch" | "never"
  overseer?: OverseerPolicy
  sessionGovernor?: GovernorPolicy
  maxQueueDepth?: number
  coalesceBurst?: boolean
  pool?: PoolPolicy
  audit?: boolean
}

export interface AgentConfig {
  emoji: string
  description: string
  mode: "persistent" | "ephemeral"
  access: AgentAccess
  runtime: AgentRuntime
}

export interface RedactedConfiguredValue { redacted: true; configured: true }

export interface EditableAgentConfig extends Omit<AgentConfig, "runtime"> {
  runtime: Omit<AgentRuntime, "claudeArgs" | "appendSystemPrompt"> & {
    claudeArgs?: string[] | RedactedConfiguredValue
    appendSystemPrompt?: string | RedactedConfiguredValue
  }
}

export interface AgentDetail extends AgentSummary { config: EditableAgentConfig }
export type AgentRuntimeAction = "reset" | "restart"
export type AgentChangeTier = "safe" | "hard" | "restart"

export interface AgentConfigPreview {
  id: string
  before: EditableAgentConfig | null
  after: EditableAgentConfig | null
  classification: { tier: AgentChangeTier; fullRestart: string[] }
  expiresAt: number
}

export interface AgentActionPreview {
  id: string
  actor: string
  agent: string
  action: AgentRuntimeAction
  statusVersion: string
  impact: { busy: boolean; queueDepth: number }
  expiresAt: number
}

export interface AgentConfigCommitResult { state: "applied"; restarted: string[]; fullRestart: string[] }
export interface AgentActionResult { state: "applied"; agent: string; action: AgentRuntimeAction }

export type AgentOperationsEvent = ({
  kind: "agent_changed"
  agent: string
  ts: number
} | {
  kind: "agents_snapshot"
  ts: number
} | {
  kind: "config_applied"
  agent: string
  ts: number
} | {
  kind: "action_completed"
  agent: string
  action: AgentRuntimeAction
  ts: number
} | {
  kind: "snapshot_required"
  ts: number
}) & { sequence: number }
export interface Conversation { id: string; title: string; primaryAgent: string; createdBy: string; createdAt: number; updatedAt: number; archivedAt: number | null }
export interface ConversationInput { title: string; primaryAgent: string }
export interface ConversationUpdate { title?: string; primaryAgent?: string }
export interface Message { id: string; conversationId: string; sequence: number; author: string; origin: MessageOrigin; content: string; replyTo: string | null; state: MessageState; clientKey: string | null; createdAt: number }
export interface PostMessageInput { content: string; clientKey: string; replyTo?: string }
export interface TransportLink { id: string; conversationId: string; adapter: string; externalLocationId: string; label: string | null; syncMode: SyncMode; enabled: boolean; createdAt: number; updatedAt: number }

export interface DocumentSummary {
  token: string
  filename: string
  title: string
  contentType: string
  mode: string
  ownerId: string
  ownerName: string
  visibility: "private" | "org"
  createdAt: string
  expiresAt: string | null
  conversationId: string | null
  sizeBytes: number
}
export interface UploadDocumentResult { token: string; url: string }
export interface DocumentAttachment { token: string; title: string; contentType: string; mode: string; visibility: string }

export type ToolStepStatus = "running" | "ok" | "error"
/** One tool call in an agent's turn — mirrors the hub's `ToolStepInfo`. Arrives twice
 *  (as `running`, then with its terminal status); the reducer pairs them by `id`. */
export interface ToolStep {
  id: string
  name: string
  summary?: string
  status: ToolStepStatus
  durationMs?: number
}

export interface ConversationEvent {
  kind: "message_committed" | "turn_state" | "activity" | "attachment" | "tool_step"
  conversationId: string
  sequence: number
  ts: number
  message?: Message
  state?: MessageState
  detail?: Record<string, unknown>
  attachment?: DocumentAttachment
  tool?: ToolStep
}
