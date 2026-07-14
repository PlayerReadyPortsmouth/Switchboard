# Phase 4A Agents Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a responsive, transport-independent Agents destination with live runtime visibility, guided and JSON configuration, and protected reset/restart/removal controls while preserving Discord and `/legacy`.

**Architecture:** A new `AgentOperationsService` owns authorization, stable view models, preview/confirm safety, idempotency, and events. `hub/webServer.ts` remains an HTTP adapter, `hub/index.ts` injects runtime/file/audit dependencies, and the React workspace consumes typed APIs and an ordered SSE stream. Existing legacy agent routes delegate to the same service and remain usable throughout the rollout.

**Tech Stack:** Bun, TypeScript, React 19, Bun test, Testing Library, SQLite-backed canonical conversation services, Server-Sent Events, Playwright, existing PWA shell.

## Global Constraints

- This plan implements only the Phase 4A **Agents** vertical. Approvals, Operations, Settings, attachments, consultations, delegations, and handoff remain separate plans.
- Discord must remain fully functional, but no Agents workspace code may call Discord-specific logic.
- `/legacy` and its agent editor remain available after this plan.
- The Agents navigation entry is controlled by `hub.workspace.features.agents`; absent or `false` means hidden and direct workspace/API access returns `404`.
- Trusted upstream SSO identity continues to come from `hub.webIdentityHeader`; this plan adds authorization, not a second login screen.
- If `workspace.viewers` and `workspace.operators` are both absent, every trusted identity keeps legacy operator access. Once either list is configured, matching is explicit; `"*"` is supported.
- Operators may view and mutate Agents data. Viewers may view redacted Agents data but receive `403` for mutations. Unlisted identities receive `404` for Agents resources.
- Configuration confirmation uses a short-lived, single-use, user-bound preview plus a fresh drift check. A full hub restart is never triggered automatically.
- Reset and restart confirmations are user-bound and idempotent. Removal is a configuration change to `null` and is saved pending the existing full-restart classification.
- No resolved secrets or unredacted sensitive runtime arguments are returned to the browser or audit ledger.
- No new runtime or frontend package dependency is introduced.
- Desktop, tablet, and mobile behavior, keyboard access, focus restoration, reduced motion, and offline/error states are required.

## File Structure

- `hub/operations/access.ts` — workspace feature and view/manage permission resolution.
- `hub/operations/agentViews.ts` — stable, redacted Agents API view models and resource versions.
- `hub/operations/agentEvents.ts` — ordered in-memory Agents event stream with replay-gap signaling.
- `hub/operations/operationPreview.ts` — user-bound action previews and idempotent result cache.
- `hub/operations/agentService.ts` — Agents application service; no HTTP or Discord imports.
- `hub/webServer.ts` — legacy-compatible and `/api/operations/agents` HTTP/SSE adapters.
- `hub/index.ts` — inject file/runtime/status/audit dependencies and publish live state.
- `web/client/routes.ts` — destination and selected-agent route parsing.
- `web/client/agentStream.ts` — reconnecting ordered Agents SSE client.
- `web/client/components/AgentsWorkspace.tsx` — destination state and responsive composition.
- `web/client/components/AgentList.tsx` — searchable master list.
- `web/client/components/AgentDetail.tsx` — overview, session, configuration, and activity tabs.
- `web/client/components/AgentConfigEditor.tsx` — shared guided/JSON draft and diff confirmation.
- `web/client/components/AgentActionDialog.tsx` — reset/restart/remove preview and confirmation.
- `web/client/components/AppRail.tsx` — feature-aware destinations and active state.
- `web/client/App.tsx` — lightweight destination router around the existing conversation workspace.

---

### Task 1: Workspace Feature Flag and Access Policy

**Files:**
- Create: `hub/operations/access.ts`
- Create: `hub/operations/access.test.ts`
- Modify: `hub/types.ts`
- Modify: `hub/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/hub.config.json`

**Interfaces:**
- Produces: `WorkspaceConfig`, `WorkspaceRole`, `agentsFeatureEnabled(config)`, and `resolveWorkspaceRole(identity, config)`.
- Consumes: trusted identity strings already returned by `WebDeps.requireUser`.

- [ ] **Step 1: Write failing access-policy tests**

```ts
import { expect, test } from "bun:test"
import { agentsFeatureEnabled, resolveWorkspaceRole } from "./access"

test("agents stays hidden until explicitly enabled", () => {
  expect(agentsFeatureEnabled(undefined)).toBe(false)
  expect(agentsFeatureEnabled({ features: { agents: true } })).toBe(true)
})

test("an unconfigured policy preserves trusted-header operator compatibility", () => {
  expect(resolveWorkspaceRole("ada@example.com", undefined)).toBe("operator")
})

test("configured lists distinguish viewer, operator, wildcard, and hidden", () => {
  const config = { viewers: ["viewer@example.com"], operators: ["ops@example.com"] }
  expect(resolveWorkspaceRole("viewer@example.com", config)).toBe("viewer")
  expect(resolveWorkspaceRole("ops@example.com", config)).toBe("operator")
  expect(resolveWorkspaceRole("other@example.com", config)).toBe("hidden")
  expect(resolveWorkspaceRole("anyone@example.com", { viewers: ["*"] })).toBe("viewer")
})
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `bun test hub/operations/access.test.ts`

Expected: FAIL because `hub/operations/access.ts` does not exist.

- [ ] **Step 3: Add the configuration types and pure resolver**

Add to `hub/types.ts`:

```ts
export interface WorkspaceConfig {
  features?: {
    agents?: boolean
    approvals?: boolean
    operations?: boolean
    settings?: boolean
  }
  viewers?: string[]
  operators?: string[]
}

// In HubConfig:
workspace?: WorkspaceConfig
```

Create `hub/operations/access.ts`:

```ts
import type { WorkspaceConfig } from "../types"

export type WorkspaceRole = "hidden" | "viewer" | "operator"

export const agentsFeatureEnabled = (config: WorkspaceConfig | undefined): boolean =>
  config?.features?.agents === true

const matches = (identity: string, entries: string[] | undefined): boolean =>
  entries?.some(entry => entry === "*" || entry === identity) === true

export function resolveWorkspaceRole(identity: string, config: WorkspaceConfig | undefined): WorkspaceRole {
  if (config?.viewers === undefined && config?.operators === undefined) return "operator"
  if (matches(identity, config.operators)) return "operator"
  if (matches(identity, config.viewers)) return "viewer"
  return "hidden"
}
```

Do not normalize configured identities: the upstream proxy owns identity normalization, and Switchboard must compare exactly what it trusts.

- [ ] **Step 4: Validate workspace configuration and enable the sample deployment**

In `hub/config.ts`, reject non-array or non-string access entries using one focused helper:

```ts
function validateWorkspaceAccess(hub: HubConfig): void {
  for (const [name, value] of [["viewers", hub.workspace?.viewers], ["operators", hub.workspace?.operators]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !entry))) {
      throw new Error(`config: workspace.${name} must be a non-empty string array`)
    }
  }
}
```

Call it after `webIdentityHeader` validation. Add config tests for invalid entries and add this example block to `config/hub.config.json`:

```json
"workspace": {
  "features": { "agents": true },
  "viewers": ["*"],
  "operators": ["*"]
}
```

This sample preserves the current trusted-SSO behavior. Documentation in Task 9 shows how to replace the operator wildcard with explicit identities.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test hub/operations/access.test.ts tests/config.test.ts && bun run typecheck`

Expected: all selected tests pass and TypeScript exits successfully.

- [ ] **Step 6: Commit the access boundary**

```bash
git add hub/operations/access.ts hub/operations/access.test.ts hub/types.ts hub/config.ts tests/config.test.ts config/hub.config.json
git commit -m "feat(web): add workspace feature and access policy"
```

---

### Task 2: Stable Agent Views and Ordered Events

**Files:**
- Create: `hub/operations/agentViews.ts`
- Create: `hub/operations/agentViews.test.ts`
- Create: `hub/operations/agentEvents.ts`
- Create: `hub/operations/agentEvents.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `AgentStatus`, `OverseerStatus`, and `WorkspaceRole`.
- Produces: `AgentSummaryView`, `AgentDetailView`, `agentConfigVersion`, `projectAgentViews`, `AgentOperationsEvent`, and `AgentEventStream`.

- [ ] **Step 1: Write failing projection and redaction tests**

```ts
test("viewer projections expose operational state and a redacted config", () => {
  const [view] = projectAgentViews({ qa: config }, [status], [], "viewer")
  expect(view).toMatchObject({ name: "qa", status: "busy", queueDepth: 2, contextFill: 0.4 })
  expect(view.config.runtime.cwd).toBe("[redacted]")
  expect(view.permissions).toEqual({ configure: false, reset: false, restart: false, remove: false })
})

test("operator projections retain editable non-secret config", () => {
  const [view] = projectAgentViews({ qa: config }, [status], [], "operator")
  expect(view.config.runtime.cwd).toBe("~")
  expect(view.permissions.configure).toBe(true)
  expect(view.version).toBe(agentConfigVersion(config))
})
```

Use a test config containing `runtime.claudeArgs: ["--permission-prompt-tool", "secret-looking-value"]`; the projected view must omit `claudeArgs` entirely for both roles. The Advanced JSON editor receives a separately sanitized editable config whose forbidden keys cannot be submitted.

- [ ] **Step 2: Write failing replay and gap tests**

```ts
test("events are ordered and replay after a cursor", () => {
  const stream = new AgentEventStream(3)
  stream.publish({ kind: "agent_changed", agent: "qa", ts: 1 })
  stream.publish({ kind: "agent_changed", agent: "qa", ts: 2 })
  const seen: number[] = []
  const subscription = stream.subscribe(1, event => seen.push(event.sequence))
  expect(seen).toEqual([2])
  subscription.unsubscribe()
})

test("an expired cursor emits snapshot_required", () => {
  const stream = new AgentEventStream(1)
  stream.publish({ kind: "agent_changed", agent: "a", ts: 1 })
  stream.publish({ kind: "agent_changed", agent: "b", ts: 2 })
  const kinds: string[] = []
  stream.subscribe(0, event => kinds.push(event.kind)).unsubscribe()
  expect(kinds[0]).toBe("snapshot_required")
})
```

- [ ] **Step 3: Run tests and verify missing exports**

Run: `bun test hub/operations/agentViews.test.ts hub/operations/agentEvents.test.ts`

Expected: FAIL because the new modules do not exist.

- [ ] **Step 4: Implement stable view models**

Define these public shapes in `agentViews.ts`:

```ts
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
```

Compute `version` with `createHash("sha256").update(JSON.stringify(config)).digest("hex")`. Match status and overseer rows by agent name. An absent persistent runtime is `offline`; ephemeral agents have `idle` status and reset/restart permissions `false`. Replace viewer `runtime.cwd` with `[redacted]` and set every mutation permission from `role === "operator"`.

For operators, represent an existing `claudeArgs` or `appendSystemPrompt` value as `{ redacted: true, configured: true }`. On preview, that sentinel means “preserve the current value”; a replacement string/string-array means “set a new value”; omission means “remove it”. This gives Advanced JSON complete write access without returning the existing sensitive value.

- [ ] **Step 5: Implement the ordered ring stream**

```ts
export type AgentEventInput =
  | { kind: "agent_changed"; agent: string; ts: number }
  | { kind: "agents_snapshot"; ts: number }
  | { kind: "config_applied"; agent: string; ts: number }
  | { kind: "action_completed"; agent: string; action: "reset" | "restart"; ts: number }

export type AgentOperationsEvent = (AgentEventInput | { kind: "snapshot_required"; ts: number }) & { sequence: number }
```

`AgentEventStream.publish` increments a process-local sequence and retains the last 100 events by default. `subscribe(after, callback)` synchronously replays retained events greater than `after`, emits one `snapshot_required` when `after` predates the retained floor, then registers the callback. Return `{ unsubscribe(): void }`.

- [ ] **Step 6: Run focused tests and commit**

Run: `bun test hub/operations/agentViews.test.ts hub/operations/agentEvents.test.ts && bun run typecheck`

Expected: all selected tests pass.

```bash
git add hub/operations/agentViews.ts hub/operations/agentViews.test.ts hub/operations/agentEvents.ts hub/operations/agentEvents.test.ts
git commit -m "feat(agents): add stable views and live events"
```

---

### Task 3: User-Bound Previews and Idempotent Actions

**Files:**
- Modify: `hub/agentConfigPreview.ts`
- Modify: `hub/agentConfigPreview.test.ts`
- Create: `hub/operations/operationPreview.ts`
- Create: `hub/operations/operationPreview.test.ts`

**Interfaces:**
- Consumes: `agentConfigVersion` from Task 2.
- Produces: actor/version-bound `AgentConfigPreviewRegistry`, `AgentActionPreviewRegistry`, and `IdempotencyRegistry<Result>`.

- [ ] **Step 1: Extend failing config-preview tests**

```ts
test("consume is bound to actor, agent, and resource version", () => {
  const h = harness()
  const preview = h.r.create("ada@example.com", "qa", "v1", cfg, cfg, classification)
  expect(h.r.consume(preview.id, "mallory@example.com", "qa", "v1")).toBeNull()
  expect(h.r.consume(preview.id, "ada@example.com", "qa", "v2")).toBeNull()
})
```

Change mismatched consumption to delete the token, so probing a token cannot leave it usable.

- [ ] **Step 2: Add failing action-preview and idempotency tests**

```ts
test("action previews bind the confirmed runtime snapshot", () => {
  const registry = new AgentActionPreviewRegistry(() => 10, () => "p1", 1000)
  const preview = registry.create("ada", "qa", "reset", "status-v1", { busy: true, queueDepth: 2 })
  expect(registry.consume("p1", "ada", "qa", "status-v1")?.action).toBe("reset")
  expect(registry.consume("p1", "ada", "qa", "status-v1")).toBeNull()
})

test("idempotency returns the original completed result", async () => {
  const registry = new IdempotencyRegistry<{ state: string }>(() => 0, 1000)
  let calls = 0
  const first = await registry.run("ada", "reset-1", async () => { calls++; return { state: "applied" } })
  const second = await registry.run("ada", "reset-1", async () => { calls++; return { state: "different" } })
  expect(second).toEqual(first)
  expect(calls).toBe(1)
})
```

- [ ] **Step 3: Run tests and verify they fail against the old signatures**

Run: `bun test hub/agentConfigPreview.test.ts hub/operations/operationPreview.test.ts`

Expected: FAIL on the new constructor/method contracts.

- [ ] **Step 4: Bind configuration previews**

Extend `AgentConfigPreview` with `actor` and `beforeVersion`. Use these exact signatures:

```ts
create(actor: string, agentName: string, beforeVersion: string, before: AgentConfig | null,
  after: AgentConfig | null, classification: AgentChangeClassification): AgentConfigPreview

consume(id: string, actor: string, agentName: string, liveVersion: string): AgentConfigPreview | null
```

`consume` removes the entry before checking expiry or bindings and returns `null` on every mismatch.

- [ ] **Step 5: Implement action previews and idempotency**

```ts
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
```

`IdempotencyRegistry.run(actor, key, operation)` keys entries by `${actor}\0${key}`, stores the in-flight promise immediately, retains successful results until TTL, and deletes failed promises so an operator can retry a failed action.

- [ ] **Step 6: Run tests and commit**

Run: `bun test hub/agentConfigPreview.test.ts hub/operations/operationPreview.test.ts && bun run typecheck`

Expected: all selected tests pass.

```bash
git add hub/agentConfigPreview.ts hub/agentConfigPreview.test.ts hub/operations/operationPreview.ts hub/operations/operationPreview.test.ts
git commit -m "feat(agents): bind previews and action idempotency"
```

---

### Task 4: Agent Operations Application Service

**Files:**
- Create: `hub/operations/agentService.ts`
- Create: `hub/operations/agentService.test.ts`
- Create: `hub/operations/index.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `classifyAgentChange`, `AgentConfig`, `AgentStatus`, and injected runtime/file/audit callbacks.
- Produces: `AgentOperationsService`, `AgentOperationsError`, `AgentConfigCommitResult`, and `AgentActionResult`.

- [ ] **Step 1: Write failing service authorization and projection tests**

```ts
test("hidden users cannot enumerate agents and viewers cannot mutate", async () => {
  const service = harness({ viewers: ["viewer"], operators: ["operator"] }).service
  expect(() => service.list("hidden")).toThrow(AgentOperationsError)
  expect(service.list("viewer")[0]?.permissions.configure).toBe(false)
  await expect(service.previewConfig("viewer", "qa", config)).rejects.toMatchObject({ status: 403 })
})

test("disabled feature is hidden even from operators", () => {
  const service = harness({ features: { agents: false }, operators: ["operator"] }).service
  expect(() => service.list("operator")).toThrow(AgentOperationsError)
})
```

- [ ] **Step 2: Write failing preview, drift, and action tests**

```ts
test("config confirm rejects disk drift without writing", async () => {
  const h = harness({ features: { agents: true }, operators: ["operator"] })
  const preview = await h.service.previewConfig("operator", "qa", { ...config, description: "changed" })
  h.disk.qa = { ...config, description: "outside edit" }
  await expect(h.service.confirmConfig("operator", "qa", preview.id, false)).rejects.toMatchObject({ status: 409, code: "stale_preview" })
  expect(h.commits).toHaveLength(0)
})

test("repeated action confirmation returns one runtime result", async () => {
  const h = harness({ features: { agents: true }, operators: ["operator"] })
  const preview = h.service.previewAction("operator", "qa", "reset")
  const first = await h.service.confirmAction("operator", "qa", preview.id, "key-1")
  const second = await h.service.confirmAction("operator", "qa", preview.id, "key-1")
  expect(second).toEqual(first)
  expect(h.actions).toEqual([{ agent: "qa", action: "reset", actor: "operator" }])
})
```

- [ ] **Step 3: Run the service test and verify the missing module failure**

Run: `bun test hub/operations/agentService.test.ts`

Expected: FAIL because `agentService.ts` does not exist.

- [ ] **Step 4: Implement the service contract**

```ts
export interface AgentOperationsDeps {
  workspace: WorkspaceConfig | undefined
  hub: HubConfig
  readAgents(): AgentRegistry
  statuses(): { agents: AgentStatus[]; overseers: OverseerStatus[] }
  commitConfig(input: { actor: string; agent: string; before: AgentConfig | null; after: AgentConfig | null; classification: AgentChangeClassification; hard: boolean }): Promise<AgentConfigCommitResult>
  runAction(input: { actor: string; agent: string; action: AgentRuntimeAction }): Promise<AgentActionResult>
  audit(input: { actor: string; action: string; target: string; outcome: "ok" | "deny" | "error"; detail?: Record<string, unknown> }): void
  now(): number
  events: AgentEventStream
  configPreviews: AgentConfigPreviewRegistry
  actionPreviews: AgentActionPreviewRegistry
  idempotency: IdempotencyRegistry<AgentActionResult>
}
```

Implement `list`, `get`, `listLegacyConfigs`, `previewLegacyConfig`, `confirmLegacyConfig`, `previewConfig`, `confirmConfig`, `previewAction`, and `confirmAction`. `list/get` and the workspace mutations require feature enabled and visible role. Legacy methods ignore the feature flag but still enforce view/manage roles, preserving `/legacy` when the new destination is disabled. Every mutation audits deny/error/ok outcomes. Never put `runtime.claudeArgs`, `appendSystemPrompt`, environment values, or raw thrown errors in audit details.

Before classification, merge opaque configured sentinels from the submitted editable config with the matching live value. Reject a sentinel when no live value exists. Use `agentConfigVersion(liveBefore)` at preview and confirmation. For action confirmation, check the idempotency registry before consuming the preview, compute a status version from `{alive,busy,queueDepth,lastActivityMs}`, and reject a changed busy/queue snapshot with `409 action_state_changed` before consuming runtime work.

- [ ] **Step 5: Export the operations boundary**

Create `hub/operations/index.ts`:

```ts
export * from "./access"
export * from "./agentEvents"
export * from "./agentService"
export * from "./agentViews"
export * from "./operationPreview"
```

- [ ] **Step 6: Run tests and commit**

Run: `bun test hub/operations/agentService.test.ts hub/operations/*.test.ts && bun run typecheck`

Expected: all operations tests pass.

```bash
git add hub/operations
git commit -m "feat(agents): add operations application service"
```

---

### Task 5: Hub Runtime Wiring, HTTP Routes, and SSE

**Files:**
- Modify: `hub/webServer.ts`
- Modify: `hub/index.ts`
- Modify: `tests/webServer.test.ts`
- Modify: `tests/conversationWeb.test.ts`
- Modify: `tests/fixtures/workspaceE2eServer.ts`

**Interfaces:**
- Consumes: `AgentOperationsService` from Task 4 and existing `buildAgentRows`, `readAgentsJson`, `writeAgentsJson`, `applySafeAgentFields`, `respawnAgent`, `resetAgentSession`, and `audit` wiring.
- Produces HTTP routes under `/api/operations/agents` and preserves `/api/agents`, `/preview`, and `/confirm`.

- [ ] **Step 1: Add failing route tests**

Cover these exact routes and statuses:

```ts
GET  /api/operations/agents
GET  /api/operations/agents/qa
GET  /api/operations/agents/events?after=4
POST /api/operations/agents/qa/config/preview
POST /api/operations/agents/qa/config/confirm
POST /api/operations/agents/qa/actions/preview
POST /api/operations/agents/qa/actions/confirm
```

Assertions:

```ts
expect((await list.json())[0].name).toBe("qa")
expect(await forbidden.json()).toEqual({ error: "forbidden" })
expect(forbidden.status).toBe(403)
expect(hidden.status).toBe(404)
expect(confirmRequest.headers.get("idempotency-key")).toBeTruthy()
expect(events.headers.get("content-type")).toContain("text/event-stream")
```

Also assert wrong methods return `405`, malformed encoded names return `400`, and missing identity is rejected before route disclosure.

- [ ] **Step 2: Run route tests and verify the new paths return 404**

Run: `bun test tests/webServer.test.ts tests/conversationWeb.test.ts`

Expected: FAIL because `/api/operations/agents` is not recognized.

- [ ] **Step 3: Replace agent-specific WebDeps callbacks with the service**

In `WebDeps`, add:

```ts
agentOperations: Pick<AgentOperationsService,
  "list" | "get" | "listLegacyConfigs" | "previewLegacyConfig" | "confirmLegacyConfig" |
  "previewConfig" | "confirmConfig" | "previewAction" | "confirmAction" | "subscribe">
```

Delete `listAgents`, `previewAgentChange`, and `confirmAgentChange` after all fixtures use `agentOperations`. Keep legacy URLs, but delegate them to `listLegacyConfigs`, `previewLegacyConfig`, and `confirmLegacyConfig`.

- [ ] **Step 4: Add the new HTTP and SSE adapters**

Parse agent names with `decodeURIComponent`. Require `idempotency-key` for action confirmation. Map `AgentOperationsError.status/code` directly to JSON. Emit SSE frames as:

```ts
controller.enqueue(encoder.encode(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`))
```

Use `Last-Event-ID` when `after` is absent. SSE cancellation must unsubscribe.

- [ ] **Step 5: Make runtime actions transport-independent**

Refactor the reset helper to:

```ts
async function resetAgentSession(name: string, reason: "manual" | "compact", context?: { actor?: string; channelId?: string }): Promise<void>
```

Audit `context.actor ?? "hub"`. Send the Discord confirmation only when `context.channelId` is present. Keep governor and Discord command behavior unchanged by passing their existing channel ID. Use `respawnAgent` for the web `restart` action and the refactored reset for `reset`.

- [ ] **Step 6: Instantiate and inject AgentOperationsService**

Create one `AgentEventStream`, preview registries, idempotency registry, and service in `hub/index.ts`. The service's config commit callback must reuse the existing atomic disk write, safe-field apply, home expansion, hard respawn, and full-restart reporting logic.

After every `statusRegistry.setAgents(buildAgentRows())`, compare the public status fingerprint with the previous fingerprint and publish one `agents_snapshot` event only when it changes. Publish `config_applied` and `action_completed` from successful service callbacks.

When `workspace.features.agents` is enabled, start a transport-independent status heartbeat using `hub.statusRefreshMs ?? 15_000`. It must call the same status refresh/publish helper even when `statusChannelId`, `metricsPort`, and Discord are all absent. Keep the existing Discord board throttle separate.

Extend `GET /api/session` to return:

```ts
features: { agents: agentsFeatureEnabled(hub.workspace) },
permissions: { agents: resolveWorkspaceRole(email, hub.workspace) },
```

- [ ] **Step 7: Run backend verification and commit**

Run: `bun test tests/webServer.test.ts tests/conversationWeb.test.ts hub/operations/*.test.ts hub/agentConfigPreview.test.ts && bun run typecheck`

Expected: all selected tests pass and existing legacy agent route assertions remain green.

```bash
git add hub/webServer.ts hub/index.ts tests/webServer.test.ts tests/conversationWeb.test.ts tests/fixtures/workspaceE2eServer.ts
git commit -m "feat(agents): expose shared operations APIs"
```

---

### Task 6: Typed Client API, Routes, and Reconnecting Agent Stream

**Files:**
- Modify: `web/client/types.ts`
- Modify: `web/client/api.ts`
- Modify: `web/client/api.test.ts`
- Create: `web/client/routes.ts`
- Create: `web/client/routes.test.ts`
- Create: `web/client/agentStream.ts`
- Create: `web/client/agentStream.test.ts`

**Interfaces:**
- Consumes: Task 5 JSON/SSE contracts.
- Produces: client `AgentSummary`, `AgentDetail`, `AgentConfigPreview`, `AgentActionPreview`, API methods, `WorkspaceRoute`, and `AgentStream`.

- [ ] **Step 1: Write failing route parser tests**

```ts
expect(parseWorkspaceRoute("/")).toEqual({ destination: "conversations", conversationId: null })
expect(parseWorkspaceRoute("/agents")).toEqual({ destination: "agents", agent: null })
expect(parseWorkspaceRoute("/agents/design%2Freview")).toEqual({ destination: "agents", agent: "design/review" })
expect(parseWorkspaceRoute("/agents/%E0%A4%A")).toEqual({ destination: "not_found" })
```

- [ ] **Step 2: Write failing API request-shape tests**

```ts
await api.listAgents()
await api.getAgent("qa/a")
await api.previewAgentConfig("qa/a", config)
await api.confirmAgentConfig("qa/a", "preview-1", true)
await api.previewAgentAction("qa/a", "reset")
await api.confirmAgentAction("qa/a", "action-1", "retry-key")

expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
  "GET /api/operations/agents",
  "GET /api/operations/agents/qa%2Fa",
  "POST /api/operations/agents/qa%2Fa/config/preview",
  "POST /api/operations/agents/qa%2Fa/config/confirm",
  "POST /api/operations/agents/qa%2Fa/actions/preview",
  "POST /api/operations/agents/qa%2Fa/actions/confirm",
])
expect(calls[5].headers.get("idempotency-key")).toBe("retry-key")
```

- [ ] **Step 3: Write failing reconnect/gap tests**

Model tests on `conversationStream.test.ts`. Assert that `AgentStream`:

- opens `/api/operations/agents/events?after=<lastSequence>`;
- advances only on increasing sequence IDs;
- calls `onInvalidate()` on `snapshot_required`;
- reports `connecting`, `live`, `reconnecting`, and `offline`;
- ignores events after `stop()`.

- [ ] **Step 4: Run focused tests and verify missing types/modules**

Run: `bun test web/client/routes.test.ts web/client/api.test.ts web/client/agentStream.test.ts`

Expected: FAIL on missing routes and API methods.

- [ ] **Step 5: Implement exact client contracts**

Extend `Session`:

```ts
features: { agents: boolean }
permissions: { agents: "hidden" | "viewer" | "operator" }
```

Mirror the stable server Agent view types without importing server files into the browser bundle. Add `WorkspaceApi` methods matching Step 2. Implement `parseWorkspaceRoute`, `pathForConversation`, and `pathForAgent` in `routes.ts`.

Implement `AgentStream` using the same injectable `open`, `online`, and reconnect-timer pattern as `ConversationStream`, with a single monotonic cursor.

- [ ] **Step 6: Run tests and commit**

Run: `bun test web/client/routes.test.ts web/client/api.test.ts web/client/agentStream.test.ts && bun run typecheck`

Expected: all focused client tests pass.

```bash
git add web/client/types.ts web/client/api.ts web/client/api.test.ts web/client/routes.ts web/client/routes.test.ts web/client/agentStream.ts web/client/agentStream.test.ts
git commit -m "feat(web): add typed agents client contracts"
```

---

### Task 7: Read-Only Responsive Agents Destination

**Files:**
- Create: `web/client/components/AgentsWorkspace.tsx`
- Create: `web/client/components/AgentsWorkspace.test.tsx`
- Create: `web/client/components/AgentList.tsx`
- Create: `web/client/components/AgentDetail.tsx`
- Create: `web/client/components/DestinationMobileNav.tsx`
- Modify: `web/client/components/AppRail.tsx`
- Modify: `web/client/App.tsx`
- Modify: `web/client/App.test.tsx`
- Modify: `web/client/styles.css`

**Interfaces:**
- Consumes: Task 6 API, route, stream, Session feature, and permission contracts.
- Produces: `/agents` and `/agents/:name` workspace routes with desktop master-detail, tablet drawer, and mobile list/detail behavior.

- [ ] **Step 1: Write failing AppRail and routing tests**

```tsx
render(<App api={apiWithAgents} streamFactory={null} agentStreamFactory={null} />)
expect(await screen.findByRole("link", { name: "Agents" })).toBeVisible()
await user.click(screen.getByRole("link", { name: "Agents" }))
expect(location.pathname).toBe("/agents")
expect(await screen.findByRole("heading", { name: "Agents" })).toBeVisible()
```

Also assert the link is absent when `session.features.agents` is false, direct disabled access renders a not-found state, and browser `popstate` switches destinations.

- [ ] **Step 2: Write failing responsive AgentsWorkspace tests**

Test list search, status labels without color dependence, detail selection, viewer read-only behavior, loading/empty/403/404/offline states, mobile back navigation, and focus restoration to the selected list row.

```tsx
expect(screen.getByRole("list", { name: "Agents" })).toBeVisible()
await user.click(screen.getByRole("button", { name: /Open qa/ }))
expect(screen.getByRole("heading", { name: "qa" })).toBeVisible()
expect(screen.getByText("Busy")).toBeVisible()
expect(screen.queryByRole("button", { name: "Restart agent" })).not.toBeInTheDocument()
```

- [ ] **Step 3: Run component tests and verify missing components**

Run: `bun test web/client/components/AgentsWorkspace.test.tsx web/client/App.test.tsx`

Expected: FAIL because the Agents destination is not implemented.

- [ ] **Step 4: Extract the destination router without changing conversation behavior**

Rename the current `App` body to `ConversationWorkspace` without altering its state logic. Add a small `App` wrapper that loads session once, tracks `parseWorkspaceRoute(location.pathname)` on `popstate`, and renders `AgentsWorkspace` for Agents routes or `ConversationWorkspace` otherwise. Preserve dependency injection used by existing tests.

Change `AppRail` to accept:

```ts
active: "conversations" | "agents"
features: { agents: boolean }
onNavigate(destination: "conversations" | "agents"): void
```

Keep the `/legacy` link and install/connectivity footer unchanged.

- [ ] **Step 5: Implement read-only Agents composition**

`AgentsWorkspace` loads list data, selects from the route, subscribes through `AgentStream`, and reloads on invalidation. `AgentList` provides a labeled search field and buttons whose accessible names are `Open <agent>`. `AgentDetail` initially renders Overview and Sessions information plus disabled/absent controls based on permissions.

Use these panel regions:

```tsx
<main className="agents-shell" data-mobile-pane={selected ? "detail" : "list"}>
  <AppRail active="agents" connection={connection} features={session.features}
    onNew={onNewConversation} onNavigate={onNavigate} />
  <AgentList agents={agents} selected={selected?.name ?? null} query={query}
    onQueryChange={setQuery} onSelect={selectAgent} />
  <AgentDetail agent={selected} connection={connection} onBack={showList} />
  <DestinationMobileNav active="agents" features={session.features}
    onNavigate={onNavigate} />
</main>
```

- [ ] **Step 6: Add responsive styles**

Reuse existing tokens. Desktop uses rail + 320px list + flexible detail. Tablet uses rail + list + detail drawer. Below 768px, show either list or detail with safe-area padding and a fixed destination nav. Add `:focus-visible`, `prefers-reduced-motion`, long-name wrapping, and a no-horizontal-overflow rule.

- [ ] **Step 7: Run component verification and commit**

Run: `bun test web/client/components/AgentsWorkspace.test.tsx web/client/App.test.tsx web/client/api.test.ts && bun run typecheck && bun run build:web`

Expected: tests, typecheck, and production build pass.

```bash
git add web/client/components/AgentsWorkspace.tsx web/client/components/AgentsWorkspace.test.tsx web/client/components/AgentList.tsx web/client/components/AgentDetail.tsx web/client/components/DestinationMobileNav.tsx web/client/components/AppRail.tsx web/client/App.tsx web/client/App.test.tsx web/client/styles.css
git commit -m "feat(web): add responsive agents destination"
```

---

### Task 8: Guided Configuration and Protected Runtime Actions

**Files:**
- Create: `web/client/components/AgentConfigEditor.tsx`
- Create: `web/client/components/AgentConfigEditor.test.tsx`
- Create: `web/client/components/AgentActionDialog.tsx`
- Create: `web/client/components/AgentActionDialog.test.tsx`
- Modify: `web/client/components/AgentDetail.tsx`
- Modify: `web/client/components/AgentsWorkspace.tsx`
- Modify: `web/client/styles.css`

**Interfaces:**
- Consumes: Task 6 preview/confirm APIs and Task 7 detail composition.
- Produces: shared guided/Advanced JSON draft, normalized diff confirmation, reset/restart confirmations, and removal-through-config confirmation.

- [ ] **Step 1: Write failing shared-draft tests**

```tsx
await user.clear(screen.getByLabelText("Description"))
await user.type(screen.getByLabelText("Description"), "Release specialist")
await user.click(screen.getByRole("button", { name: "Advanced JSON" }))
expect(screen.getByLabelText("Agent configuration JSON")).toHaveValue(expect.stringContaining("Release specialist"))
```

Also assert valid JSON updates guided fields, invalid JSON disables Preview with an inline error, and switching modes does not discard the draft. Existing `claudeArgs`/`appendSystemPrompt` values must render as the opaque configured sentinel; leaving the sentinel unchanged preserves the server value, while replacing it updates the field without ever revealing the prior value.

- [ ] **Step 2: Write failing preview/confirm tests**

Cover `safe`, `hard`, and `restart` classifications. Assert:

```tsx
expect(await screen.findByText("Agent restart required")).toBeVisible()
expect(screen.getByRole("button", { name: "Apply and restart agent" })).toBeEnabled()
expect(screen.getByText(/Full hub restart required/)).toBeVisible()
expect(screen.getByRole("button", { name: "Save pending hub restart" })).toBeEnabled()
```

Test stale preview `409` preserves the draft and offers Reload current configuration.

- [ ] **Step 3: Write failing action-dialog tests**

Assert reset/restart first fetch a preview, display busy/queue impact, restore focus on cancel, submit one idempotency key across retry, and never show mutation buttons to viewers. Removal must call `previewAgentConfig(name, null)` and label confirmation `Save removal pending hub restart`.

- [ ] **Step 4: Run tests and verify missing components**

Run: `bun test web/client/components/AgentConfigEditor.test.tsx web/client/components/AgentActionDialog.test.tsx`

Expected: FAIL because the editor and dialogs do not exist.

- [ ] **Step 5: Implement one shared configuration draft**

Guided fields are emoji, description, mode, access roles, runtime model, cwd, resumable, memory, context injection, queue depth, and pooling limits. Serialize the shared draft with `JSON.stringify(draft, null, 2)` for Advanced JSON. Parse JSON on change and replace the same draft only after shape validation. Treat `{ "redacted": true, "configured": true }` as preserve-only: users may keep it or replace it with the documented string/string-array type, but may not construct other redaction objects.

Render the server-provided before/after values and `classification.fullRestart` labels. Button copy is derived solely from the returned tier:

```ts
const confirmCopy = {
  safe: "Apply changes",
  hard: "Apply and restart agent",
  restart: "Save pending hub restart",
} as const
```

- [ ] **Step 6: Implement protected action dialogs**

Use the existing `useModalDialog` focus-trap behavior, extracted to `web/client/components/useModalDialog.ts` so conversation and Agents dialogs share it. Generate one idempotency key when the dialog opens and retain it until success or cancellation. Disable dismissal while confirmation is in flight.

Reset copy must say it clears resumable context; restart copy must say it keeps the session file; removal copy must say the running agent remains until the hub restarts.

- [ ] **Step 7: Integrate tabs and error states**

Add Overview, Sessions, Configuration, and Activity tabs to `AgentDetail`. Activity displays only the status/config/action events available in this slice; tool/audit history remains visibly labeled as coming in the Operations vertical and must not render a dead control.

On action/config success, reload the selected agent and announce the result through an `aria-live="polite"` region. On offline state, preserve the configuration draft locally in component state but disable Preview and all runtime confirmations.

- [ ] **Step 8: Run frontend verification and commit**

Run: `bun test web/client/components/AgentConfigEditor.test.tsx web/client/components/AgentActionDialog.test.tsx web/client/components/AgentsWorkspace.test.tsx web/client/App.test.tsx && bun run typecheck && bun run build:web`

Expected: all tests pass and the bundle builds.

```bash
git add web/client/components/AgentConfigEditor.tsx web/client/components/AgentConfigEditor.test.tsx web/client/components/AgentActionDialog.tsx web/client/components/AgentActionDialog.test.tsx web/client/components/AgentDetail.tsx web/client/components/AgentsWorkspace.tsx web/client/components/useModalDialog.ts web/client/App.tsx web/client/styles.css
git commit -m "feat(agents): add safe config and runtime controls"
```

---

### Task 9: End-to-End Rollout, Documentation, and Full Verification

**Files:**
- Modify: `tests/fixtures/workspaceE2eServer.ts`
- Create: `tests/e2e/agents.spec.ts`
- Modify: `docs/web-dashboard.md`
- Modify: `docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the complete Agents vertical.
- Produces: deterministic browser coverage, operator documentation, parity checklist evidence, and rollout instructions.

- [ ] **Step 1: Extend the E2E fixture with deterministic Agents operations**

Use an in-memory agent registry containing `architect` and `qa`, an `AgentEventStream`, and the real `AgentOperationsService`. Inject deterministic preview IDs, time, audit rows, and action results. The fixture must mutate config/action counters without spawning processes or calling Discord.

Add test-only endpoints only under `NODE_ENV === "test"` to change status and drop the Agents SSE connection:

```ts
POST /__e2e/agents/status
POST /__e2e/agents/drop-stream
```

- [ ] **Step 2: Write the desktop/tablet/mobile E2E flow**

For every Playwright project:

1. Open `/agents` and verify the Agents rail/mobile destination.
2. Search for and open `qa`.
3. Verify status text and no horizontal overflow.
4. Edit description in guided mode, confirm it appears in Advanced JSON, preview, and apply.
5. Preview and confirm restart; assert one fixture action.
6. Drop SSE, change status, and verify reconnect snapshot recovery.
7. Navigate to `/legacy` and verify the legacy dashboard still renders.
8. Run Axe and assert no serious or critical violations.

Use role/name locators, not CSS implementation selectors, except the established overflow measurement helper.

- [ ] **Step 3: Run E2E in deterministic single-worker mode**

Run: `bun run build:web && bunx playwright test tests/e2e/agents.spec.ts --workers=1`

Expected: desktop, tablet, and mobile Agents tests pass.

- [ ] **Step 4: Document configuration and rollout**

Document:

- `workspace.features.agents` and its default-off behavior;
- compatibility behavior when access lists are absent;
- explicit viewers/operators and `"*"`;
- trusted-header deployment boundary;
- guided versus Advanced JSON editing;
- reset/restart/removal semantics;
- restart classifications and no automatic hub restart;
- `/legacy` rollback path;
- Discord independence and future adapter reuse.

Mark only the Agents item complete in the Phase 4 roadmap. Keep Approvals, Operations, Settings, Phase 4B, soak, and legacy redirect pending.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```bash
bun test
bun run typecheck
bun run build:web
bunx playwright test --workers=1
```

Expected: all unit/integration tests pass, TypeScript exits successfully, the production web bundle builds, and all Playwright tests pass with only documented intentional skips.

- [ ] **Step 6: Check scope and working tree**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only Agents-plan files and pre-existing user-owned untracked paths are present.

- [ ] **Step 7: Commit the verified Agents vertical**

```bash
git add tests/fixtures/workspaceE2eServer.ts tests/e2e/agents.spec.ts docs/web-dashboard.md docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md README.md
git commit -m "test(agents): verify workspace rollout"
```

## Final Acceptance Checklist

- [ ] `/agents` works with Discord disabled.
- [ ] Hidden/viewer/operator behavior is enforced server-side.
- [ ] Runtime/config data is redacted before serialization.
- [ ] List/detail state updates through ordered SSE with gap recovery.
- [ ] Guided and Advanced JSON editors share one draft.
- [ ] Config preview tokens are actor/resource/version-bound and single-use.
- [ ] Reset/restart actions are confirmed and idempotent.
- [ ] Removal is explicit and saved pending a full hub restart.
- [ ] Discord commands and `/legacy` use the shared application behavior and remain functional.
- [ ] Desktop, tablet, mobile, keyboard, focus, reduced-motion, Axe, and PWA-shell regressions pass.
- [ ] The roadmap leaves the remaining Phase 4 verticals and soak gate pending.
