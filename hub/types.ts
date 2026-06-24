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
  quote?: { user: string; content: string }   // the message this one quote-replies to
}

/** A text-input popup a button can open instead of acting immediately. */
export interface CardModal {
  title: string;
  inputs: {
    id: string;                         // field key returned on submit
    label: string;
    style: "short" | "paragraph";
    placeholder?: string;
    required?: boolean;
  }[];                                  // ≤5 inputs (Discord limit)
}

/** A rich card an agent asks the hub to post: an embed + rows of buttons. */
export interface CardButton {
  customId: string;          // e.g. "ns:action:arg" (ns≠"perm") — routed by NotifyRouter
  label: string;
  style?: "primary" | "secondary" | "success" | "danger";
  emoji?: string;
  modal?: CardModal;         // if set, clicking opens this modal instead of relaying
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
  kind: "reply" | "react" | "edit" | "card" | "update"
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

/** Per-agent overseer policy: keep prodding the agent until a judge says the
 *  task is done, bounded by hard caps. Opt-in (absent ⇒ disabled). */
export interface OverseerPolicy {
  enabled: boolean
  maxIterations?: number   // default 4 — re-prods before giving up
  maxWallclockMs?: number  // default 600000 — total time budget per goal
  model?: string           // judge model; defaults to hub.overseerModel
}

export interface AgentRuntime {
  cwd: string
  model?: string
  allowedTools?: string[]      // ephemeral only
  claudeArgs?: string[]        // extra flags appended to the agent's `claude` invocation
  appendSystemPrompt?: string
  resumable?: boolean        // persistent agent: persist + --resume its CLI session
  useMemory?: boolean        // inject relevant memory-vault notes as context
  injectContext?: "always" | "onSwitch" | "never"  // recent-message cache injection (default onSwitch)
  overseer?: OverseerPolicy  // opt-in autonomous "keep prodding until done" loop
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

/** A scheduled message delivered to an agent.
 *  Two firing modes (backward-compatible):
 *   - `cron`: standard 5-field cron "m h dom mon dow", evaluated in `tz`
 *     (default = hub `timezone`, default "Europe/London"). Takes precedence.
 *   - `hourUtc`: legacy daily-at-UTC-hour (fires once at HH:00 UTC). Used only
 *     when `cron` is absent. */
export interface ScheduleRoute {
  id: string            // unique id; one minute-bucket is tracked per id
  agent: string
  channelId: string
  message: string       // message content delivered at the scheduled time
  cron?: string         // 5-field cron expression (preferred); overrides hourUtc
  tz?: string           // IANA tz for this entry (default: hub timezone)
  hourUtc?: number      // legacy: UTC hour (0–23) to fire at, once daily
}

/** An exact-match chat command that delivers a canned message to an agent. */
export interface CommandRoute {
  match: string         // inbound trimmed content must equal this exactly
  agent: string
  channelId: string
  message: string       // message delivered to the agent on a match
  allowlistOnly?: boolean   // if set, only base-gate-allowlisted users may trigger
}

/** A button namespace whose click runs a hub-side command instead of relaying
 *  to the agent. Matched by `namespace:action` against a clicked customId. */
export interface GatedAction {
  namespace: string;         // matches the customId ns,    e.g. "deploy"
  action: string;            // matches the customId action, e.g. "go"
  approverOnly?: boolean;    // require deployApproverUserId
  command: string;           // hub-side shell command; $arg = the customId arg
  terminateAgent?: boolean;  // tear down the card's owning agent on success
  pendingText: string;       // card body while the command runs ($arg interpolated)
  successText: string;       // card body on exit 0           ($arg interpolated)
  failureText: string;       // card body on non-zero exit    ($arg interpolated)
}

/** When a spawn trigger fires, optionally edit an existing card to a handoff
 *  state (e.g. "working"). Templates interpolate $1,$2… and $jobId. */
export interface SpawnCardUpdate {
  correlationId: string;
  title: string;
  body: string;
  buttons: CardButton[];
}

/** When ANY agent's outbound text matches `pattern`, spawn `agent` to run a task. */
export interface SpawnTrigger {
  pattern: string       // regex tested against outbound agent text
  agent: string         // ephemeral agent to spawn
  taskTemplate: string  // task text; $1,$2… = capture groups, $jobId = generated id
  setupCommand?: string // optional shell command run first (same interpolation)
  teardownCommand?: string // optional shell command run after the spawned agent ends (same interpolation)
  onSpawnCard?: SpawnCardUpdate // if set, edit this card to a handoff state when the trigger fires
}

/** Pin a channel to a specific agent: messages there bypass the router and go
 *  straight to `agent`. Optional `clearReaction` (a unicode emoji name) resets
 *  that agent's session when an allowlisted user reacts with it. */
export interface ChannelAgent {
  channelId: string;
  agent: string;
  clearReaction?: string;
}

/** A keyword chat command that runs dedicated code (shell or HTTP) and formats
 *  the result — no model in the loop, unless `formatAgent` is set (then the raw
 *  result is handed to that agent to format/reply). The "Tier B" surface that
 *  ports deterministic monolith commands. */
export type DirectExec =
  | { type: "shell"; command: string }   // $args / $1… interpolated
  | { type: "http"; url: string; method?: string; headers?: Record<string, string>; secretEnv?: string; bodyTemplate?: string }

export interface DirectCommand {
  match: string             // keyword; matches exact, or as a prefix with trailing args
  exec: DirectExec
  render?: "text" | "card"  // default text
  template?: string         // deterministic formatting: $args/$N + {{json.path}}; omit ⇒ raw output
  cardTitle?: string        // title when render === "card"
  formatAgent?: string      // bridge: hand the raw result to this agent to format/reply
  allowlistOnly?: boolean   // only base-gate-allowlisted users may trigger
}

/** A named outbound destination the hub can POST to. Agents address it by `id`
 *  (via the post_webhook tool) — they never supply a URL, so there is no
 *  arbitrary-URL exfiltration path. An optional `pattern` makes it also fire on
 *  matching agent outbound text (like spawnTriggers). */
export interface OutboundRoute {
  id: string                // address for post_webhook / hub events; the log key
  url: string               // destination (operator-configured, never agent-supplied)
  pattern?: string          // optional: agent outbound-text regex trigger ($1.. = groups)
  secretEnv?: string        // optional: env var holding the HMAC signing secret
  method?: string           // default POST
  headers?: Record<string, string>  // optional static headers
  template?: string         // optional body template ($1.. from groups); omit ⇒ raw text/body
  consume?: boolean         // text-trigger: if set, the matched text is NOT also sent to Discord
  requireApproval?: boolean // reserved: gate behind the deploy-approver before firing (future)
}

export interface HubConfig {
  botTokenEnv: string
  guildIds: string[]
  socketPath: string
  stateDir: string
  routerModel: string
  switchThreshold: number
  timezone?: string             // default tz for cron schedules (default "Europe/London")
  defaultAgent: string
  ephemeralTimeoutMs: number
  tagStyle: "prefix" | "embed"
  chatKeyScope: "user" | "channel"
  webhooks?: WebhookRoute[]      // inbound HTTP webhooks → agent cards
  schedules?: ScheduleRoute[]    // daily UTC-scheduled agent messages
  commands?: CommandRoute[]      // exact-match chat commands → agent messages
  directCommands?: DirectCommand[]  // keyword → shell/HTTP exec → formatted reply/card (Tier B)
  outboundWebhooks?: OutboundRoute[]  // named/text-triggered signed outbound HTTP POSTs
  outboundAllowedHosts?: string[]   // optional allowlist of destination hosts (defense-in-depth)
  outboundRetries?: number          // outbound delivery attempts before dead-letter (default 3)
  spawnTriggers?: SpawnTrigger[] // outbound-text patterns → ephemeral-agent spawns
  webhookPort?: number           // single HTTP listener port for all webhooks[].path
  deployApproverUserId?: string  // Discord user id allowed to press deploy:* buttons
  gatedActions?: GatedAction[]   // hub-side button handlers that run shell commands
  channelAgents?: ChannelAgent[]  // channels pinned to a specific agent
  // Memory & context (all optional; sensible defaults applied in index.ts).
  memoryDir?: string             // Obsidian-style note vault root (default <stateDir>/memory)
  contextCacheSize?: number      // recent-message ring-buffer cap per conversation (default 20)
  distillIdleMs?: number         // idle gap before a conversation is distilled to notes (default 600000)
  librarianModel?: string        // model that ranks recalled notes for relevance (default routerModel)
  distillerModel?: string        // model that distills a conversation into notes
  overseerModel?: string         // default judge model for overseen agents
  memory?: MemoryBackend         // recall index + embedder backend selection (default: all local)
  gardener?: GardenerConfig      // access-weighting + periodic vault hygiene (default: off)
}

/** Access-weighted recall + the periodic vault-tending pass. Absent ⇒ recall
 *  stays pure-cosine and no gardening runs (access hits are still recorded). */
export interface GardenerConfig {
  enabled?: boolean              // run the periodic gardener pass
  intervalMs?: number            // gardener cadence (default 6h)
  importanceWeight?: number      // usage boost on recall rank (default 0.15 when present)
  hotSetSize?: number            // notes injected proactively by importance (default 3 when present)
  decayHalfLifeMs?: number       // importance decay half-life (default 14d)
  staleAfterMs?: number          // age past which a note is flagged stale (default 30d)
  archiveAfterMs?: number        // cold-for-this-long ⇒ archive candidate (default 90d)
  scopeBudget?: number           // notes per scope before archival kicks in (default 200)
}

/** Selects the memory recall index and embedder. Defaults are fully local
 *  (in-process ONNX embeddings + in-memory cosine index, no secrets). */
export interface MemoryBackend {
  index?: "local" | "qdrant"     // default local
  embedder?: "local" | "openai"  // default local
  qdrant?: { url: string; apiKeyEnv?: string; collection?: string }
  openai?: { baseUrl: string; apiKeyEnv?: string; model: string }  // OpenAI-compatible /embeddings
}
