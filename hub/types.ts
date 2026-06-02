/** A Discord message normalised for routing. */
export interface InboundMessage {
  chatId: string        // Discord channel id (DM channel or guild channel)
  messageId: string
  userId: string        // author snowflake
  user: string          // author username
  content: string
  ts: string            // ISO timestamp
  isDM: boolean
  attachments?: { name: string; type: string; size: number }[]
}

/** A request from an agent back out to Discord. */
export interface AgentReply {
  agent: string
  kind: "reply" | "react" | "edit"
  chatId: string
  text?: string
  messageId?: string    // for react/edit
  emoji?: string        // for react
  replyTo?: string      // for reply threading
  files?: string[]      // absolute paths for reply attachments
}

export interface AgentAccess {
  roles: string[]       // role names; "*" means any paired user
  users?: string[]      // user snowflakes
}

export interface AgentRuntime {
  cwd: string
  model?: string
  allowedTools?: string[]      // ephemeral only
  claudeArgs?: string[]        // persistent: extra flags for claude --channels
  appendSystemPrompt?: string
}

export interface AgentConfig {
  emoji: string
  description: string
  mode: "persistent" | "ephemeral"
  access: AgentAccess
  runtime: AgentRuntime
}

export type AgentRegistry = Record<string, AgentConfig>

export interface HubConfig {
  botTokenEnv: string
  guildIds: string[]
  socketPath: string
  stateDir: string
  routerModel: string
  switchThreshold: number
  defaultAgent: string
  ephemeralTimeoutMs: number
  tagStyle: "prefix" | "embed"
  chatKeyScope: "user" | "channel"
}
