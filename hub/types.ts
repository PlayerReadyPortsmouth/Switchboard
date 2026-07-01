/** A Discord message normalised for routing. */
export interface InboundMessage {
  chatId: string        // Discord channel id (DM channel or guild channel)
  messageId: string
  userId: string        // author snowflake
  user: string          // author username
  content: string
  ts: string            // ISO timestamp
  isDM: boolean
  attachments?: { name: string; type: string; size: number; url?: string }[]
  quote?: { user: string; content: string }   // the message this one quote-replies to
  forwards?: { content: string }[]             // forwarded message snapshot text (Discord forward feature; no author)
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

/** Per-turn token/cost usage parsed from a stream-json `result` event. The
 *  context-fill estimate is derived from these (see hub/usage.ts). */
export interface TurnUsage {
  inputTokens: number          // fresh (uncached) prompt tokens
  cacheReadTokens: number      // prompt tokens served from cache
  cacheCreationTokens: number  // prompt tokens written to cache this turn
  outputTokens: number         // tokens the model generated
  numTurns?: number            // cumulative turns in this session
  costUsd?: number             // cumulative session cost (USD)
  durationMs?: number          // wall time for this turn
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
  usage?: TurnUsage          // end-of-turn token/cost usage (kind === "reply")
}

export interface AgentAccess {
  roles: string[]       // role names; "*" means any paired user
  users?: string[]      // user snowflakes
  consultableBy?: string[]  // agent names allowed to consult this agent via ask_agent ("*" = any); absent ⇒ none
  peerableBy?: string[]   // remote peer names allowed to reach this agent via ask_peer ("*" = any); absent ⇒ none
}

/** Per-agent overseer policy: keep prodding the agent until a judge says the
 *  task is done, bounded by hard caps. Opt-in (absent ⇒ disabled). */
export interface OverseerPolicy {
  enabled: boolean
  maxIterations?: number   // default 4 — re-prods before giving up
  maxWallclockMs?: number  // default 600000 — total time budget per goal
  model?: string           // judge model; defaults to hub.overseerModel
}

/** Per-agent session governor: keep a persistent agent's context bounded by
 *  nudging it to checkpoint to memory at `softPct`, then auto-compacting (handoff
 *  → reset → reseed) at `hardPct`. Opt-in (absent ⇒ disabled). */
export interface GovernorPolicy {
  enabled: boolean
  softPct?: number   // checkpoint-nudge threshold, 0..1 (default 0.75)
  hardPct?: number   // auto-compaction threshold, 0..1 (default 0.90)
  strategy?: "restart" | "cli"  // compaction mechanism (default "restart")
}

/** Per-agent auto-scaling pool: back a logical persistent agent with 1..N
 *  replicas that scale out under sustained queue pressure. Opt-in (absent ⇒ a
 *  single transport, exactly as before). */
export interface PoolPolicy {
  min?: number              // floor on live replicas (default 1 — the primary)
  max?: number              // cap on replicas (default 3)
  scaleUpQueue?: number     // total queued across replicas that signals pressure (default 2)
  scaleUpSustainMs?: number // pressure must hold this long before scaling up (default 30000)
  replicaIdleMs?: number    // idle this long ⇒ a spare replica retires (default 600000)
  isolateCwd?: boolean      // give each replica its own worktree (writers; default false)
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
  sessionGovernor?: GovernorPolicy  // opt-in context-window governance (checkpoint + auto-compact)
  maxQueueDepth?: number     // turn-gate inbound queue cap (default 8); past it, submissions overflow
  coalesceBurst?: boolean    // fold consecutive same-conversation queued messages into one turn
  pool?: PoolPolicy          // opt-in replica auto-scaling for a hot persistent agent
  audit?: boolean            // per-agent audit opt-out: false ⇒ skip this agent's events even when hub audit is on
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
  // Session health, live status & scaling (all optional; default off/derived).
  contextWindows?: Record<string, number>  // model id → context window (tokens); `default` is the fallback
  statusChannelId?: string       // channel for the live status embed (absent ⇒ board off)
  statusRefreshMs?: number       // status board heartbeat cadence (default 15000)
  metricsPort?: number           // port for the Prometheus /metrics + /health listener (absent ⇒ off)
  metricsHost?: string           // bind host for the metrics listener (default 127.0.0.1; set 0.0.0.0 to expose)
  webPort?: number               // port for the read-only web dashboard (absent ⇒ off)
  webHost?: string               // bind host for the web dashboard (default 127.0.0.1; set 0.0.0.0 to expose)
  audit?: AuditConfig            // append-only ledger of every governed effect (default off)
  escalation?: EscalationConfig  // re-run a turn at higher effort: manual !hard + auto on tool errors (default off)
  approvals?: ApprovalConfig     // human-in-the-loop approval gate for requireApproval effects (default off)
  consult?: ConsultConfig        // inter-agent ask_agent tool (default off; per-agent access via consultableBy)
  peering?: PeeringConfig        // cross-VPS hub liaison (default off; per-agent access via peerableBy)
  workflows?: WorkflowRoute[]    // declarative multi-step agent missions (run via !run)
  workflow?: WorkflowConfig      // workflow engine config (default off)
  attachments?: AttachmentConfig // pass Discord file uploads through to agents (default off)
  outboundAttachments?: OutboundAttachmentConfig // agents attach produced files to Discord (default off)
  shareLinks?: ShareLinksConfig  // publish_link: agents publish staff-only Entra-gated artifact URLs (default off)
  toolObservability?: ToolObservabilityConfig  // capture + surface per-agent tool usage (default off)
  memoryBrowse?: MemoryBrowseConfig  // operator memory browse & forget UI (default off)
}

/** Discord file-upload passthrough. Absent/disabled ⇒ uploads are ignored exactly
 *  as before (only message text reaches the agent). When enabled, the hub downloads
 *  each upload to `dir` and folds a breadcrumb of local paths into the agent's turn. */
export interface AttachmentConfig {
  enabled?: boolean              // master switch (default off)
  maxBytes?: number              // skip downloads larger than this (default 10485760 = 10 MB)
  dir?: string                   // download directory (default <stateDir>/attachments)
}

/** Capture tool_use/tool_result from the agent stream and surface it: live tool
 *  in the status board, a per-agent tally embed, and the !tools command. Absent/
 *  disabled ⇒ no capture/board/command (byte-identical). */
export interface ToolObservabilityConfig {
  enabled?: boolean           // master switch (default off)
  channelId?: string          // where to post the tool board (default: statusChannelId)
}

/** Operator-only card UI to browse/search the vault and forget (archive) or
 *  delete notes. Absent/disabled ⇒ the !memory command is unregistered and
 *  mem: buttons are ignored (byte-identical). */
export interface MemoryBrowseConfig {
  enabled?: boolean         // master switch (default off)
  operatorIds?: string[]    // user ids allowed to use it; empty ⇒ [deployApproverUserId]
}

/** Agent-initiated outbound file attachments. Absent/disabled ⇒ the attach_file
 *  tool is not offered and any stray attach frame is ignored (byte-identical to
 *  before). When enabled, an agent may attach a file it wrote into its per-agent
 *  outbox (`<outboxDir>/<agent>/`); the hub validates containment + size before
 *  posting it to Discord. */
export interface OutboundAttachmentConfig {
  enabled?: boolean              // master switch (default off)
  outboxDir?: string             // base outbox dir (default <stateDir>/outbox)
  maxBytes?: number              // reject larger files (default 8388608 = 8 MB)
  allowedExtensions?: string[]   // empty/absent = allow any; e.g. ["md","pdf","png","csv"]
}

/** publish_link producer. Absent/disabled ⇒ the tool is not offered and a stray
 *  publish frame is ignored (byte-identical). Writes <artifactsDir>/<token>/ for
 *  the RA /share renderer; agents publish from their own outbox. */
export interface ShareLinksConfig {
  enabled?: boolean
  artifactsDir?: string          // shared with the RA renderer (default <stateDir>/share-artifacts)
  raHost?: string                // default "readyapp.player-ready.co.uk"
  defaultTtlDays?: number        // default 30
  maxBytes?: number              // default 26214400 (25 MB)
  cleanupIntervalMs?: number     // default 86400000 (daily)
}

/** One step of a workflow: run `agent` with a templated `prompt` ({{input}} and
 *  {{steps.<id>}} interpolate the run input and prior step outputs). */
export interface WorkflowStep {
  id: string
  agent: string
  prompt: string
}

/** A declarative multi-step agent mission. Steps run in order; each step's output
 *  feeds the next. Steps target persistent (registered) agents. */
export interface WorkflowRoute {
  id: string
  description?: string
  enabled?: boolean              // default true (when the engine is enabled)
  steps: WorkflowStep[]
}

/** Workflow engine config. Absent/disabled ⇒ no missions run. */
export interface WorkflowConfig {
  enabled?: boolean              // master switch (default off)
  stepTimeoutMs?: number         // per-step hub-side wait (default 120000)
}

export interface PeerDef {
  name: string        // logical peer id, e.g. "hub-b"
  baseUrl: string     // peer's reachable origin, e.g. "http://127.0.0.1:8788"
  secretEnv: string   // env var holding this peer's shared HMAC secret
}

export interface PeeringConfig {
  enabled?: boolean
  listenPath?: string          // default "/peer"
  selfName: string             // this hub's identity to peers
  selfBaseUrl: string          // this hub's reachable base, for ask replyTo
  askTimeoutMs?: number        // default 300000
  mirrorChannelId?: string | null
  dedupeWindowMs?: number      // default 600000
  maxClockSkewMs?: number      // default 120000
  ratePerPeerPerMin?: number   // default 0 (off)
  notifyRetry?: { maxAttempts?: number; baseDelayMs?: number }
  peers: PeerDef[]
}

/** Inter-agent consult config. Absent/disabled ⇒ the ask_agent tool isn't even
 *  exposed to agents. Per-pair access is still governed by `access.consultableBy`. */
export interface ConsultConfig {
  enabled?: boolean              // expose ask_agent + honor consults (default off)
  timeoutMs?: number             // hub-side wait for the target's reply (default 90000)
}

// Audit log — one append-only ledger of every governed effect (hub/audit.ts).
export type AuditKind =
  | "route" | "spawn" | "exec" | "outbound"
  | "session" | "access" | "approval" | "event" | "card" | "consult" | "mission"
  | "liaison"

/** One ledger record: who (`actor`) did what (`kind`/`action`) to what (`target`)
 *  in which conversation (`chat`), and how it resolved (`outcome`). Metadata only
 *  — never message bodies; secrets in `detail` are redacted before append. */
export interface AuditEvent {
  ts: number                     // ms epoch
  kind: AuditKind                // category
  actor: string                  // "user:<id>" | "agent:<name>" | "hub" | "schedule:<id>"
  action: string                 // verb within the kind
  outcome: "ok" | "deny" | "error" | "pending"
  target?: string                // agent name / route id / command id / channel
  chat?: string                  // chat key — threads a conversation's effects together
  detail?: Record<string, unknown>  // kind-specific, redacted, no message content
  cost?: number                  // optional usd (turn cost) for rollups
  corr?: string                  // optional correlation id across a multi-step action
}

/** Input to `auditEvent` / `AuditLog.record` — `ts` and `outcome` are defaulted. */
export interface AuditInput {
  kind: AuditKind
  actor: string
  action: string
  outcome?: AuditEvent["outcome"]
  target?: string
  chat?: string
  detail?: Record<string, unknown>
  cost?: number
  corr?: string
  ts?: number
}

/** Query filter for `!audit`. Equality on every field except `actor` (exact, or
 *  prefix when it ends in `:`) and `since` (a `ts` lower bound). */
export interface AuditFilter {
  kind?: AuditKind
  actor?: string
  chat?: string
  action?: string
  outcome?: AuditEvent["outcome"]
  since?: number
  limit?: number
}

export interface AuditSummary {
  total: number
  byKind: Record<string, number>
  byOutcome: Record<string, number>
  costUsd: number
  actors: number
}

/** Approval-gate config (all optional; absent/disabled ⇒ `requireApproval` is
 *  inert, no behaviour change). When enabled, a `requireApproval` effect parks
 *  for an authorized human's grant before it fires. */
export interface ApprovalConfig {
  enabled?: boolean              // master switch; off ⇒ requireApproval flags are inert
  channelId?: string             // channel for approval cards (default: the effect's origin chat)
  approvers?: string[]           // Discord user ids who may approve (default: [deployApproverUserId])
  ttlMs?: number                 // pending approval timeout → auto-deny (default 3600000 = 1h)
}

/** Audit-log config (all optional; absent ⇒ no ledger, no behaviour change). */
export interface AuditConfig {
  enabled?: boolean              // default false
  file?: string                 // default <stateDir>/audit.jsonl
  kinds?: AuditKind[]            // optional allowlist of kinds to record (omit ⇒ all)
  redactEnv?: string[]          // extra secret env names whose values are masked in detail
  maxBytes?: number             // optional size-based rotation threshold
  keepFiles?: number            // optional rotated-file retention count
}

/** Effort escalation: re-run a turn on a stronger, short-lived ephemeral clone.
 *  Manual via `!hard`; auto when a turn's tool results carry error signals (bounded
 *  by `autoMaxPerHour`). Default off. */
export interface EscalationConfig {
  enabled?: boolean              // master switch (default false)
  model?: string                // stronger model for the clone (absent ⇒ keep the agent's model)
  claudeArgs?: string[]          // extra CLI args for the clone (e.g. a reasoning-effort flag)
  auto?: boolean                 // auto-escalate on tool errors (default false; !hard works regardless)
  autoMaxPerHour?: number        // rate cap for auto escalations (default 4; 0 disables auto)
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
