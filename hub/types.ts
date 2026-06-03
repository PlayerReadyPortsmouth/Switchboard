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

/** A rich card an agent asks the hub to post: an embed + rows of buttons. */
export interface CardButton {
  customId: string;          // e.g. "ns:action:arg" (ns≠"perm") — routed by NotifyRouter
  label: string;
  style?: "primary" | "secondary" | "success" | "danger";
  emoji?: string;
}
export interface CardSpec {
  title: string;
  body: string;              // embed description (markdown)
  fields?: { name: string; value: string; inline?: boolean }[];
  buttons: CardButton[];     // one row; ≤5 buttons (Discord limit)
  footer?: string;
}

/** A request from an agent back out to Discord. */
export interface AgentReply {
  agent: string
  kind: "reply" | "react" | "edit" | "card"
  chatId: string
  text?: string
  messageId?: string    // for react/edit
  emoji?: string        // for react
  replyTo?: string      // for reply threading
  files?: string[]      // absolute paths for reply attachments
  card?: CardSpec            // present when kind === "card"
  correlationId?: string    // ties a posted card's buttons back to the agent
}

export interface AgentAccess {
  roles: string[]       // role names; "*" means any paired user
  users?: string[]      // user snowflakes
}

export interface AgentRuntime {
  cwd: string
  model?: string
  allowedTools?: string[]      // ephemeral only
  claudeArgs?: string[]        // extra flags appended to the agent's `claude` invocation
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

/** An inbound HTTP webhook → agent card. One HTTP listener (on `webhookPort`)
 *  fans out to these by `path`; each verifies an HMAC secret and delivers the
 *  raw body (optionally prefixed) to `agent` scoped to `channelId`. */
export interface WebhookRoute {
  path: string          // URL path to match, e.g. "/hooks/builds"
  secretEnv: string     // env var name holding this route's HMAC secret
  agent: string         // agent that receives the delivered body
  channelId: string     // channel the delivery is scoped to
  prefix?: string       // optional token prepended to the raw body
}

/** A daily UTC-scheduled message delivered to an agent. */
export interface ScheduleRoute {
  id: string            // unique id; one run-bucket is tracked per id
  hourUtc: number       // UTC hour (0–23) to fire at
  agent: string
  channelId: string
  message: string       // message content delivered at the scheduled time
}

/** An exact-match chat command that delivers a canned message to an agent. */
export interface CommandRoute {
  match: string         // inbound trimmed content must equal this exactly
  agent: string
  channelId: string
  message: string       // message delivered to the agent on a match
  allowlistOnly?: boolean   // if set, only base-gate-allowlisted users may trigger
}

/** When ANY agent's outbound text matches `pattern`, spawn `agent` to run a task. */
export interface SpawnTrigger {
  pattern: string       // regex tested against outbound agent text
  agent: string         // ephemeral agent to spawn
  taskTemplate: string  // task text; $1,$2… = capture groups, $jobId = generated id
  setupCommand?: string // optional shell command run first (same interpolation)
  teardownCommand?: string // optional shell command run after the spawned agent ends (same interpolation)
}

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
  webhooks?: WebhookRoute[]      // inbound HTTP webhooks → agent cards
  schedules?: ScheduleRoute[]    // daily UTC-scheduled agent messages
  commands?: CommandRoute[]      // exact-match chat commands → agent messages
  spawnTriggers?: SpawnTrigger[] // outbound-text patterns → ephemeral-agent spawns
  webhookPort?: number           // single HTTP listener port for all webhooks[].path
  deployApproverUserId?: string  // Discord user id allowed to press deploy:* buttons
}
