# Phase 4A Approvals Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicated in-memory approval paths with one durable, transport-neutral approval lifecycle and add a responsive, installable-PWA Approvals workspace while preserving Discord cards and `/legacy` compatibility.

**Architecture:** `ApprovalOperationsService` is the only lifecycle boundary. It coordinates a SQLite `ApprovalHistoryRepository`, a memory-only held-effect registry, kind-specific redaction policies, ordered events, audit, and notification ports. `hub/index.ts` derives trusted provenance and injects outbound/Discord dependencies; `hub/webServer.ts` is only an authenticated HTTP/SSE adapter. The React application owns one approval stream across all destinations and renders a master-detail queue plus non-canonical conversation banners.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, React 19, Bun test, Testing Library, Server-Sent Events, Playwright, the existing PWA shell, and Discord.js through the existing gateway adapter.

## Global Constraints

- Implement only the approved Phase 4A **Approvals** vertical. Do not add new approval producers, Slack/Teams adapters, Operations, Settings, or Phase 4B rich-conversation features.
- `approvals.enabled` controls core request production and shared lifecycle behavior. `workspace.features.approvals` independently controls the React destination, workspace operations APIs/SSE, rail badge, and conversation banners.
- Discord cards and authenticated `/legacy` approval controls remain functional when `workspace.features.approvals` is absent or `false`.
- Discord is optional. Migration, repository, request, view, decision, expiry, history, API, and React flows must work with `discord.enabled: false` and without constructing a Discord client.
- A held executable effect, exact body, URL, headers, resolved secret, or raw error must never enter SQLite, browser JSON, SSE, notification metadata, or audit detail.
- Persist only explicit allowlisted fields. Unknown approval kinds fail closed; unknown persisted JSON keys are ignored and invalid values fail safely.
- A request is invisible until both its SQLite row and memory-only closure are active. The internal `registering` state is never returned by any read, count, banner, search, or event path.
- SQLite owns all decision-versus-expiry races. A decision CAS requires `state = 'pending'`, an exact resource version, and `expires_at > now`; expiry requires `state = 'pending'` and `expires_at <= now`.
- Decision idempotency is scoped by `(principal surface, principal ID, key)` and bound to approval ID, decision, and expected version. Identical concurrent requests share one promise and one execution.
- Startup reconciliation interrupts abandoned `registering`/`pending` rows and marks `granted + execution pending` as execution `interrupted`. No held effect is reconstructed or replayed after restart.
- `granted + execution interrupted` always means **execution outcome unknown**. Never describe it as safely discarded and never offer automatic retry.
- Workspace viewers and operators may inspect every globally sanitized approval shell. Conversation IDs/links appear only after separate conversation authorization.
- Web decisions require a workspace operator and, when non-empty, an exact `approvals.webApprovers` or `"*"` match. Discord decisions require a configured Discord approver. The service rechecks authorization for every attempt, including idempotent replays.
- Every workspace approval response uses `Cache-Control: no-store`; approval SSE uses `Cache-Control: no-cache` and disables proxy buffering where supported.
- The application owns exactly one approval SSE connection while the workspace feature is visible. Destination components never create their own approval streams.
- The context banner sits above the transcript and is a live operational projection, never a message or transcript event.
- No new runtime or frontend package dependency is introduced.
- Every named helper used in a test snippet (`harness`, `record`, `outboundDescriptor`, deferred/barrier helpers, render helpers, and navigation helpers) is a typed fixture to create in that same test file unless an existing source path is explicitly named; snippets never assume undeclared global helpers.
- Before Task 10 changes visual UI, invoke `frontend-design:frontend-design`. Before claiming the implementation complete, invoke `superpowers:requesting-code-review` and `superpowers:verification-before-completion`.
- Preserve the user-owned untracked `.superpowers/brainstorm/`, `docs/runbooks/`, and `graphify-out/` directories. Stage only files named by the active task.

## File Structure

- `hub/approvalTypes.ts` — canonical internal records, public views, principals, decisions, execution results, filters, and safe JSON types.
- `hub/approvalPolicy.ts` — kind registry, outbound allowlist sanitizer, risk classifier, and process-keyed fingerprints.
- `hub/heldApprovalRegistry.ts` — memory-only exact-effect fingerprints and closures.
- `hub/approvalMigrations.ts` — additive SQLite approval schema.
- `hub/approvalRepository.ts` — strict decode, keyset reads, CAS lifecycle transitions, idempotency, reconciliation, and notification references.
- `hub/approvalEvents.ts` — ordered immutable approval events and replay-gap signaling.
- `hub/approvalService.ts` — shared lifecycle, authorization, concurrency, audit, notification, projection, and execution orchestration.
- `hub/approvalDiscordNotifications.ts` — Discord `ApprovalNotificationPort` implementation.
- `hub/approval.ts` — versioned Discord custom IDs and card rendering only; the old registry is removed.
- `hub/outboundApproval.ts` — awaited outbound delivery-to-execution-result adapter.
- `hub/webServer.ts` — workspace/compatibility HTTP and SSE adapters.
- `hub/web.ts` — legacy HTML that loads approvals from authenticated compatibility routes.
- `web/client/approvalStream.ts` — reconnecting ordered approval SSE client.
- `web/client/components/ApprovalsWorkspace.tsx` — responsive destination state and master-detail composition.
- `web/client/components/ApprovalList.tsx` — pending/history queue, search, filters, and pagination.
- `web/client/components/ApprovalDetail.tsx` — sanitized effect, lifecycle, execution, and audit detail.
- `web/client/components/ApprovalDecisionDialog.tsx` — tiered confirmation and idempotent decision flow.
- `web/client/components/ApprovalContextBanner.tsx` — authorized pending projection above a conversation transcript.
- `web/client/App.tsx` — destination routing and the single application-owned approval stream.

---

### Task 1: Independent Feature Flags and Approval Authorization

**Files:**

- Modify: `hub/types.ts`
- Modify: `hub/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `hub/operations/access.ts`
- Modify: `hub/operations/access.test.ts`
- Modify: `config/hub.config.json`

**Interfaces:**

- Produces: `ApprovalConfig.webApprovers`, `approvalsFeatureEnabled`, `ApprovalWebAccess`, and `resolveApprovalWebAccess`.
- Consumes: existing `WorkspaceConfig`, `WorkspaceRole`, exact trusted-header identities, and `approvals.enabled`.

- [ ] **Step 1: Write failing flag and web-approver policy tests**

Add to `hub/operations/access.test.ts`:

```ts
import { approvalsFeatureEnabled, resolveApprovalWebAccess } from "./access"

test("workspace visibility and core production are independent", () => {
  expect(approvalsFeatureEnabled(undefined)).toBe(false)
  expect(approvalsFeatureEnabled({ features: { approvals: true } })).toBe(true)
  expect(resolveApprovalWebAccess("ops@example.com", { operators: ["ops@example.com"] }, { enabled: false }))
    .toEqual({ feature: false, coreEnabled: false, role: "operator", canDecide: false })
  expect(resolveApprovalWebAccess("ops@example.com", { features: { approvals: true }, operators: ["ops@example.com"] }, { enabled: false }))
    .toEqual({ feature: true, coreEnabled: false, role: "operator", canDecide: false })
})

test("a configured web approver list further restricts operators", () => {
  const workspace = { features: { approvals: true }, operators: ["ops@example.com", "approver@example.com"] }
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true, webApprovers: ["approver@example.com"] }).canDecide).toBe(false)
  expect(resolveApprovalWebAccess("approver@example.com", workspace, { enabled: true, webApprovers: ["approver@example.com"] }).canDecide).toBe(true)
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true, webApprovers: ["*"] }).canDecide).toBe(true)
})

test("an absent or empty web approver list preserves operator compatibility", () => {
  const workspace = { operators: ["ops@example.com"], viewers: ["viewer@example.com"] }
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true }).canDecide).toBe(true)
  expect(resolveApprovalWebAccess("ops@example.com", workspace, { enabled: true, webApprovers: [] }).canDecide).toBe(true)
  expect(resolveApprovalWebAccess("viewer@example.com", workspace, { enabled: true }).canDecide).toBe(false)
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-export failure**

Run: `bun test hub/operations/access.test.ts`

Expected: FAIL because the approval access exports do not exist.

- [ ] **Step 3: Add the typed configuration and pure access resolver**

Extend `ApprovalConfig` in `hub/types.ts`:

```ts
export interface ApprovalConfig {
  enabled?: boolean
  channelId?: string
  approvers?: string[]
  webApprovers?: string[]
  ttlMs?: number
}
```

Extend `hub/operations/access.ts` without changing existing Agents behavior:

```ts
import type { ApprovalConfig, WorkspaceConfig } from "../types"

export interface ApprovalWebAccess {
  feature: boolean
  coreEnabled: boolean
  role: WorkspaceRole
  canDecide: boolean
}

export const approvalsFeatureEnabled = (config: WorkspaceConfig | undefined): boolean =>
  config?.features?.approvals === true

export function resolveApprovalWebAccess(
  identity: string,
  workspace: WorkspaceConfig | undefined,
  approvals: ApprovalConfig | undefined,
): ApprovalWebAccess {
  const role = resolveWorkspaceRole(identity, workspace)
  const restricted = (approvals?.webApprovers?.length ?? 0) > 0
  const listed = approvals?.webApprovers?.some(entry => entry === "*" || entry === identity) === true
  return {
    feature: approvalsFeatureEnabled(workspace),
    coreEnabled: approvals?.enabled === true,
    role,
    canDecide: approvals?.enabled === true && role === "operator" && (!restricted || listed),
  }
}
```

Identity comparison stays exact. Do not trim, lowercase, or otherwise reinterpret the trusted value at authorization time. `canDecide` is the effective capability exposed to the service, session, and UI, so it is always false when core approvals are disabled even if the identity would otherwise satisfy operator and approver policy.

- [ ] **Step 4: Validate approver arrays and document the default-off workspace flag in sample config**

In `hub/config.ts`, reuse one array validator for `workspace.viewers`, `workspace.operators`, `approvals.approvers`, and `approvals.webApprovers`. Preserve the existing meaning of `workspace.viewers: []` and `workspace.operators: []` as explicit deny-all lists; every one of these arrays may be empty, but individual values must be non-empty strings:

```ts
function validateIdentityArray(path: string, value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`config: ${path} must be a string array`)
  }
}
```

Add config tests that reject scalar, empty-string, and non-string web approvers and accept `[]`, an exact identity, and `"*"`. Add a regression proving empty workspace viewer/operator arrays still load and resolve to hidden for every identity. In `config/hub.config.json`, add `"approvals": false` under `workspace.features` and add a `webApprovers` example to the existing core `approvals` block.

- [ ] **Step 5: Run focused verification**

Run: `bun test hub/operations/access.test.ts tests/config.test.ts && bun run typecheck`

Expected: all selected tests pass and TypeScript exits successfully.

- [ ] **Step 6: Commit the authorization boundary**

```bash
git add hub/types.ts hub/config.ts tests/config.test.ts hub/operations/access.ts hub/operations/access.test.ts config/hub.config.json
git commit -m "feat(approvals): add workspace approval access policy"
```

---

### Task 2: Canonical Types, Outbound Policy, and Memory-Only Held Effects

**Files:**

- Create: `hub/approvalTypes.ts`
- Create: `hub/approvalPolicy.ts`
- Create: `hub/approvalPolicy.test.ts`
- Create: `hub/heldApprovalRegistry.ts`
- Create: `hub/heldApprovalRegistry.test.ts`

**Interfaces:**

- Produces: canonical approval types, `ApprovalKindPolicy`, `ApprovalPolicyRegistry`, `createOutboundApprovalPolicy`, and `HeldApprovalRegistry`.
- Consumes: `OutboundRoute`, a process-local random HMAC key, structured request descriptors, and memory-only closures.

- [ ] **Step 1: Write failing outbound sanitization and fingerprint tests**

Create `hub/approvalPolicy.test.ts` with a route containing credentials, query text, secret headers, a `secretEnv`, and a short body:

```ts
import { expect, test } from "bun:test"
import { createOutboundApprovalPolicy } from "./approvalPolicy"

const route = {
  id: "deploy",
  url: "https://user:pass@hooks.example.com/private?token=raw#fragment",
  method: "post",
  headers: { Authorization: "Bearer raw-secret" },
  secretEnv: "OUTBOUND_SECRET",
  template: "raw-template",
}

test("outbound policy emits only the approved elevated projection", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 7))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "tiny secret body" }))
  expect(prepared.risk).toBe("elevated")
  expect(prepared.detail).toEqual({
    routeId: "deploy",
    method: "POST",
    destinationHostname: "hooks.example.com",
    payloadBytes: 16,
    payloadFingerprint: expect.any(String),
    routeVersionFingerprint: expect.any(String),
  })
  expect(prepared.effectFingerprint).toEqual(expect.any(String))
  expect(JSON.stringify(prepared)).not.toContain("user:pass")
  expect(JSON.stringify(prepared)).not.toContain("raw-secret")
  expect(JSON.stringify(prepared)).not.toContain("tiny secret body")
})

test("payload, route, and combined fingerprints are keyed and effect-specific", () => {
  const first = createOutboundApprovalPolicy(Buffer.alloc(32, 1))
  const second = createOutboundApprovalPolicy(Buffer.alloc(32, 2))
  const a = first.prepare(outboundDescriptor({ route, body: "a" }))
  const b = first.prepare(outboundDescriptor({ route, body: "b" }))
  const otherProcess = second.prepare(outboundDescriptor({ route, body: "a" }))
  expect(a.detail.payloadFingerprint).not.toBe(b.detail.payloadFingerprint)
  expect(a.effectFingerprint).not.toBe(b.effectFingerprint)
  expect(a.effectFingerprint).not.toBe(otherProcess.effectFingerprint)
})

test("execution results are bounded and drop arbitrary producer data", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 3))
  expect(policy.sanitizeExecution({ outcome: "failed", detail: {
    status: 503, attempts: 999_999, failureCode: "http_error", body: "secret", headers: { x: "secret" }, error: "raw",
  } })).toEqual({ outcome: "failed", detail: { status: 503, attempts: 100, failureCode: "http_error" } })
})

test("the persisted-detail projector drops unknown keys and never exposes the combined fingerprint", () => {
  const policy = createOutboundApprovalPolicy(Buffer.alloc(32, 4))
  const prepared = policy.prepare(outboundDescriptor({ route, body: "exact" }))
  expect(policy.projectDetail({
    ...prepared.detail,
    effectFingerprint: prepared.effectFingerprint,
    injected: "drop-me",
  })).toEqual(prepared.detail)
})
```

Use `new TextEncoder().encode(body).byteLength`; do not use JavaScript character count for UTF-8 payload size.

- [ ] **Step 2: Write failing held-registry tests**

Create `hub/heldApprovalRegistry.test.ts`:

```ts
import { expect, test } from "bun:test"
import { HeldApprovalRegistry } from "./heldApprovalRegistry"

test("activation is unique and consume is single-shot", () => {
  const held = new HeldApprovalRegistry()
  const fire = async () => ({ outcome: "succeeded" as const })
  held.activate("approval-1", "fingerprint-1", fire)
  expect(() => held.activate("approval-1", "fingerprint-2", fire)).toThrow("held_effect_exists")
  expect(held.consume("approval-1")).toMatchObject({ fingerprint: "fingerprint-1", fire })
  expect(held.consume("approval-1")).toBeNull()
})

test("discard never invokes the closure", () => {
  const held = new HeldApprovalRegistry()
  let calls = 0
  held.activate("approval-1", "fingerprint-1", async () => { calls++; return { outcome: "succeeded" } })
  expect(held.discard("approval-1")).toBe(true)
  expect(held.discard("approval-1")).toBe(false)
  expect(calls).toBe(0)
})
```

- [ ] **Step 3: Run tests and verify the new modules are missing**

Run: `bun test hub/approvalPolicy.test.ts hub/heldApprovalRegistry.test.ts`

Expected: FAIL because the new modules do not exist.

- [ ] **Step 4: Define the canonical internal and public contracts**

Create `hub/approvalTypes.ts` with explicit, transport-neutral shapes:

```ts
export type ApprovalDecision = "grant" | "deny"
export type ApprovalRisk = "low" | "elevated" | "destructive"
export type ApprovalLifecycleState = "pending" | "granted" | "denied" | "expired" | "interrupted"
export type ApprovalStorageState = "registering" | ApprovalLifecycleState
export type ApprovalExecutionOutcome = "not_applicable" | "pending" | "succeeded" | "failed" | "interrupted"
export type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue }

export interface ApprovalPrincipal { surface: string; id: string }
export interface ApprovalOrigin { conversationId?: string; surface?: string; externalLocation?: string }
export interface ApprovalRequestDescriptor {
  kind: string
  target: string
  requestedBy: ApprovalPrincipal
  origin?: ApprovalOrigin
  summary: string
  detail: unknown
}

export interface ApprovalExecutionResult {
  outcome: "succeeded" | "failed"
  detail?: unknown
}

export type ApprovalFire = (correlationId: string) => Promise<ApprovalExecutionResult>

export interface ApprovalRecord {
  id: string
  version: number
  kind: string
  target: string
  summary: string
  detail: SafeValue
  requestedBy: ApprovalPrincipal
  originConversationId: string | null
  risk: ApprovalRisk
  effectFingerprint: string
  createdAt: number
  expiresAt: number
  terminalAt: number | null
  state: ApprovalStorageState
  decisionBy: ApprovalPrincipal | null
  decisionAt: number | null
  decisionKey: string | null
  outcomeReason: string | null
  execution: ApprovalExecutionOutcome
  executionDetail: SafeValue | null
  executionStartedAt: number | null
  executionFinishedAt: number | null
  correlationId: string
}
```

Also define `ApprovalSummaryView`, `ApprovalDetailView`, `ApprovalNotificationView`, `ApprovalPendingAggregate`, `ApprovalListQuery`, `ApprovalListPage`, `ApprovalDecisionInput`, `ApprovalDecisionResult`, and `SafeApprovalAuditView` here. `ApprovalListQuery` has the exact optional filters `search`, `risk`, `kind`, `requester`, `state`, `conversationId`, `createdFrom`, `createdTo`, `decisionFrom`, and `decisionTo`, plus `group`, `cursor`, and `limit`. A pending page carries an exact query-scoped aggregate `{count, highestRisk, nearestExpiry, firstId}` computed independently of pagination; history uses `null`. Public versions are non-empty strings, public views exclude `effectFingerprint`, `decisionKey`, and notification references, and `conversationId` is optional rather than nullable so restricted origins cannot leak an identifier.

- [ ] **Step 5: Implement the kind-policy registry and exact outbound allowlist**

Define the registry contract in `hub/approvalPolicy.ts`:

```ts
export interface PreparedApproval<TDetail extends SafeValue = SafeValue> {
  target: string
  summary: string
  detail: TDetail
  risk: ApprovalRisk
  effectFingerprint: string
}

export interface ApprovalKindPolicy<TDetail extends SafeValue = SafeValue> {
  readonly kind: string
  prepare(descriptor: ApprovalRequestDescriptor): PreparedApproval<TDetail>
  projectDetail(storedDetail: SafeValue): TDetail
  sanitizeExecution(result: ApprovalExecutionResult): { outcome: "succeeded" | "failed"; detail: SafeValue | null }
}

export class ApprovalPolicyRegistry {
  private readonly policies = new Map<string, ApprovalKindPolicy>()
  register(policy: ApprovalKindPolicy): void {
    if (this.policies.has(policy.kind)) throw new Error(`approval_policy_exists:${policy.kind}`)
    this.policies.set(policy.kind, policy)
  }
  require(kind: string): ApprovalKindPolicy {
    const policy = this.policies.get(kind)
    if (!policy) throw new Error("approval_kind_unsupported")
    return policy
  }
}
```

The service validates and explicitly copies the trusted requesting principal and verified origin separately. Every kind policy owns the remaining request boundary: `prepare` accepts the complete descriptor, validates the descriptor kind and exact detail shape, and derives a non-empty target (at most 256 UTF-8 bytes), summary (at most 512 UTF-8 bytes), safe stored detail, risk, and internal exact-effect fingerprint rather than passing producer strings through. `projectDetail` is a second kind-specific allowlist applied on every read after SQLite decoding, so a reopened or tampered row cannot add browser fields. Invalid required persisted fields fail safely as `corrupt_record`; unknown keys are ignored.

`createOutboundApprovalPolicy` accepts only an `outbound` descriptor whose detail is exactly `{ route: OutboundRoute; body: string }`, clones no producer object, derives `target` and `summary` from the validated route ID, and returns stored detail with exactly:

```ts
type OutboundApprovalDetail = {
  routeId: string
  method: string
  destinationHostname: string
  payloadBytes: number
  payloadFingerprint: string
  routeVersionFingerprint: string
}
```

Return `ApprovalKindPolicy<OutboundApprovalDetail>` from `createOutboundApprovalPolicy`, while the heterogeneous registry stores the erased default `ApprovalKindPolicy`. This keeps policy tests and production code type-safe without casting arbitrary persisted JSON to the outbound shape.

The combined `effectFingerprint` exists only on `PreparedApproval`, `ApprovalRecord`, and the held registry entry; it is never nested in `detail` and is never returned by `projectDetail`. Compute all fingerprints with `createHmac("sha256", processKey)`. Canonicalize route-version/effect inputs from exactly `id`, `url`, `pattern ?? null`, uppercase `method ?? "POST"`, `secretEnv ?? null`, `template ?? null`, `consume ?? false`, `requireApproval ?? false`, and static headers as lexically sorted `[lowercaseName, exactValue]` pairs; reject duplicate header names after case folding. The effect fingerprint additionally binds the exact UTF-8 body. Allow only integer HTTP status `100..599`, attempts clamped to `0..100`, and failure codes `http_error`, `network_error`, `blocked`, or `effect_rejected`. Invalid/extra fields are dropped. The policy always returns `risk: "elevated"`.

- [ ] **Step 6: Implement the memory-only registry**

Create `hub/heldApprovalRegistry.ts`:

```ts
import type { ApprovalFire } from "./approvalTypes"

export interface HeldApproval { fingerprint: string; fire: ApprovalFire }

export class HeldApprovalRegistry {
  private readonly held = new Map<string, HeldApproval>()

  activate(id: string, fingerprint: string, fire: ApprovalFire): void {
    if (this.held.has(id)) throw new Error("held_effect_exists")
    this.held.set(id, Object.freeze({ fingerprint, fire }))
  }

  consume(id: string): HeldApproval | null {
    const value = this.held.get(id) ?? null
    if (value) this.held.delete(id)
    return value
  }

  discard(id: string): boolean { return this.held.delete(id) }
  has(id: string): boolean { return this.held.has(id) }
}
```

- [ ] **Step 7: Run focused verification**

Run: `bun test hub/approvalPolicy.test.ts hub/heldApprovalRegistry.test.ts && bun run typecheck`

Expected: all selected tests pass; grep assertions prove secrets, bodies, paths, queries, fragments, the combined fingerprint, unknown persisted keys, and raw failures are absent from public projections.

- [ ] **Step 8: Commit the safe domain boundary**

```bash
git add hub/approvalTypes.ts hub/approvalPolicy.ts hub/approvalPolicy.test.ts hub/heldApprovalRegistry.ts hub/heldApprovalRegistry.test.ts
git commit -m "feat(approvals): define safe approval domain"
```

---

### Task 3: SQLite Schema, Strict Decoding, and Keyset Reads

**Files:**

- Create: `hub/approvalMigrations.ts`
- Create: `hub/approvalRepository.ts`
- Create: `tests/approvalRepository.test.ts`
- Modify: `hub/conversations/migrations.ts`
- Modify: `tests/conversationMigrations.test.ts`

**Interfaces:**

- Produces: migration version 4, `ApprovalHistoryRepository`, `SqliteApprovalHistoryRepository`, strict record decoders, pending/history cursors, and notification-reference storage.
- Consumes: the one existing `bun:sqlite` `Database` and canonical types from Task 2.

- [ ] **Step 1: Write failing migration and schema-constraint tests**

Extend `tests/conversationMigrations.test.ts` to assert a real v3 database upgrades to v4 and contains all three tables. Export the existing v1–v3 SQL constants for test setup; the test runs those SQL blocks, inserts migration ledger rows `1..3`, sets `user_version=3`, and inserts a representative conversation before invoking the current runner:

```ts
test("migration four adds durable approval history without changing conversation rows", () => {
  const db = new Database(":memory:")
  createVersionThreeDatabase(db)
  runConversationMigrations(db)
  const names = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map(row => row.name)
  expect(names).toContain("approval_records")
  expect(names).toContain("approval_idempotency")
  expect(names).toContain("approval_notifications")
  expect(db.query("SELECT id FROM conversations WHERE id='before-v4'").get()).toBeTruthy()
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
  runConversationMigrations(db)
  expect(db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM conversation_schema_migrations WHERE version=4",
  ).get()?.count).toBe(1)
})
```

Add direct insert tests that reject invalid risk values and every invalid lifecycle/execution pair, while accepting these exact public pairs:

```ts
const validPairs = [
  ["pending", "not_applicable"],
  ["denied", "not_applicable"],
  ["expired", "not_applicable"],
  ["interrupted", "not_applicable"],
  ["granted", "pending"],
  ["granted", "succeeded"],
  ["granted", "failed"],
  ["granted", "interrupted"],
] as const
```

Also accept only the internal pair `registering + not_applicable`.

- [ ] **Step 2: Write failing repository visibility, persistence, and ordering tests**

Create `tests/approvalRepository.test.ts` using both `:memory:` and a temporary file database. Seed rows through repository methods, not raw SQL, except corruption/constraint tests.

Required first tests:

```ts
test("registering rows are excluded from get, list, search, and pending count", () => {
  const { repo } = harness()
  repo.insertRegistering(record({ id: "registering", state: "registering" }))
  expect(repo.getVisible("registering")).toBeNull()
  expect(repo.list({ group: "pending", limit: 50 }).items).toEqual([])
  expect(repo.pendingCount()).toBe(0)
})

test("sanitized terminal history survives a file reopen", () => {
  const file = temporaryDatabasePath()
  const first = openHarness(file)
  first.repo.insertRegistering(record({ id: "persisted" }))
  first.repo.activate("persisted", 1)
  first.repo.expire("persisted", 2_000)
  first.db.close()
  const second = openHarness(file)
  expect(second.repo.getVisible("persisted")).toMatchObject({ state: "expired", execution: "not_applicable" })
  second.db.close()
})

test("pending keyset order is risk desc, expiry asc, creation asc, id asc", () => {
  const { repo } = seededPendingHarness()
  const first = repo.list({ group: "pending", limit: 2 })
  const second = repo.list({ group: "pending", limit: 2, cursor: first.nextCursor! })
  expect([...first.items, ...second.items].map(item => item.id)).toEqual([
    "destructive-soon", "elevated-soon", "elevated-later", "low",
  ])
})

test("history keyset order is terminal time desc then id desc", () => {
  const { repo } = seededHistoryHarness()
  const first = repo.list({ group: "history", limit: 2 })
  const second = repo.list({ group: "history", limit: 2, cursor: first.nextCursor! })
  expect([...first.items, ...second.items].map(item => item.id)).toEqual(["z", "a", "old"])
})
```

Add cases for risk, kind, requester, state, authorized conversation ID, creation time, decision time, and sanitized `summary + target` search. The `requester` filter is an exact canonical `<surface>:<id>` value split at the first colon; validate surface as `[a-z0-9_-]+` and treat the remainder as the exact principal ID. Reject incompatible group/state combinations (for example `group=pending&state=denied`). Invalid, wrong-group, truncated, or non-finite cursors must throw a typed `invalid_cursor` error rather than falling back to page one.

Add an exact aggregate regression with more than 100 conversation-matching pending rows: `summarizePending` must report the full count, highest risk, global nearest expiry, and deterministic first ID even when the nearest expiry is outside the risk-first first page. Registration rows and unauthorized conversation filters never contribute.

- [ ] **Step 3: Run focused tests and confirm schema/repository failures**

Run: `bun test tests/conversationMigrations.test.ts tests/approvalRepository.test.ts`

Expected: FAIL because migration v4 and the repository do not exist.

- [ ] **Step 4: Add the approval migration as version 4 of the existing database**

Create `hub/approvalMigrations.ts` exporting one SQL string. Import it into `hub/conversations/migrations.ts`, apply it under `conversation_schema_migrations` version `4`, and finish with `PRAGMA user_version = 4`. Do not add a second database or a second competing `user_version` owner.

The migration must create this constrained shape:

```sql
CREATE TABLE approval_records (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  requested_surface TEXT NOT NULL,
  requested_id TEXT NOT NULL,
  origin_conversation_id TEXT,
  risk TEXT NOT NULL CHECK (risk IN ('low','elevated','destructive')),
  effect_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  terminal_at INTEGER,
  state TEXT NOT NULL CHECK (state IN ('registering','pending','granted','denied','expired','interrupted')),
  decision_surface TEXT,
  decision_id TEXT,
  decision_at INTEGER,
  decision_key TEXT,
  outcome_reason TEXT,
  execution_outcome TEXT NOT NULL CHECK (execution_outcome IN ('not_applicable','pending','succeeded','failed','interrupted')),
  execution_detail_json TEXT,
  execution_started_at INTEGER,
  execution_finished_at INTEGER,
  correlation_id TEXT NOT NULL,
  CHECK (expires_at >= created_at),
  CHECK (
    (state IN ('registering','pending','denied','expired','interrupted') AND execution_outcome='not_applicable') OR
    (state='granted' AND execution_outcome IN ('pending','succeeded','failed','interrupted'))
  )
);

CREATE INDEX approval_pending_order_idx
  ON approval_records(state, risk, expires_at, created_at, id);
CREATE INDEX approval_history_order_idx
  ON approval_records(state, terminal_at DESC, id DESC);
CREATE INDEX approval_origin_idx
  ON approval_records(origin_conversation_id, state, expires_at);

CREATE TABLE approval_idempotency (
  principal_surface TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approval_records(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_flight','completed')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (principal_surface, principal_id, idempotency_key)
);

CREATE TABLE approval_notifications (
  approval_id TEXT NOT NULL REFERENCES approval_records(id) ON DELETE CASCADE,
  adapter TEXT NOT NULL,
  reference TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (approval_id, adapter)
);
```

Change the existing migration runner from `db.transaction(... )()` to `db.transaction(...).immediate()` and test that v1–v4 ledger writes plus `user_version=4` remain atomic. Do not describe the current deferred transaction as already immediate.

- [ ] **Step 5: Define the repository boundary and strict row mapper**

In `hub/approvalRepository.ts`, expose an interface before its SQLite implementation:

```ts
export interface ApprovalHistoryRepository {
  insertRegistering(record: ApprovalRecord): { kind: "inserted" } | { kind: "id_collision" }
  activate(id: string, expectedVersion: number): ApprovalRecord | null
  interruptRegistration(id: string, now: number, reason: string): ApprovalRecord | null
  expire(id: string, now: number): ApprovalRecord | null
  getVisible(id: string): ApprovalRecord | null
  list(query: ApprovalListQuery): { items: ApprovalRecord[]; nextCursor: string | null }
  summarizePending(query: Omit<ApprovalListQuery, "group" | "cursor" | "limit">): ApprovalPendingAggregate
  pendingCount(): number
  putNotification(approvalId: string, adapter: string, reference: string, now: number): void
  listNotifications(approvalId?: string): Array<{ approvalId: string; adapter: string; reference: string }>
  listPendingMissingNotification(adapter: string, afterId: string | null, limit: number): ApprovalRecord[]
}

export class SqliteApprovalHistoryRepository implements ApprovalHistoryRepository {
  constructor(private readonly db: Database) {}
}
```

Map every column explicitly. Parse `detail_json`, `execution_detail_json`, and later `result_json` with a recursive `SafeValue` validator that rejects prototypes, non-finite numbers, unsupported values, excess depth, and oversized collections. Never spread the decoded object into a view. A malformed stored row throws `ApprovalRepositoryError("corrupt_record")`; HTTP later maps it to a generic safe unavailable response. `insertRegistering` converts only an approval-record primary-key collision into `id_collision`; disk errors, unrelated constraints, and foreign-key failures propagate as repository failures and are never retried as UUID collisions.

- [ ] **Step 6: Implement exact filters and composite cursors**

Represent cursor payloads as versioned JSON encoded with base64url:

```ts
type PendingCursor = { v: 1; group: "pending"; riskRank: number; expiresAt: number; createdAt: number; id: string }
type HistoryCursor = { v: 1; group: "history"; terminalAt: number; id: string }
```

Use rank `destructive = 3`, `elevated = 2`, `low = 1`. Pending cursor SQL must continue strictly after all four sort keys; history cursor SQL continues strictly below `(terminal_at, id)` in descending order. Fetch `limit + 1`, return at most the bounded limit, and derive the next cursor from the last returned item. Enforce `1..100`, default `50`.

All read SQL contains `state <> 'registering'`. Pending uses only `state='pending'`; history uses terminal lifecycle states and includes `granted` while execution is still pending. `summarizePending` applies the identical validated filters and conversation predicate as `list`, but uses aggregate SQL independent of cursor/limit. The single-record `expire` predicate is introduced here for the persistence fixture and completed with bounded batch expiry/race coverage in Task 4. `listPendingMissingNotification` is adapter-scoped, ID-keyset paged, and visible-pending only.

- [ ] **Step 7: Run focused verification**

Run: `bun test tests/conversationMigrations.test.ts tests/approvalRepository.test.ts && bun run typecheck`

Expected: migrations are idempotent, reopen persists safe rows, invalid pairs fail at SQLite, registering rows stay invisible, all filters/cursors are deterministic, and typecheck passes.

- [ ] **Step 8: Commit the durable read model**

```bash
git add hub/approvalMigrations.ts hub/approvalRepository.ts tests/approvalRepository.test.ts hub/conversations/migrations.ts tests/conversationMigrations.test.ts
git commit -m "feat(approvals): persist sanitized approval history"
```

---

### Task 4: Atomic Decisions, Durable Idempotency, Expiry, and Restart Reconciliation

**Files:**

- Modify: `hub/approvalRepository.ts`
- Modify: `tests/approvalRepository.test.ts`
- Modify: `tests/fixtures/sqliteLockWorker.ts`

**Interfaces:**

- Produces: decision reservation/finalization results, exact SQLite CAS transitions, durable principal-scoped bindings, expiry, execution completion, and startup reconciliation.
- Consumes: resource version, decision, principal, idempotency key, request hash, and a single transaction clock value.

- [ ] **Step 1: Write failing single-winner and decision-versus-expiry race tests**

Use two `Database` connections in separate Bun Workers against the same temporary file, adapting `tests/fixtures/sqliteLockWorker.ts` with a barrier so both operations are released together. Synchronous SQLite calls queued through promises in one isolate are not a concurrency test; SQLite, rather than JavaScript call order, must determine the winner:

```ts
test("decision CAS requires pending, exact version, and a future expiry", async () => {
  const file = temporaryDatabasePath()
  seedPendingFile(file, { id: "race", version: 2, expiresAt: 1_000 })
  const results = await runApprovalBarrierRace(file, {
    left: { op: "reserve", input: decisionInput({ id: "race", expectedVersion: 2, now: 1_000 }) },
    right: { op: "expire", id: "race", now: 1_000 },
  })
  const expiryWinners = results.filter(result =>
    (result.kind === "conflict" && result.code === "expired") ||
    (result.kind === "expire_result" && result.record !== null)
  )
  expect(expiryWinners).toHaveLength(1)
  expect(openHarness(file).repo.getVisible("race")?.state).toBe("expired")
})

test("only one concurrent different decision wins", async () => {
  const file = temporaryDatabasePath()
  seedPendingFile(file, { id: "decision-race", version: 2, expiresAt: 2_000 })
  const results = await runApprovalBarrierRace(file, {
    left: { op: "reserve", input: decisionInput({ id: "decision-race", decision: "grant", idempotencyKey: "grant-key", now: 1_000 }) },
    right: { op: "reserve", input: decisionInput({ id: "decision-race", decision: "deny", idempotencyKey: "deny-key", now: 1_000 }) },
  })
  expect(results.filter(result => result.kind === "won")).toHaveLength(1)
  expect(results.filter(result => result.kind === "conflict" && result.code === "already_resolved")).toHaveLength(1)
})
```

At `now === expiresAt`, expiry wins; the decision predicate is strictly `expires_at > now`. Count `{kind:"conflict", code:"expired"}` from reservation as the expiry winner because `reserveDecision` may perform the due-row CAS itself after its decision predicate loses.

- [ ] **Step 2: Write failing durable idempotency tests**

Add cases for:

```ts
test("the same principal key replays only the identical bound request", () => {
  const { repo } = pendingHarness()
  const input = decisionInput({ idempotencyKey: "same" })
  expect(repo.reserveDecision(input).kind).toBe("won")
  repo.finalizeGrantExecution(input.principal, "same", 3, {
    outcome: "succeeded", detail: { status: 204, attempts: 1 }, now: 20,
  })
  expect(repo.reserveDecision(input)).toMatchObject({ kind: "replay" })
  expect(repo.reserveDecision({ ...input, decision: "deny", requestHash: "different" }))
    .toMatchObject({ kind: "conflict", code: "idempotency_conflict" })
})

test("the same key is independent across principal surface and ID", () => {
  const { repo } = twoPendingHarness()
  expect(repo.reserveDecision(decisionInput({ id: "one", principal: { surface: "web", id: "a" }, idempotencyKey: "key" })).kind).toBe("won")
  expect(repo.reserveDecision(decisionInput({ id: "two", principal: { surface: "web", id: "b" }, idempotencyKey: "key" })).kind).toBe("won")
  expect(repo.reserveDecision(decisionInput({ id: "three", principal: { surface: "discord", id: "a" }, idempotencyKey: "key" })).kind).toBe("won")
})
```

Reopen the database and prove a completed binding still returns the original canonical stored result.

- [ ] **Step 3: Write failing execution and startup-reconciliation tests**

Cover all of these exact transitions:

- `registering -> interrupted/not_applicable` with `terminal_at` and a safe registration reason.
- `pending -> interrupted/not_applicable`, never invoking/reconstructing a closure.
- `granted/pending -> granted/interrupted` with reason `execution_outcome_unknown`.
- `granted/pending -> granted/succeeded|failed` only at the expected version.
- A pending/in-flight idempotency row is completed with the reconciled canonical result.
- Existing `denied`, `expired`, completed `granted`, and already `interrupted` rows remain unchanged.
- Notification references survive and are returned for later adapter refresh.

- [ ] **Step 4: Run tests and verify the transition methods are missing**

Run: `bun test tests/approvalRepository.test.ts`

Expected: FAIL on missing CAS/idempotency/reconciliation methods.

- [ ] **Step 5: Add discriminated repository results**

Extend `hub/approvalRepository.ts`:

```ts
export interface ApprovalDecisionReservationInput {
  approvalId: string
  principal: ApprovalPrincipal
  decision: ApprovalDecision
  expectedVersion: number
  idempotencyKey: string
  requestHash: string
  now: number
}

export type ApprovalDecisionReservation =
  | { kind: "won"; record: ApprovalRecord }
  | { kind: "replay"; result: ApprovalStoredDecisionResult }
  | { kind: "in_flight" }
  | { kind: "conflict"; code: "idempotency_conflict" | "stale_version" | "already_resolved" | "expired" | "interrupted"; record: ApprovalRecord | null }

export interface ApprovalReconciliation {
  lifecycleInterrupted: ApprovalRecord[]
  executionInterrupted: ApprovalRecord[]
  notifications: Array<{ approvalId: string; adapter: string; reference: string }>
}
```

Stored decision results contain only canonical approval ID, numeric version, lifecycle, execution, and safe execution detail. They never contain caller-specific conversation links or permissions.

Extend `ApprovalHistoryRepository` in this task with `expireDue(now: number, limit: number): ApprovalRecord[]`; enforce a small positive bounded limit at the repository boundary.

- [ ] **Step 6: Implement decision reservation in one immediate transaction**

The order inside `db.transaction(...).immediate()` is mandatory:

1. Read `(surface, ID, key)` first.
2. If present, compare the request hash before any stale-version check; return replay, in-flight, or idempotency conflict.
3. Load the visible record and classify missing/interrupted/resolved cases.
4. Attempt one `UPDATE` whose `WHERE` includes `id=? AND state='pending' AND version=? AND expires_at>?`.
5. A grant atomically writes `state='granted'`, `execution_outcome='pending'`, decision fields, `terminal_at`, increments version, and inserts an `in_flight` binding. A denial writes `state='denied'`, leaves execution `not_applicable`, increments version, and inserts an already `completed` binding with its stored canonical result in the same transaction.
6. If the CAS loses and the row is still pending but due, attempt the expiry CAS in the same transaction and return `expired`.
7. Return the new canonical row plus whether the binding is already completed (denial) or awaits grant execution finalization.

Do not insert an idempotency binding for a malformed, unauthorized, unknown, or stale request. Authorization remains a service responsibility and runs before this method.

- [ ] **Step 7: Implement finalization, expiry, and reconciliation CAS operations**

`finalizeGrantExecution(principal, key, expectedVersion, result)` uses one immediate transaction. It updates only `state='granted' AND execution_outcome='pending' AND version=?`, increments version, sets `execution_finished_at`, and changes the exact matching idempotency binding from `in_flight` to `completed` with strictly validated `result_json`. If either update cannot occur, the transaction rolls back so a final record can never exist without its replay result.

`expire` updates only `state='pending' AND expires_at<=?`, increments version, and sets terminal reason/time. It returns the resulting canonical row or `null`. `expireDue(now, limit)` applies the same predicate to a deterministic bounded batch within one immediate transaction and returns only CAS winners for service cleanup/events; repeated calls drain the due set. Denials require no later finalization because reservation completed their binding atomically.

`reconcileStartup(now)` uses one immediate transaction, applies all three interruption rules, derives completed stored results for affected in-flight bindings, and returns notification references. It is idempotent.

- [ ] **Step 8: Run focused verification**

Run: `bun test tests/approvalRepository.test.ts && bun run typecheck`

Expected: all races have exactly one SQLite winner, replays survive reopen, mismatched bindings conflict, reconciliation is idempotent, and every persisted state pair is valid.

- [ ] **Step 9: Commit lifecycle persistence**

```bash
git add hub/approvalRepository.ts tests/approvalRepository.test.ts tests/fixtures/sqliteLockWorker.ts
git commit -m "feat(approvals): enforce atomic durable lifecycle"
```

---

### Task 5: Ordered Events and the Shared Approval Operations Service

**Files:**

- Create: `hub/approvalEvents.ts`
- Create: `hub/approvalEvents.test.ts`
- Create: `hub/approvalService.ts`
- Create: `hub/approvalService.test.ts`
- Modify: `hub/types.ts`
- Modify: `hub/audit.ts`
- Modify: `hub/auditLog.ts`
- Modify: `tests/audit.test.ts`
- Modify: `tests/auditLog.test.ts`

**Interfaces:**

- Produces: `ApprovalEventStream`, `ApprovalNotificationPort`, `ApprovalOperationsError`, and `ApprovalOperationsService` request/read/decide/expire/reconcile/session/subscribe plus notification-activation/backfill methods.
- Consumes: repository, held registry, policy registry, workspace/core config, audit sink/query, clock, UUID generator, conversation visibility predicate, and optional notification ports.

- [ ] **Step 1: Write failing ordered-event tests by porting the complete Agents contract**

Create `hub/approvalEvents.test.ts`. Cover monotonic sequence, retained replay, too-old gap, cursor-ahead restart reset, reentrant publish order, copy isolation, unsubscribe, and subscriber failure cleanup. Event payloads are limited to IDs and aggregate counts:

```ts
test("events carry only changed ID and safe aggregate state", () => {
  const stream = new ApprovalEventStream(3)
  const event = stream.publish({ kind: "approval_changed", approvalId: "approval-1", pendingCount: 2, ts: 10 })
  expect(event).toEqual({ kind: "approval_changed", approvalId: "approval-1", pendingCount: 2, ts: 10, sequence: 1 })
  expect(JSON.stringify(event)).not.toContain("conversation")
  expect(JSON.stringify(event)).not.toContain("detail")
})
```

- [ ] **Step 2: Write failing two-phase request and notification-isolation service tests**

Create `hub/approvalService.test.ts` with a real in-memory SQLite repository and injected fakes:

```ts
test("request is invisible until the row and closure are both active", async () => {
  const h = serviceHarness({ pauseBeforeActivate: true })
  const pending = h.service.request(outboundDescriptor(), h.fire)
  await h.waitForRegisteringInsert()
  expect(h.repo.pendingCount()).toBe(0)
  expect(h.repo.list({ group: "pending", limit: 50 }).items).toEqual([])
  h.releaseActivation()
  await expect(pending).resolves.toMatchObject({ state: "pending" })
  expect(h.held.has(h.lastId())).toBe(true)
})

test("activation failure discards the closure and interrupts the row", async () => {
  const h = serviceHarness({ failActivation: true })
  await expect(h.service.request(outboundDescriptor(), h.fire)).rejects.toMatchObject({ code: "registration_failed" })
  expect(h.held.has(h.lastId())).toBe(false)
  expect(h.repo.getVisible(h.lastId())).toMatchObject({ state: "interrupted", execution: "not_applicable" })
})

test("notification failure leaves a visible pending request resolvable", async () => {
  const h = serviceHarness({ notifierError: new Error("raw secret") })
  await h.service.activateNotificationAdapter("fake")
  const record = await h.service.request(outboundDescriptor(), h.fire)
  expect(record.state).toBe("pending")
  await expect(h.service.decide(webOperator(), "workspace", decision(record))).resolves.toMatchObject({ approval: { state: "granted" } })
  expect(JSON.stringify(h.auditRows)).not.toContain("raw secret")
})
```

Verify audit, event, and notifier calls happen only after activation becomes visible.

Add notification-readiness tests: an unready adapter receives no gateway call and leaves no reference; activating that adapter atomically marks it ready and backfills every visible pending row missing its adapter reference in bounded ID-keyset pages. A request concurrent with backfill is notified exactly once, and retrying activation does not duplicate cards.

- [ ] **Step 3: Write failing authorization, projection, and audit-detail tests**

Cover:

- Hidden web identity receives typed `not_found` on workspace and legacy reads.
- Workspace viewer and operator see all globally sanitized shells.
- Viewer cannot decide; operator excluded by `webApprovers` sees details with `permissions.canDecide=false` but receives `forbidden` on decision.
- Legacy web uses the same role/decision policy but ignores `workspace.features.approvals` and requires core enabled.
- Discord principal authorization matches only `approvals.approvers`; an identical raw web identity cannot satisfy it.
- Authorization is rechecked before an idempotent replay.
- Every forbidden decision attempt, including a Discord non-approver and an operator excluded by `webApprovers`, produces a safe correlated authorization audit row.
- An authorized conversation participant receives `conversationId`; another globally authorized viewer receives the same shell without the ID/link.
- A supplied `conversationId` list filter is accepted only after `canViewConversation` succeeds; otherwise return typed `not_found` without querying or revealing whether matching approvals exist.
- Detail audit activity contains only `{ts, actor, action, outcome}` and never raw audit detail.
- A reopened row whose stored detail contains extra keys is projected through the kind policy and drops them; a row missing or mistyping a required kind field returns safe `approval_unavailable` and never echoes the corrupt value.

Extend `AuditFilter` in `hub/types.ts` with `corr?: string`, teach `matchAudit` and `AuditLog.scanSize` about it, and test `audit.recent({ corr: approvalId })`. This is the bounded source for related approval detail activity.

- [ ] **Step 4: Write failing execution, concurrency, expiry, and restart tests**

Required cases:

```ts
test("identical concurrent decisions share one final promise and execute once", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), h.deferredFire)
  const input = decision(record, { idempotencyKey: "one-key" })
  const first = h.service.decide(webOperator(), "workspace", input)
  const second = h.service.decide(webOperator(), "workspace", input)
  expect(h.fireCalls).toBe(1)
  h.finishFire({ outcome: "succeeded", detail: { status: 204, attempts: 1 } })
  expect(await first).toEqual(await second)
})

test("a definitive effect failure is a successful grant decision", async () => {
  const h = serviceHarness()
  const record = await h.service.request(outboundDescriptor(), async () => ({ outcome: "failed", detail: { status: 503, attempts: 3, failureCode: "http_error", body: "drop" } }))
  await expect(h.service.decide(webOperator(), "workspace", decision(record))).resolves.toMatchObject({
    approval: { state: "granted", execution: "failed", executionDetail: { status: 503, attempts: 3, failureCode: "http_error" } },
  })
})
```

Also test denial discards without calling, fingerprint mismatch/missing closure produces `granted + interrupted`, thrown closure maps to sanitized `failed/effect_rejected`, expiry discards without calling, decision-versus-expiry canonical conflict, lifecycle restart interruption language, granted execution interruption language, and no automatic replay after `reconcileStartup`.

Use a deferred grant to assert two separate observable transitions: immediately after the SQLite winner, audit/notifications/events expose `granted + execution pending`; only after the closure resolves do they expose the finalized `succeeded`, `failed`, or `interrupted` outcome. The original Discord card must not remain actionable while delivery is running.

Add an injected-ID collision test that returns an already persisted UUID once and a fresh UUID next; request registration retries and exposes only the fresh record. A file-reopen test with production-shaped UUIDs proves identifiers remain unique across repository recreation.

- [ ] **Step 5: Run tests and confirm missing service/event behavior**

Run: `bun test hub/approvalEvents.test.ts hub/approvalService.test.ts tests/audit.test.ts tests/auditLog.test.ts`

Expected: FAIL until the new stream, service, and correlation filter exist.

- [ ] **Step 6: Implement the immutable approval stream**

Adapt `AgentEventStream` rather than inventing a second delivery contract:

```ts
export type ApprovalEventInput =
  | { kind: "approval_changed"; approvalId: string; pendingCount: number; ts: number }
  | { kind: "approvals_snapshot"; pendingCount: number; ts: number }

export type ApprovalOperationsEvent = (
  ApprovalEventInput | { kind: "snapshot_required"; pendingCount?: number; ts: number }
) & { sequence: number }
```

Keep bounded replay, cursor-ahead reset, copy-on-publish/delivery, the reentrant pending queue, and `{ unsubscribe() }` exactly aligned with `hub/operations/agentEvents.ts`.

- [ ] **Step 7: Define the notification port and service dependency boundary**

In `hub/approvalService.ts`:

```ts
export interface ApprovalNotificationPort {
  readonly adapter: string
  post(input: { approval: ApprovalNotificationView; origin: { surface?: string; externalLocation?: string } | null }): Promise<string | null>
  update(reference: string, approval: ApprovalNotificationView): Promise<void>
}

export interface ApprovalNotificationLifecycle {
  activateNotificationAdapter(adapter: string): Promise<void>
  deactivateNotificationAdapter(adapter: string): void
}

export interface ApprovalOperationsDependencies {
  repository: ApprovalHistoryRepository
  held: HeldApprovalRegistry
  policies: ApprovalPolicyRegistry
  events: ApprovalEventStream
  workspace: WorkspaceConfig | undefined
  approvals: ApprovalConfig | undefined
  approversBySurface: Readonly<Record<string, readonly string[]>>
  audit(input: AuditInput): void
  relatedAudit(correlationId: string): AuditEvent[]
  canViewConversation(principal: ApprovalPrincipal, conversationId: string): boolean
  now(): number
  id(): string
  ttlMs: number
  notifications?: ApprovalNotificationPort[]
}
```

`ApprovalOperationsService` implements `ApprovalNotificationLifecycle`. Reject blank/duplicate adapter names at construction. Deactivation is used on adapter disconnect; it prevents new posts until the next activation/backfill without deleting durable references.

Define access contexts `"workspace" | "legacy" | "adapter"`. Workspace reads require the workspace feature; legacy reads require core enabled but not the workspace feature; adapter decisions require core enabled and a surface-specific approver policy.

`ApprovalNotificationView` is a separate explicit projection containing only ID, version, kind, target, summary, requested principal, risk, timestamps, lifecycle, decision, and execution fields required to render a card. It has no permissions, audit activity, conversation ID, effect fingerprint, decision key, or notification reference.

Use one safe typed error shape:

```ts
export type ApprovalOperationsErrorCode =
  | "not_found" | "forbidden" | "invalid_request" | "invalid_cursor"
  | "stale_version" | "already_resolved" | "idempotency_conflict"
  | "expired" | "interrupted" | "registration_failed" | "approval_unavailable"

export class ApprovalOperationsError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    readonly code: ApprovalOperationsErrorCode,
    readonly recovery: "none" | "reload" | "contact_operator",
    readonly canonical: ApprovalDetailView | null = null,
  ) { super(code) }
}
```

The service uses `404` for hidden feature/identity/non-visible records, `403` for visible-but-non-deciding callers, `400` for malformed inputs, `409` for canonical races/conflicts, and `500` only before a canonical decision exists. Effective web decision capability includes `approvals.enabled === true`; a core-disabled operator never receives controls. A winning grant with failed or interrupted execution is a normal `ApprovalDecisionResult`, not an exception.

- [ ] **Step 8: Implement two-phase request activation with collision retry**

`request(descriptor, fire)` must:

1. Require core approvals enabled and a registered policy.
2. Validate bounded non-empty trusted principal/origin values: kind/surface at most 64 UTF-8 bytes and principal/conversation IDs at most 256. Reject non-safe-integer timestamps and TTL overflow.
3. Call the kind policy with the complete descriptor; use only its derived target, summary, stored detail, risk, and internal fingerprint. Explicitly copy the validated principal and verified origin rather than spreading the descriptor.
4. Allocate `id()` and insert `registering`; retry only the repository's discriminated `id_collision`, up to a fixed safe bound such as 5 attempts. Every other repository failure aborts immediately.
5. Activate `{effectFingerprint, fire}` in memory.
6. CAS the row from version 1/registering to version 2/pending.
7. On failure, discard the held entry and interrupt the registration.
8. Only then audit, publish, and invoke each currently ready notifier independently.
9. Persist only a notifier's opaque reference; notifier failure emits safe audit evidence and does not change approval state. An adapter that is not ready is deliberately deferred rather than called.

Copy only verified `origin.conversationId` supplied by trusted hub composition. Keep `origin.surface/externalLocation` in a bounded memory-only notification-context map keyed by approval ID until every configured adapter has either stored a reference or made a ready no-destination attempt; pass it to normal/backfill notification calls, then discard it. Never persist or project this routing context. This preserves origin-channel fallback for requests created before Discord readiness without weakening restart fail-closed behavior.

- [ ] **Step 9: Implement reads, projections, decisions, expiry, and reconciliation**

Public list/detail projection constructs every field explicitly, obtains `detail` only through the record kind's `projectDetail`, stringifies numeric versions, and calls `canViewConversation` before adding `conversationId`. Detail adds effective `permissions.canDecide` and related safe audit activity. The service maps a missing policy or invalid persisted kind detail to a safe unavailable result; it never returns the generic decoded object directly. Pending list responses include the repository's exact query-scoped aggregate, while history returns `null`.

For decisions, reauthorize first, validate the opaque version as a non-zero safe integer string without exposing numeric semantics to clients, validate a bounded non-empty key, and create a stable SHA-256 request hash from `{approvalId, decision, expectedVersion}`. Key the in-flight map by `{surface,id,idempotencyKey}`, but store `{requestHash,promise}` as its value: an identical hash awaits the same promise, while a different hash immediately returns `idempotency_conflict`. Install that entry synchronously before entering the repository so identical calls cannot race past it.

After a winning grant CAS, immediately audit, update stored notifications, and publish `granted + execution pending` before awaiting external work, so every surface disables stale buttons during delivery. Then consume the closure once and compare its fingerprint using `timingSafeEqual` on equal-length buffers. A missing/mismatched closure finalizes execution as interrupted. Otherwise await `fire(approvalId)`, sanitize through the kind policy, finalize execution and the idempotency result, then emit the second audit/notification/event transition. A denial discards and completes immediately. All replay/conflict results are projected only after fresh authorization. After every canonical lifecycle or execution transition, update every stored notification reference independently with a fresh `ApprovalNotificationView`; a failed update records only safe operational audit evidence and never changes canonical state. An authorized adapter replay or conflict also refreshes its stored card to the fresh canonical view, while an unauthorized attempt leaves the card unchanged.

`expireDue()` drains repository CAS batches, discards matching held entries, and emits audit/notification/events. `reconcileStartup()` runs before accepting work; it never fires a closure and returns notification refresh work for adapters that start later.

Notification ports begin inactive. `activateNotificationAdapter(adapter)` serializes per adapter, marks it ready, and then calls `backfillMissingNotifications(adapter)` through bounded ID-keyset pages. Both normal creation and backfill call one `ensureNotification(adapter, approvalId)` path with an in-process `{adapter,approvalId}` promise map, then recheck current pending state and reference absence before posting with any memory-only origin context. This prevents a request racing the backfill from producing two cards in one process. Successful opaque references are persisted and repeat activation is idempotent. Requests created before readiness are therefore not lost; requests created after the ready bit is set use the normal path. Startup reconciliation refreshes existing references only after the matching adapter is active.

- [ ] **Step 10: Run focused verification**

Run: `bun test hub/approvalEvents.test.ts hub/approvalService.test.ts tests/audit.test.ts tests/auditLog.test.ts && bun run typecheck`

Expected: all service lifecycle, authorization, redaction, concurrency, expiry, restart, event, and audit tests pass.

- [ ] **Step 11: Commit the shared application service**

```bash
git add hub/approvalEvents.ts hub/approvalEvents.test.ts hub/approvalService.ts hub/approvalService.test.ts hub/types.ts hub/audit.ts hub/auditLog.ts tests/audit.test.ts tests/auditLog.test.ts
git commit -m "feat(approvals): add shared approval operations service"
```

---

### Task 6: Versioned Discord Cards and the Notification Adapter

**Files:**

- Modify: `hub/approval.ts`
- Modify: `tests/approval.test.ts`
- Create: `hub/approvalDiscordNotifications.ts`
- Create: `hub/approvalDiscordNotifications.test.ts`
- Modify: `hub/gateway.ts`
- Modify: `hub/gateway.test.ts`
- Modify: `tests/transportMirror.test.ts`

**Interfaces:**

- Produces: versioned approval custom IDs, a stable Discord decision key, pure pending/terminal card rendering, interaction IDs at the gateway boundary, and `DiscordApprovalNotificationPort`.
- Consumes: sanitized approval views plus existing `Gateway.sendCard`/`editCard` primitives.

- [ ] **Step 1: Replace old registry tests with failing versioned card/custom-ID tests**

Remove tests for the obsolete `ApprovalRegistry` from `tests/approval.test.ts`; lifecycle now belongs to the service/repository tests. Keep pure card tests and rewrite them against sanitized views:

```ts
test("versioned approval custom IDs round-trip and reject old or malformed IDs", () => {
  const id = approvalCustomId("approval-7", "grant", "12")
  expect(id).toBe("approval:grant:12:approval-7")
  expect(parseApprovalCustomId(id)).toEqual({ id: "approval-7", decision: "grant", version: "12" })
  expect(parseApprovalCustomId("approval:grant:approval-7")).toBeNull()
  expect(parseApprovalCustomId("approval:grant::approval-7")).toBeNull()
})

test("pending cards contain version-bound controls and terminal cards remove them", () => {
  const pending = approvalView({ id: "approval-7", version: "12", state: "pending" })
  expect(renderApprovalCard(pending).buttons.map(button => button.customId)).toEqual([
    "approval:grant:12:approval-7",
    "approval:deny:12:approval-7",
  ])
  expect(renderApprovalCard(approvalView({ state: "granted", execution: "failed" })).buttons).toEqual([])
})

test("interrupted granted execution is described as unknown, not discarded", () => {
  const card = renderApprovalCard(approvalView({ state: "granted", execution: "interrupted" }))
  expect(`${card.title} ${card.body}`).toContain("outcome unknown")
  expect(`${card.title} ${card.body}`).not.toContain("did not run")
})
```

Add stable-key tests proving an interaction ID is preferred and the deterministic fallback changes across approval/version/decision/principal.

- [ ] **Step 2: Write failing gateway interaction-boundary tests**

Extend `hub/gateway.test.ts` so a synthetic Discord button interaction proves:

- `onNotifyButton` receives `(customId, userId, interactionId)`.
- An approval namespace bypasses the generic base/notify authorization gates and reaches the shared callback for audited service authorization.
- Approval buttons use `deferUpdate()` and leave the original actionable card intact while authorization runs.
- Non-approval buttons preserve the existing allowlist, notify-gate, and disabled Working-row behavior.
- An async callback is awaited and a rejected callback is caught without an unhandled rejection.

Also expose and test `onConnectionState(cb)` on `Gateway`. Emit `"ready"` for Discord.js `clientReady`, `shardReady`, and `shardResume`, and `"disconnected"` for `shardDisconnect`; deduplicate repeated identical states. Synthetic client events must prove disconnect then resume produces exactly one state transition each and does not alter inbound/button behavior.

- [ ] **Step 3: Write failing Discord notification-port tests**

Create `hub/approvalDiscordNotifications.test.ts` around an injected gateway façade:

```ts
test("post returns an opaque reference and update edits the same message", async () => {
  const gateway = fakeGateway({ messageId: "message-9" })
  const port = new DiscordApprovalNotificationPort(gateway, { channelId: "approval-channel" })
  const reference = await port.post({ approval: approvalView(), origin: { surface: "discord", externalLocation: "origin-channel" } })
  expect(reference).toBeTruthy()
  await port.update(reference!, approvalView({ state: "denied" }))
  expect(gateway.sent[0].chatId).toBe("approval-channel")
  expect(gateway.edited[0]).toMatchObject({ chatId: "approval-channel", messageId: "message-9" })
})

test("origin channel is fallback and invalid stored references fail safely", async () => {
  const gateway = fakeGateway({ messageId: "message-1" })
  const port = new DiscordApprovalNotificationPort(gateway, {})
  await port.post({ approval: approvalView(), origin: { surface: "discord", externalLocation: "origin-channel" } })
  expect(gateway.sent[0].chatId).toBe("origin-channel")
  await expect(port.update("not-json", approvalView())).rejects.toThrow("invalid_notification_reference")
})
```

Add a gateway regression where Discord message editing rejects. The strict approval-edit primitive must reject to the notification port so the service can write safe operational audit evidence; the existing compatibility `editCard` may retain its catch-and-log behavior for unrelated callers.

The opaque reference JSON contains only `{chatId,messageId}` and is never returned by the service/API.

- [ ] **Step 4: Run the focused tests and verify expected failures**

Run: `bun test tests/approval.test.ts hub/approvalDiscordNotifications.test.ts hub/gateway.test.ts tests/transportMirror.test.ts`

Expected: FAIL until versioning, interaction IDs, approval gate bypass, a failure-reporting edit primitive, and the notification port are implemented.

- [ ] **Step 5: Reduce `hub/approval.ts` to a pure Discord presentation adapter**

Delete `ApprovalRegistry`, `PendingApproval`, and the old `ApprovalFire` definition. Import canonical view/decision types from `approvalTypes.ts` and implement:

```ts
export function approvalCustomId(id: string, decision: ApprovalDecision, version: string): string {
  if (!id || !version || id.includes(":") || version.includes(":")) throw new Error("invalid_approval_custom_id")
  return `approval:${decision}:${version}:${id}`
}

const CUSTOM_ID = /^approval:(grant|deny):([^:]+):([^:]+)$/

export function parseApprovalCustomId(customId: string): { id: string; decision: ApprovalDecision; version: string } | null {
  const match = CUSTOM_ID.exec(customId)
  return match ? { decision: match[1] as ApprovalDecision, version: match[2], id: match[3] } : null
}
```

Use `createHash("sha256")` for a bounded deterministic fallback key over approval ID, version, decision, and Discord principal. Card rendering uses only sanitized fields and has explicit copy for pending, denied, expired, lifecycle interrupted, granted/succeeded, granted/failed, and granted/interrupted.

- [ ] **Step 6: Extend the gateway callback without weakening non-approval controls**

Change the callback type to:

```ts
private notifyButtonCb: (customId: string, userId: string, interactionId: string) => void | Promise<void> = () => {}
onNotifyButton(cb: typeof this.notifyButtonCb): void { this.notifyButtonCb = cb }
```

For `interaction.customId.startsWith("approval:")`, Discord itself has authenticated `interaction.user`; bypass the generic base and notify gates, `await interaction.deferUpdate()`, and await the callback with `interaction.id`. Every other namespace keeps current authorization and Working-row behavior. The approval service—not the gateway—will accept or deny and audit the actor.

Add `Gateway.editCardOrThrow(chatId, messageId, card): Promise<void>` using the same fetch/build/edit logic without swallowing errors or silently accepting a non-message channel. Leave the existing `editCard` compatibility wrapper unchanged or implement it by calling the strict method and retaining its current catch/log semantics. Approval notification updates must use the strict primitive.

Add `onConnectionState(cb: (state: "ready" | "disconnected") => void): void` as a narrow gateway lifecycle seam backed by the Discord.js client events named above. The callback is synchronous and exception-isolated; async service work remains the composition layer's responsibility.

- [ ] **Step 7: Implement the optional Discord notification port**

`DiscordApprovalNotificationPort` implements the Task 5 interface, chooses configured approval channel before trusted origin location, calls `renderApprovalCard`, uses `editCardOrThrow` for updates, and strictly decodes its own stored reference. It has no lifecycle, readiness, or authorization logic. Do not construct it when Discord is disabled.

- [ ] **Step 8: Run focused verification**

Run: `bun test tests/approval.test.ts hub/approvalDiscordNotifications.test.ts hub/gateway.test.ts tests/transportMirror.test.ts && bun run typecheck`

Expected: existing non-approval interaction behavior remains green, approval attempts reach the service boundary, and all card/reference tests pass.

- [ ] **Step 9: Commit the Discord adapter**

```bash
git add hub/approval.ts tests/approval.test.ts hub/approvalDiscordNotifications.ts hub/approvalDiscordNotifications.test.ts hub/gateway.ts hub/gateway.test.ts tests/transportMirror.test.ts
git commit -m "feat(approvals): route Discord cards through shared service"
```

---

### Task 7: Awaited Outbound Producer and Safe Hub Startup Composition

**Files:**

- Create: `hub/outboundApproval.ts`
- Create: `hub/outboundApproval.test.ts`
- Create: `tests/phase4ApprovalCompositionSmoke.test.ts`
- Modify: `hub/index.ts`
- Modify: `hub/conversations/turnCoordinator.ts`
- Modify: `tests/turnCoordinator.test.ts`
- Modify: `tests/discordOptional.test.ts`
- Modify: `tests/outboundDelivery.test.ts`

**Interfaces:**

- Produces: immutable memory-only outbound snapshots, awaited `ApprovalExecutionResult` conversion, verified provenance derivation, and one production `ApprovalOperationsService` composition.
- Consumes: the existing `OutboundDelivery.deliver`, shared SQLite database, audit log, optional Discord port, conversation repository, and generic service.

- [ ] **Step 1: Write failing awaited-delivery adapter tests**

Create `hub/outboundApproval.test.ts`:

```ts
test("the approval execution promise remains pending until delivery finishes", async () => {
  const delivery = deferred<DeliveryResult>()
  const auditRows: AuditInput[] = []
  const execution = executeOutboundApproval({
    route: route(), body: "exact", actor: "agent:qa", correlationId: "approval-1",
    deliver: async () => delivery.promise,
    audit: row => auditRows.push(row),
  })
  expect(await promiseState(execution)).toBe("pending")
  delivery.resolve({ ok: true, attempts: 2, status: 204 })
  await expect(execution).resolves.toEqual({ outcome: "succeeded", detail: { status: 204, attempts: 2 } })
  expect(auditRows[0]).toMatchObject({ kind: "outbound", corr: "approval-1", outcome: "ok" })
})

test("definitive delivery failures map to bounded safe codes", async () => {
  await expect(run({ ok: false, attempts: 3, status: 503 })).resolves.toEqual({ outcome: "failed", detail: { status: 503, attempts: 3, failureCode: "http_error" } })
  await expect(run({ ok: false, attempts: 3, status: "error" })).resolves.toEqual({ outcome: "failed", detail: { attempts: 3, failureCode: "network_error" } })
  await expect(run({ ok: false, attempts: 0, status: "blocked" })).resolves.toEqual({ outcome: "failed", detail: { attempts: 0, failureCode: "blocked" } })
})

test("snapshot captures route, headers, and body before later config mutation", () => {
  const source = route({ headers: { "x-mode": "before" } })
  const held = captureOutboundEffect(source, "before-body")
  source.url = "https://changed.example"
  source.headers!["x-mode"] = "after"
  expect(held.route.url).not.toContain("changed")
  expect(held.route.headers).toEqual({ "x-mode": "before" })
  expect(held.body).toBe("before-body")
})
```

The snapshot is executable and secret-bearing by design, so it remains only inside the held closure.

- [ ] **Step 2: Write the failing real-service composition smoke test**

Create `tests/phase4ApprovalCompositionSmoke.test.ts` with a file SQLite database, real repository/service/policy/held registry, and real `OutboundDelivery` with injected fetch:

- Core disabled or an ungated route delivers directly.
- A gated route creates a generic pending approval and performs zero fetches before grant.
- Web grant waits for delivery and fetches once.
- A canonical agent text trigger records the verified conversation ID; `consume` suppresses external surface delivery while keeping the canonical transcript message.
- A legacy Discord text trigger resolves provenance through its canonical transport link; tool and hub-event routes omit conversation provenance.
- Discord and web decisions against the same request have one winner and at most one fetch.
- A Discord non-approver reaches the shared service, leaves the request pending, and produces a safe denied-attempt audit row.
- With no Discord port, web request/view/decision still works.
- A legacy Discord-origin request arriving after agent transports start but before Discord login completes is deferred and receives exactly one origin-channel card during adapter activation backfill even when no global approval channel is configured.
- A synthetic Discord disconnect deactivates notification posting; requests created while disconnected are backfilled exactly once after the gateway emits resume/ready.
- Reopening the DB interrupts pending and granted/execution-pending rows without replay.
- A decision/expiry boundary race has one terminal SQLite winner.

- [ ] **Step 3: Run focused tests and confirm the missing adapter/composition**

Run: `bun test hub/outboundApproval.test.ts tests/phase4ApprovalCompositionSmoke.test.ts tests/outboundDelivery.test.ts tests/discordOptional.test.ts`

Expected: FAIL until the adapter and production-equivalent composition exist.

- [ ] **Step 4: Implement immutable snapshots and awaited result conversion**

In `hub/outboundApproval.ts`, clone only the known `OutboundRoute` fields into a fresh object and clone static headers. `executeOutboundApproval` must `await deliver(route, body)`, write the correlated outbound audit row, and return the exact safe result mapping used in Step 1. A thrown delivery maps to `{outcome:"failed", detail:{failureCode:"effect_rejected", attempts:0}}` after safe audit; never return the exception text.

- [ ] **Step 5: Move the one SQLite connection and reconciliation before all producers**

In `hub/index.ts`, open:

```ts
const conversationDb = new Database(
  hub.conversationDbFile ?? join(hub.stateDir, "switchboard.sqlite"),
  { create: true },
)
const conversationRepo = new SqliteConversationRepository(conversationDb)
const approvalRepo = new SqliteApprovalHistoryRepository(conversationDb)
```

after audit dependencies exist but **before persistent transports start near the current line 1303**, and therefore before `startWebhookListener` and `startCron`. Construct one outbound policy with `randomBytes(32)`, a held registry, event stream, and service with `id: () => randomUUID()`, then call startup reconciliation there. Preserve the existing Discord default:

```ts
const discordApprovers = hub.approvals?.approvers ?? (deployApprover ? [deployApprover] : [])
```

Pass `{ discord: discordApprovers }` as `approversBySurface`; future adapters extend this map without changing lifecycle code. Remove the later duplicate DB/repository construction near the current line 2204 and reuse these instances for canonical conversations and coordinated shutdown.

This ordering is a hard gate: `post_webhook` frames can arrive as soon as agent transports start, so merely reconciling before `startWebServer` is too late.

- [ ] **Step 6: Replace every duplicated lifecycle path with the service**

Delete the old `ApprovalRegistry`, counter IDs, `approvalCards`, inline `requestApproval`, Discord `resolveApproval`, duplicated `WebDeps.resolveApproval`, and direct registry expiry sweep. Wire:

- `deliverAudited` to `approvalService.request` for `requireApproval` routes.
- Gateway approval buttons to `approvalService.decide({surface:"discord",id:userId}, "adapter", ...)` using parsed version and the interaction-derived stable key.
- Doctor/metrics/status aggregate to `approvalService.pendingCount()`.
- Periodic expiry to `approvalService.expireDue()`.
- Web dependencies to the shared service in Task 8.
- Startup notification activation, missing-card backfill, and stale-reference refresh after Discord adapters start; with Discord disabled, no port or refresh is required.

Keep direct ungated delivery fire-and-forget at its caller boundary with an explicit `.catch` log, but `executeOutboundApproval` itself always returns and awaits the delivery promise. Audit every production fire-and-forget boundary: callers that do not await `approvalService.request(...)`, canonical post-commit registration, socket/webhook-trigger registration, and the periodic `expireDue()` sweep attach a safe `.catch` that records an enumerated operational failure without raw exception text. No rejecting service promise may become an unhandled rejection.

- [ ] **Step 7: Derive provenance only from server-owned state**

The socket `post_webhook` frame contains only `{target,body}`, and hub events have no canonical turn, so omit `origin.conversationId` for both.

For canonical agent replies, verify `conversationRepo.getConversation(reply.chatId)` before treating `reply.chatId` as a conversation ID. Pure-match and capture immutable outbound route/body snapshots before calling `TurnCoordinator.acceptAgentReply`, then pass an explicit `{suppressSurfaceDelivery: matches.some(match => match.route.consume)}` option. A consuming match passes no external links to `appendAgentMessage`, so the canonical transcript is still committed while Discord/other surface delivery is suppressed. Only after `acceptAgentReply` returns `{inserted:true}` should hub composition register the captured approval effects with the verified conversation origin; a failed or duplicate canonical commit creates no approval. Add `tests/turnCoordinator.test.ts` coverage for suppressed and normal delivery and composition coverage for commit-before-approval ordering.

For legacy Discord text-trigger routes, derive:

```ts
const conversationId = conversationRepo
  .resolveTransportLink("discord", externalLocationId)
  ?.conversationId
```

For a canonical conversation, a Discord notification fallback may be derived from a server-owned enabled Discord transport link. Pass that external location only as memory-only notification context. Do not trust a conversation ID from tool arguments, body data, route configuration, or agent text. Add composition assertions that the banner exists only for verified canonical/resolved-link cases.

- [ ] **Step 8: Preserve optional Discord and notification refresh behavior**

Construct `DiscordApprovalNotificationPort` only when `discordGateway` exists and register it inactive with the service. Pass no notification ports in web-only mode. Before starting surfaces, subscribe to `discordGateway.onConnectionState`: `disconnected` calls `deactivateNotificationAdapter("discord")`; `ready` starts `activateNotificationAdapter("discord")` with a safe caught/audited promise. After `surfaceRouter.startAll` completes, await one explicit activation as an idempotent initial-login fallback. Activation sets readiness before performing the bounded pending-without-reference backfill, so requests that arrived while earlier agent transports were accepting `post_webhook` frames—or while Discord was disconnected—cannot miss cards. Then update stale references returned by startup reconciliation. A strict edit rejection records a safe operational audit row and does not alter canonical history. Existing references and `ensureNotification` prevent duplicate posts on repeated ready/resume events.

- [ ] **Step 9: Run focused verification**

Run: `bun test hub/outboundApproval.test.ts tests/phase4ApprovalCompositionSmoke.test.ts tests/turnCoordinator.test.ts tests/outboundDelivery.test.ts tests/discordOptional.test.ts tests/phase2CompositionSmoke.test.ts && bun run typecheck`

Expected: delivery outcome is awaited and truthful, startup ordering is safe, Discord is optional, provenance is verified, and existing Phase 2 composition remains green.

- [ ] **Step 10: Commit production composition**

```bash
git add hub/outboundApproval.ts hub/outboundApproval.test.ts tests/phase4ApprovalCompositionSmoke.test.ts hub/index.ts hub/conversations/turnCoordinator.ts tests/turnCoordinator.test.ts tests/discordOptional.test.ts tests/outboundDelivery.test.ts
git commit -m "feat(approvals): compose shared lifecycle before producers"
```

---

### Task 8: Operations API, SSE, Session Contract, and `/legacy` Compatibility

**Files:**

- Modify: `hub/webServer.ts`
- Modify: `tests/webServer.test.ts`
- Modify: `tests/conversationWeb.test.ts`
- Modify: `hub/web.ts`
- Modify: `hub/web.test.ts`
- Modify: `hub/webActions.ts`
- Modify: `hub/webActions.test.ts`
- Modify: `tests/web.test.ts`
- Modify: `tests/fixtures/workspaceE2eServer.ts`
- Modify: `hub/index.ts`

**Interfaces:**

- Produces: authenticated workspace/compatibility routes, exact status/error/cache mappings, approval SSE, and the expanded session JSON.
- Consumes: a narrow `approvalOperations` dependency and trusted `requireUser` identity.

- [ ] **Step 1: Replace the fake web dependency and write failing session/feature tests**

Replace `WebDeps.resolveApproval` with:

```ts
approvalOperations: Pick<ApprovalOperationsService,
  "session" | "list" | "get" | "decide" | "subscribe"
>
```

In `tests/webServer.test.ts`, make the fake expose deterministic approval responses. Add:

```ts
test("session exposes independent approval visibility, production, role, decision, and count", async () => {
  const response = await handleWebRequest(get("/api/session", auth), fakeDeps({
    approvalOperations: fakeApprovalOperations({
      session: { feature: true, coreEnabled: false, role: "operator", canDecide: false, pendingCount: 3 },
    }),
  }))
  expect(await response.json()).toMatchObject({
    features: { approvals: true },
    permissions: { approvals: "operator" },
    approvalState: { producing: false, canDecide: false, pendingCount: 3 },
  })
})
```

Test workspace routes return `404` for a hidden identity or disabled workspace feature, while compatibility routes still work when core is enabled and workspace feature is off.

- [ ] **Step 2: Write failing list/detail/filter/decision HTTP tests**

Cover the operations routes:

```text
GET  /api/operations/approvals
GET  /api/operations/approvals/:id
POST /api/operations/approvals/:id/decision
GET  /api/operations/approvals/events
```

and compatibility routes:

```text
GET  /api/approvals
POST /api/approvals/:id
```

Assert exact decoding for `group`, `state`, `risk`, `kind`, `requester`, `conversationId`, `createdFrom`, `createdTo`, `decisionFrom`, `decisionTo`, `search`, `cursor`, and `limit`. `requester` uses the canonical `<surface>:<id>` syntax and incompatible group/state pairs are invalid. URI decoding errors and malformed filters/cursors return `400`.

For pending queries, assert the response includes the exact query-scoped aggregate `{count,highestRisk,nearestExpiry,firstId}` from the service even when the returned page limit is one; history returns `querySummary:null`. Conversation authorization occurs before either page or aggregate SQL.

Decision tests must require:

```http
Idempotency-Key: non-empty
Content-Type: application/json

{"decision":"grant","expectedVersion":"2"}
```

Missing/blank key or version and invalid decisions return `400`; viewer returns `403`; hidden/not-visible returns `404`; stale/idempotency/expiry/other-winner conflicts return `409` with safe canonical state when authorized. Any winning grant returns `200` with its final canonical execution state, including definitive `failed` and missing/mismatched-closure `interrupted` outcomes; only a failure before a canonical decision maps to `500`.

- [ ] **Step 3: Write failing approval SSE tests**

Mirror the Agents SSE tests exactly:

- Authenticate before subscription.
- Prefer `?after=` over `Last-Event-ID` and reject non-safe integers.
- Emit `id: <sequence>` and one JSON data frame.
- Return `snapshot_required`/restart reset unchanged.
- Unsubscribe on stream cancellation.
- Expose no conversation ID or detail in event frames.
- Use `Cache-Control: no-cache` and `X-Accel-Buffering: no`.

- [ ] **Step 4: Write failing unauthenticated-status and legacy-dashboard tests**

Remove `pendingApprovalList` assertions from the broad dashboard payload and add:

```ts
test("unauthenticated status exposes only the aggregate approval count", async () => {
  const response = await handleWebRequest(get("/api/status"), fakeDeps())
  const body = await response.json() as Record<string, unknown>
  expect(body.pendingApprovals).toBe(2)
  expect(body).not.toHaveProperty("pendingApprovalList")
  expect(JSON.stringify(body)).not.toContain("approval-1")
})
```

Legacy HTML/script tests must prove it fetches relative authenticated `api/approvals`, renders the current version, creates one `crypto.randomUUID()` key per decision attempt, posts the rendered `expectedVersion`, and reuses the key only for an ambiguous retry. The legacy UI must not inspect the old `/api/status` list.

Add a hostile sanitized-string fixture such as `<img src=x onerror=alert(1)>`; the legacy client must render it as text, never executable markup.

- [ ] **Step 5: Run focused tests and confirm route/contract failures**

Run: `bun test tests/webServer.test.ts tests/conversationWeb.test.ts hub/web.test.ts hub/webActions.test.ts tests/web.test.ts`

Expected: FAIL until shared-service routes, cache headers, session fields, and legacy separation are implemented.

- [ ] **Step 6: Implement common JSON/cache/error helpers and route parsing**

Add an approval JSON helper:

```ts
const approvalJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
})
```

Construct principals only from `requireUser`: `{surface:"web", id:email}`. Pass access context `workspace` for `/api/operations/approvals/**` and `legacy` for `/api/approvals/**`. Never authorize by trusting request JSON.

Map typed `ApprovalOperationsError` codes to the design's concrete statuses. Unexpected exceptions return `{error:"approval_unavailable",recovery:"reload"}` with `500`; do not return exception messages.

- [ ] **Step 7: Add the operations/compatibility routes and SSE**

Operations list/detail/decision call the service with workspace context. Compatibility list is pending by default and uses legacy context; compatibility decision accepts the same version/key contract. Both are guarded routes and reject wrong methods only after authentication, matching existing anti-probing behavior.

The SSE helper uses the same ordered framing/cancellation logic as `agentOperationsSseResponse`, with `X-Accel-Buffering: no`. Authorize through a harmless service read/session call before subscribing.

- [ ] **Step 8: Expand session and separate the legacy status payload**

Return this browser contract:

```ts
{
  identity,
  agents,
  features: { agents: agentAccess.feature, approvals: approvalAccess.feature },
  permissions: { agents: agentAccess.role, approvals: approvalAccess.role },
  approvalState: {
    producing: approvalAccess.coreEnabled,
    canDecide: approvalAccess.canDecide,
    pendingCount: approvalAccess.feature ? approvalAccess.pendingCount : 0,
  },
}
```

Remove `pendingApprovalList` from `WebInput`, `DashboardJson`, `collectWeb`, and `renderDashboardJson`. Delete only the obsolete `PendingApprovalJson`/`pendingApprovalsToJson` helper and its test; preserve unrelated mirror/inbound helpers in `webActions.ts`.

Update `tests/fixtures/workspaceE2eServer.ts` in this task, not Task 13: remove its typed `pendingApprovalList` dashboard field and replace required `resolveApproval` with a deterministic `approvalOperations` fake/delegate that reports the feature hidden and core disabled. This keeps `WebDeps` and `WebInput` type-correct until Task 13 replaces the fake with the real approval runtime.

- [ ] **Step 9: Update the embedded legacy client**

On each dashboard refresh, load aggregate status and authenticated approvals separately. Render only canonical sanitized list fields using DOM nodes plus `textContent` (or one tested escaping helper), never approval-field interpolation into `innerHTML`. Store the rendered version on each button. Decision code sends `{decision,expectedVersion}` and `Idempotency-Key`; on `409` or ambiguous failure, reload canonical approvals before enabling another action.

- [ ] **Step 10: Run focused verification**

Run: `bun test tests/webServer.test.ts tests/conversationWeb.test.ts hub/web.test.ts hub/webActions.test.ts tests/web.test.ts && bun run typecheck`

Expected: exact workspace and compatibility behavior passes, `/api/status` contains aggregate only, all approval JSON is `no-store`, SSE is non-buffered/no-cache, and the legacy script remains valid.

- [ ] **Step 11: Commit the HTTP and compatibility boundary**

```bash
git add hub/webServer.ts tests/webServer.test.ts tests/conversationWeb.test.ts hub/web.ts hub/web.test.ts hub/webActions.ts hub/webActions.test.ts tests/web.test.ts tests/fixtures/workspaceE2eServer.ts hub/index.ts
git commit -m "feat(approvals): expose shared web and legacy APIs"
```

---

### Task 9: Browser Contracts, Routes, API Client, and Ordered Approval Stream

**Files:**

- Modify: `web/client/types.ts`
- Modify: `web/client/routes.ts`
- Modify: `web/client/routes.test.ts`
- Modify: `web/client/api.ts`
- Modify: `web/client/api.test.ts`
- Create: `web/client/approvalStream.ts`
- Create: `web/client/approvalStream.test.ts`
- Modify: `web/client/App.tsx`
- Modify: `web/client/App.test.tsx`
- Modify: `web/client/ConversationView.test.tsx`
- Modify: `web/client/components/AgentsWorkspace.test.tsx`
- Modify: `web/client/pwa.test.ts`

**Interfaces:**

- Produces: browser-owned approval/session types, `/approvals` routes, typed `WorkspaceApi` methods, payload-preserving safe errors, and `ApprovalStream`.
- Consumes: the exact JSON names fixed by Task 8; browser code does not import hub/server types.

- [ ] **Step 1: Write failing approval route tests**

Extend `web/client/routes.test.ts`:

```ts
test("parses and builds approval list and encoded detail routes", () => {
  expect(parseWorkspaceRoute("/approvals")).toEqual({ destination: "approvals", approvalId: null })
  expect(parseWorkspaceRoute("/approvals/review%2F7")).toEqual({ destination: "approvals", approvalId: "review/7" })
  expect(pathForApproval(null)).toBe("/approvals")
  expect(pathForApproval("review/7")).toBe("/approvals/review%2F7")
  expect(pathForApproval(null, { group: "pending", conversationId: "conversation/1" }))
    .toBe("/approvals?group=pending&conversationId=conversation%2F1")
})
```

Malformed encoding remains `not_found`. Query parameters are constructed from explicit fields only; arbitrary caller keys are never appended.

- [ ] **Step 2: Write failing typed API/error tests**

Extend `web/client/api.test.ts` to verify exact requests:

```ts
await api.listApprovals({ group: "history", search: "deploy", risk: "elevated", limit: 25, cursor: "next" })
await api.getApproval("approval/7")
await api.decideApproval("approval/7", "grant", "12", "idem-7")

expect(seen).toContain("GET /api/operations/approvals?group=history&search=deploy&risk=elevated&limit=25&cursor=next")
expect(seen).toContain("GET /api/operations/approvals/approval%2F7")
expect(lastRequest.headers.get("idempotency-key")).toBe("idem-7")
expect(await lastRequest.clone().json()).toEqual({ decision: "grant", expectedVersion: "12" })
```

Add a `409` JSON response test whose `ApiError.payload` retains the safe `{error,recovery,approval}` payload, and a rejected-fetch test that becomes `ApiError(0,"request_failed")` without preserving a raw network exception.

- [ ] **Step 3: Write failing ordered reconnect tests**

Create `web/client/approvalStream.test.ts` from the proven `agentStream.test.ts` contract. Test:

- Initial URL `/api/operations/approvals/events?after=0`.
- Monotonic cursor advancement and duplicate/lower-sequence suppression.
- `snapshot_required` invalidates and adopts the server reset sequence, including sequence `0` after restart.
- Malformed JSON does not move the cursor.
- Online retry delays `1000, 2000, 5000, 10000` and cap thereafter.
- Offline waits for the `online` event without accumulating timers/listeners.
- A stale source and callbacks after `stop()` do nothing.
- Exactly one source exists after each reconnect.

- [ ] **Step 4: Run focused tests and confirm missing types/routes/client**

Run: `bun test web/client/routes.test.ts web/client/api.test.ts web/client/approvalStream.test.ts`

Expected: FAIL because the approval route, API methods, types, and stream do not exist.

- [ ] **Step 5: Add browser-owned session and approval view types**

In `web/client/types.ts`, add:

```ts
export type WorkspaceRole = "hidden" | "viewer" | "operator"
export type ApprovalRisk = "low" | "elevated" | "destructive"
export type ApprovalState = "pending" | "granted" | "denied" | "expired" | "interrupted"
export type ApprovalExecution = "not_applicable" | "pending" | "succeeded" | "failed" | "interrupted"
export type ApprovalDecision = "grant" | "deny"
export type SafeValue = null | boolean | number | string | SafeValue[] | { [key: string]: SafeValue }

export interface Session {
  identity: string
  agents: SessionAgentSummary[]
  features: { agents: boolean; approvals: boolean }
  permissions: { agents: WorkspaceRole; approvals: WorkspaceRole }
  approvalState: { producing: boolean; canDecide: boolean; pendingCount: number }
}

export interface ApprovalPrincipal { surface: string; id: string }

export interface ApprovalSummary {
  id: string
  version: string
  kind: string
  target: string
  summary: string
  risk: ApprovalRisk
  requestedBy: ApprovalPrincipal
  createdAt: number
  expiresAt: number
  terminalAt: number | null
  state: ApprovalState
  execution: ApprovalExecution
  conversationId?: string
}

export interface ApprovalDetail extends ApprovalSummary {
  detail: SafeValue
  executionDetail: SafeValue | null
  decisionBy: ApprovalPrincipal | null
  decisionAt: number | null
  outcomeReason: string | null
  audit: Array<{ ts: number; actor: string; action: string; outcome: string }>
  permissions: { canDecide: boolean }
}

export interface ApprovalListQuery {
  group: "pending" | "history"
  search?: string
  risk?: ApprovalRisk
  kind?: string
  requester?: string
  state?: ApprovalState
  conversationId?: string
  createdFrom?: number
  createdTo?: number
  decisionFrom?: number
  decisionTo?: number
  cursor?: string
  limit?: number
}

export interface ApprovalPendingAggregate {
  count: number
  highestRisk: ApprovalRisk | null
  nearestExpiry: number | null
  firstId: string | null
}
export interface ApprovalListPage {
  items: ApprovalSummary[]
  nextCursor: string | null
  pendingCount: number
  querySummary: ApprovalPendingAggregate | null
}
export interface ApprovalDecisionResult { approval: ApprovalDetail }
```

Define `ApprovalOperationsEvent` with the same three event variants from Task 5. Update every existing `Session` test fixture in the files listed above to include approvals disabled/hidden and zero state unless the test explicitly enables them. Also update both production fallback session objects in `web/client/App.tsx` at this task: they must contain `features.approvals:false`, `permissions.approvals:"hidden"`, and zeroed `approvalState`, so Task 9's own typecheck does not depend on Task 10.

- [ ] **Step 6: Extend route parsing and path builders**

In `web/client/routes.ts`:

```ts
export type WorkspaceDestination = "conversations" | "agents" | "approvals"

export type WorkspaceRoute =
  | { destination: "conversations"; conversationId: string | null }
  | { destination: "agents"; agent: string | null }
  | { destination: "approvals"; approvalId: string | null }
  | { destination: "not_found" }
```

Parse `/approvals` and `/approvals/:id`. `pathForApproval` uses `URLSearchParams` and only accepts `group` and `conversationId`, adding them in that deterministic order.

- [ ] **Step 7: Implement typed API methods and safe error payloads**

Extend `ApiError`:

```ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly payload: unknown = null) {
    super(code)
    this.name = "ApiError"
  }
}
```

Add `listApprovals`, `getApproval`, and `decideApproval` to `WorkspaceApi`. Build list parameters from the explicit `ApprovalListQuery` fields. Wrap fetch rejection as `ApiError(0,"request_failed")`; for non-2xx JSON, pass the parsed safe JSON as `payload`. Keep invalid/missing success JSON as `invalid_response`.

- [ ] **Step 8: Implement `ApprovalStream` from the proven Agents contract**

Expose:

```ts
export interface ApprovalStreamHandlers {
  onEvent(event: ApprovalOperationsEvent): void
  onInvalidate(): void
  onState(state: ConnectionState): void
}

export class ApprovalStream {
  async start(afterSequence: number, handlers: ApprovalStreamHandlers): Promise<void>
  stop(): void
}
```

Copy the generation/source-attempt guards, online listener, retry backoff, cursor validation, and cleanup structure from `AgentStream`; change only event type and URL. Do not refactor the two streams together in this vertical.

- [ ] **Step 9: Run focused verification**

Run: `bun test web/client/routes.test.ts web/client/api.test.ts web/client/approvalStream.test.ts web/client/App.test.tsx web/client/ConversationView.test.tsx web/client/components/AgentsWorkspace.test.tsx web/client/pwa.test.ts && bun run typecheck`

Expected: browser/server names align, all existing session fixtures compile, API requests are exact, and stream recovery tests pass.

- [ ] **Step 10: Commit client contracts**

```bash
git add web/client/types.ts web/client/routes.ts web/client/routes.test.ts web/client/api.ts web/client/api.test.ts web/client/approvalStream.ts web/client/approvalStream.test.ts web/client/App.tsx web/client/App.test.tsx web/client/ConversationView.test.tsx web/client/components/AgentsWorkspace.test.tsx web/client/pwa.test.ts
git commit -m "feat(web): add approval client contracts and stream"
```

---

### Task 10: Responsive Read-Only Master-Detail Approval Queue

> Before this task's first edit, invoke `frontend-design:frontend-design` and use the approved master-detail visual direction. Record in commentary that the skill is influencing the UI work.

**Files:**

- Create: `web/client/components/ApprovalsWorkspace.tsx`
- Create: `web/client/components/ApprovalsWorkspace.test.tsx`
- Create: `web/client/components/ApprovalList.tsx`
- Create: `web/client/components/ApprovalDetail.tsx`
- Modify: `web/client/App.tsx`
- Modify: `web/client/App.test.tsx`
- Modify: `web/client/components/AppRail.tsx`
- Modify: `web/client/components/DestinationMobileNav.tsx`
- Modify: `web/client/components/AgentsWorkspace.tsx`
- Modify: `web/client/components/AgentsWorkspace.test.tsx`
- Modify: `web/client/styles.css`

**Interfaces:**

- Produces: first-class Approvals navigation, pending badge, searchable/filterable paginated master list, sanitized read-only detail, and desktop/tablet/mobile focus behavior.
- Consumes: `ApprovalsApi`, `Session`, route approval ID, app live revision/count/connection, and existing PWA install action.

- [ ] **Step 1: Write failing feature/navigation and read-only queue tests**

Create `web/client/components/ApprovalsWorkspace.test.tsx` with a typed fake API. Required cases:

```ts
test("viewer can search pending/history and inspect sanitized detail without controls", async () => {
  render(<ApprovalsWorkspace
    api={fakeApi()}
    session={session({ permissions: { agents: "hidden", approvals: "viewer" } })}
    routeApprovalId={null}
    connection="live"
    revision={0}
    pendingCount={2}
    onNavigate={() => {}}
    onNewConversation={() => {}}
  />)
  await userEvent.type(await screen.findByRole("searchbox", { name: "Search approvals" }), "deploy")
  expect(fakeApiCalls.list.at(-1)).toMatchObject({ group: "pending", search: "deploy" })
  await userEvent.click(screen.getByRole("tab", { name: "History" }))
  expect(fakeApiCalls.list.at(-1)).toMatchObject({ group: "history", search: "deploy" })
  expect(screen.queryByRole("button", { name: /approve|deny/i })).toBeNull()
})
```

Add list tests for risk/kind/requester/state plus creation/decision time filters, a conversation-filter chip, exact cursor `Load more`, stable dedupe when pages overlap, and query reset on group changes.

- [ ] **Step 2: Write failing responsive route/focus and state tests**

Cover:

- Desktop (`>=1200`) shows list and detail regions together.
- Tablet (`768..1199`) starts with a closed detail drawer; selection focuses its close/back button; Escape closes and restores the selected row.
- Mobile (`<768`) uses `/approvals/:id`, browser Back returns to list, and focus restores to the selected row.
- Loading, empty, forbidden, missing detail, core-production-disabled, offline, and unavailable states have explicit copy.
- A revision change reloads list and open detail without resetting active filters.
- Long summary, target, safe JSON, and principal values wrap without global horizontal overflow.

Extend `web/client/App.test.tsx` so disabled/hidden sessions omit rail/mobile navigation and direct `/approvals`/`/approvals/:id` routes render Not Found. A visible viewer route renders the workspace.

- [ ] **Step 3: Run tests and verify the missing destination**

Run: `bun test web/client/components/ApprovalsWorkspace.test.tsx web/client/App.test.tsx`

Expected: FAIL because the components/navigation do not exist.

- [ ] **Step 4: Define the destination API and state boundary**

In `ApprovalsWorkspace.tsx`:

```ts
export interface ApprovalsApi {
  listApprovals(query: ApprovalListQuery): Promise<ApprovalListPage>
  getApproval(approvalId: string): Promise<ApprovalDetail>
  decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    expectedVersion: string,
    idempotencyKey: string,
  ): Promise<ApprovalDecisionResult>
}
```

Use generation counters for list/detail requests, as `AgentsWorkspace` does. Keep `group`, search, filters, and conversation filter in URL query/local route state; keep the selected ID in the path. Fetch `limit:50`, append only on an explicit cursor load, and replace canonical rows by ID.

- [ ] **Step 5: Build semantic list and sanitized detail components**

`ApprovalList` uses a labelled search region, `tablist` for Pending/History, labelled native risk/kind/requester/state/date-time filter controls, and a real list of buttons/links with text risk/state labels. Pending rows show risk, requested action, and time to expiry; history rows show lifecycle and execution independently.

Use one workspace-level clock tick (no per-row timers) to refresh relative expiry text at a bounded cadence such as 30 seconds. Absolute timestamps remain available through `<time dateTime=...>`/accessible text, and announcements occur only on meaningful threshold/state changes rather than every tick.

`ApprovalDetail` renders:

- Summary, target, kind, requested principal, and text-labelled risk.
- Explicit safe structured detail without interpreting arbitrary HTML.
- Creation/expiry/terminal times.
- Decision actor/time/reason and execution outcome/detail.
- Authorized conversation link only when `conversationId` exists.
- Related safe audit activity.
- An explicit “Core approval production is off” notice when the workspace feature is visible but `session.approvalState.producing` is false.

At this task, action controls remain absent even for operators; Task 11 adds them.

- [ ] **Step 6: Add routing, rail badge, and mobile destination navigation**

Extend `AppApi` with optional approval methods and create an `approvalsApi` only when all exist. Extend navigation unions to `WorkspaceDestination`. `App` loads session for Agents or Approvals routes, hides direct routes when feature/role is unavailable, and renders `ApprovalsWorkspace` otherwise.

Extend `AppRail` and `DestinationMobileNav` props:

```ts
active: "conversations" | "agents" | "approvals"
features: { agents: boolean; approvals: boolean }
pendingApprovals: number
onNavigate(destination: WorkspaceDestination): void
```

The Approvals link displays a visible count and an accessible label such as `Approvals, 3 pending`. Zero has no decorative badge but retains the plain destination name. Mobile destination layout supports one, two, or three available destinations without fixed empty columns.

Update `AgentsWorkspace` in the same task because it directly renders both navigation components: widen its `onNavigate` destination to `WorkspaceDestination`, accept/pass `pendingApprovals`, and cover navigation/count propagation in `AgentsWorkspace.test.tsx`. Do not leave Task 10's typecheck dependent on a later task.

- [ ] **Step 7: Implement responsive geometry and accessible focus behavior**

Reuse the established breakpoints: mobile `<768`, tablet `768..1199`, desktop `>=1200`. Use a desktop master-detail grid, an inert/hidden tablet drawer when closed, and separate mobile list/detail routes. Add minimum 44px touch targets, wrapping/min-width guards, reduced-motion rules, dialog/drawer focus entry/return, and no `overflow-x` on the viewport.

- [ ] **Step 8: Run focused visual/build verification**

Run: `bun test web/client/components/ApprovalsWorkspace.test.tsx web/client/App.test.tsx && bun run typecheck && bun run build:web`

Expected: all responsive/state tests pass, TypeScript succeeds, and the production bundle builds.

- [ ] **Step 9: Commit the read-only destination**

```bash
git add web/client/components/ApprovalsWorkspace.tsx web/client/components/ApprovalsWorkspace.test.tsx web/client/components/ApprovalList.tsx web/client/components/ApprovalDetail.tsx web/client/App.tsx web/client/App.test.tsx web/client/components/AppRail.tsx web/client/components/DestinationMobileNav.tsx web/client/components/AgentsWorkspace.tsx web/client/components/AgentsWorkspace.test.tsx web/client/styles.css
git commit -m "feat(web): add responsive approval queue"
```

---

### Task 11: Tiered Decisions and Canonical Conflict Reconciliation

**Files:**

- Create: `web/client/components/ApprovalDecisionDialog.tsx`
- Create: `web/client/components/ApprovalDecisionDialog.test.tsx`
- Modify: `web/client/components/ApprovalDetail.tsx`
- Modify: `web/client/components/ApprovalsWorkspace.tsx`
- Modify: `web/client/components/ApprovalsWorkspace.test.tsx`
- Modify: `web/client/styles.css`

**Interfaces:**

- Produces: risk-tiered grant/deny confirmation, one idempotency key per attempt, canonical reload/reconciliation, and truthful decision/execution result presentation.
- Consumes: sanitized `ApprovalDetail`, independent session `canDecide`, connection state, `ApprovalsApi.decideApproval`, and `useModalDialog`.

- [ ] **Step 1: Write failing safeguard-language and permission tests**

Create `ApprovalDecisionDialog.test.tsx`. Define local typed `approval`, `renderDialog`, and `renderWorkspace` fixtures in that file; `renderDialog` returns a `rerenderApproval(nextApproval, decision)` helper so the example is executable rather than relying on an undefined JSX builder:

```ts
test("every grant confirms the exact effect and destructive grant strengthens copy", async () => {
  const view = renderDialog(approval({ risk: "elevated" }), "grant")
  expect(screen.getByRole("dialog")).toHaveTextContent("deploy")
  expect(screen.getByRole("dialog")).toHaveTextContent("hooks.example.com")
  view.rerenderApproval(approval({ risk: "destructive" }), "grant")
  expect(screen.getByRole("dialog")).toHaveTextContent(/destructive|irreversible/i)
})

test("low-risk denial is direct while elevated and destructive denial confirm", async () => {
  const direct = renderWorkspace({ approval: approval({ risk: "low" }) })
  await userEvent.click(screen.getByRole("button", { name: "Deny" }))
  expect(direct.api.decisions).toHaveLength(1)
  direct.unmount()
  renderWorkspace({ approval: approval({ risk: "elevated" }) })
  await userEvent.click(screen.getByRole("button", { name: "Deny" }))
  expect(screen.getByRole("dialog")).toBeTruthy()
})
```

Add tests that viewers and approver-excluded operators see no controls, and that offline/in-flight controls are disabled with text/status explanation.

- [ ] **Step 2: Write failing idempotency, conflict, and execution-outcome tests**

Cover:

- Double-click/submission invokes one request.
- One `crypto.randomUUID()` is generated per new decision attempt.
- An ambiguous `request_failed` keeps the key, forces canonical detail reload, and permits reuse only if the same version is still pending.
- `409` stale/expired/interrupted/other-winner responses reload canonical detail and clear the attempt; they never auto-submit.
- A canonical `200` with `state=granted, execution=failed` says approval succeeded but delivery failed.
- `granted + execution=interrupted` says “execution outcome unknown” and offers no retry.
- `denied`, `expired`, and lifecycle `interrupted` say the held effect was discarded without running.
- SSE/revision resolution while a dialog is open closes or converts it to canonical terminal detail and restores focus safely.

- [ ] **Step 3: Run focused tests and verify missing protected controls**

Run: `bun test web/client/components/ApprovalDecisionDialog.test.tsx web/client/components/ApprovalsWorkspace.test.tsx`

Expected: FAIL until the dialog and decision state machine exist.

- [ ] **Step 4: Implement the modal with the existing focus-trap hook**

Use `useModalDialog` so Tab/Shift+Tab are trapped, Escape/cancel restores the invoker, and pending submission refuses dismissal. Render summary, target, risk, hostname/method/fingerprints from safe detail, and explicit irreversible copy. Never render safe strings via `dangerouslySetInnerHTML`.

- [ ] **Step 5: Implement one attempt/key state machine**

In `ApprovalsWorkspace`, hold:

```ts
interface DecisionAttempt {
  approvalId: string
  decision: ApprovalDecision
  expectedVersion: string
  idempotencyKey: string
  ambiguous: boolean
}
```

Create it immediately before the first network call. Reuse only when all bound fields still match and the prior result was ambiguous. Clear it after a canonical success, a canonical conflict/reload, or a changed version. Low-risk denial calls the same submit function without opening the modal.

- [ ] **Step 6: Reconcile all outcomes from canonical detail**

On success, replace list/detail with `result.approval`. On `ApiError` `409`, use an authorized canonical approval in `payload` only as an immediate display hint, then call `getApproval` before enabling controls. On network ambiguity, call `getApproval`; if reload fails, keep actions disabled and present “Reload approval before retrying.” Never infer success/failure from the network exception.

Decision start/completion, expiry, concurrent resolution, and execution success/failure/unknown changes must update a polite status live region. Do not rely on button color or toast disappearance to communicate the outcome.

- [ ] **Step 7: Run focused verification**

Run: `bun test web/client/components/ApprovalDecisionDialog.test.tsx web/client/components/ApprovalsWorkspace.test.tsx && bun run typecheck && bun run build:web`

Expected: tiered controls, idempotency, focus behavior, conflict reload, and truthful execution language all pass.

- [ ] **Step 8: Commit protected decisions**

```bash
git add web/client/components/ApprovalDecisionDialog.tsx web/client/components/ApprovalDecisionDialog.test.tsx web/client/components/ApprovalDetail.tsx web/client/components/ApprovalsWorkspace.tsx web/client/components/ApprovalsWorkspace.test.tsx web/client/styles.css
git commit -m "feat(web): add protected approval decisions"
```

---

### Task 12: Application-Owned Live State and Conversation Context Banner

**Files:**

- Create: `web/client/components/ApprovalContextBanner.tsx`
- Create: `web/client/components/ApprovalContextBanner.test.tsx`
- Modify: `web/client/App.tsx`
- Modify: `web/client/App.test.tsx`
- Modify: `web/client/ConversationView.test.tsx`
- Modify: `web/client/styles.css`

**Interfaces:**

- Produces: one stable cross-destination approval stream, live rail count/revision invalidation, authorized conversation banner, and return-route/focus restoration.
- Consumes: `ApprovalStream`, session state, filtered approval list API, selected conversation, and browser history.

- [ ] **Step 1: Write failing single-stream lifecycle tests**

Extend `web/client/App.test.tsx` with locally defined typed `countedApprovalStreams`, `approvalApi`, and `navigateThrough` helpers. `navigateThrough` drives real links/history events and awaits each destination before continuing:

```ts
test("one approval stream survives internal destination navigation", async () => {
  const streams = countedApprovalStreams()
  render(<App api={approvalApi()} approvalStreamFactory={streams.factory} />)
  await screen.findByRole("link", { name: /Approvals/ })
  expect(streams.starts).toBe(1)
  await navigateThrough("approval-detail", "agents", "conversation", "approval-list")
  expect(streams.starts).toBe(1)
  expect(streams.stops).toBe(0)
  cleanup()
  expect(streams.stops).toBe(1)
})
```

Add tests that `approval_changed` updates the visible rail count and revision, `snapshot_required` reloads session plus canonical queries, and hiding the feature/unmounting stops the source. Add an App-owned polite live-region assertion for global pending-count changes (for example, “3 approvals pending”); a changed navigation label alone is not a screen-reader announcement. No destination component may call `new ApprovalStream()`.

- [ ] **Step 2: Write failing context-banner projection tests**

Create `ApprovalContextBanner.test.tsx`:

- One exact query aggregate with count one shows highest risk text, nearest expiry, and direct `/approvals/:id` navigation.
- Multiple requests link to `/approvals?group=pending&conversationId=...`.
- An aggregate representing more than 100 mixed-risk requests uses the server-provided full count, destructive > elevated > low, and global nearest expiry rather than deriving from the first page.
- Empty/unavailable data renders no banner.
- State/risk use text and icon, not color alone.
- Updates announce count/expiry changes through a polite live region without repeatedly stealing focus.

Extend `ConversationView.test.tsx` to assert the banner is between transcript header and body and that `canonicalMessages` plus transcript message ordering/count are unchanged.

- [ ] **Step 3: Write failing browser-return focus tests**

From a conversation banner, navigate to an approval detail, then dispatch browser Back. Assert the original conversation path is restored and the banner link receives focus when it still exists. Multiple-request navigation must restore focus to the queue trigger. If the request resolved and the banner disappeared, focus the transcript heading rather than a detached element.

- [ ] **Step 4: Run focused tests and confirm missing live/banner behavior**

Run: `bun test web/client/components/ApprovalContextBanner.test.tsx web/client/App.test.tsx web/client/ConversationView.test.tsx`

Expected: FAIL until stream ownership and banner composition are implemented.

- [ ] **Step 5: Own approval live state in `App`**

Add to `AppProps`:

```ts
approvalStreamFactory?: (() => ApprovalStream) | null
```

Maintain one state object:

```ts
interface ApprovalLiveState {
  connection: ConnectionState
  pendingCount: number
  revision: number
}
```

Start the stream in an effect whose dependencies are feature visibility and the stable factory—not the current route. For each valid event, update `pendingCount` and increment `revision`; on invalidation, increment revision and reload `/api/session` to reset the count. Pass live values to Approvals, rail/mobile navigation, and Conversations. Track the previous global count and update one visually hidden `aria-live="polite"` status only when the count meaningfully changes; do not announce on every render or reconnect.

- [ ] **Step 6: Load only authorized conversation-filtered approvals**

When a selected conversation exists and approvals are visible, the exported `ConversationWorkspace` function already located in `web/client/App.tsx` calls:

```ts
api.listApprovals!({ group: "pending", conversationId: selected.id, limit: 1 })
```

Use the response's exact `querySummary` for count/highest-risk/nearest-expiry/first-ID and never derive banner facts from `items.length` or the global count. Reload when selected ID or live revision changes. Use a generation guard so a late response from the prior conversation cannot show a banner. A `403`, `404`, offline error, zero aggregate, or missing aggregate yields no banner and no leaked ID.

- [ ] **Step 7: Render the non-canonical banner and return state**

Pass the exact aggregate into the exported `ConversationView` function in `web/client/App.tsx` and render `ApprovalContextBanner` after `.transcript-header` and before `.transcript-body`. There is no separate `ConversationView.tsx` production file in this repository; both `ConversationWorkspace` and `ConversationView` are deliberately edited through Task 12's listed `App.tsx`. Update transcript grid rows to:

```css
grid-template-rows: auto auto minmax(0, 1fr) auto;
```

Intercept banner navigation through `App`, record the source conversation and focus intent in application/history state, and push the canonical approval route. On `popstate`, restore the conversation and request banner focus; if absent, focus the transcript heading. Do not append a `Message`, `ConversationEvent`, activity row, or draft.

- [ ] **Step 8: Run focused verification**

Run: `bun test web/client/components/ApprovalContextBanner.test.tsx web/client/App.test.tsx web/client/ConversationView.test.tsx web/client/approvalStream.test.ts && bun run typecheck && bun run build:web`

Expected: exactly one stream stays active, badges/banners recover from invalidation, transcript ordering is unchanged, and browser/focus return works.

- [ ] **Step 9: Commit live context integration**

```bash
git add web/client/components/ApprovalContextBanner.tsx web/client/components/ApprovalContextBanner.test.tsx web/client/App.tsx web/client/App.test.tsx web/client/ConversationView.test.tsx web/client/styles.css
git commit -m "feat(web): add live approval context banners"
```

---

### Task 13: Deterministic End-to-End, PWA, and Operational Documentation

**Files:**

- Modify: `tests/fixtures/workspaceE2eServer.ts`
- Create: `tests/e2e/approvals.spec.ts`
- Modify: `tests/e2e/pwa.spec.ts`
- Modify: `README.md`
- Modify: `docs/web-dashboard.md`

**Interfaces:**

- Produces: a real file-backed deterministic approval fixture, desktop/tablet/mobile browser coverage, offline-cache regression coverage, and rollout/rollback/operator documentation.
- Consumes: the real SQLite repository/service/held registry/policies/events and the production web handler/assets.

- [ ] **Step 1: Extend the fixture with a real approval runtime**

Replace the fixture's `:memory:` database with a temporary SQLite file. Keep the conversation connection open and maintain a separate mutable approval `Database` connection to that same file, so an approval restart can close/reopen a real handle without invalidating the conversation fixture. Construct a real `SqliteApprovalHistoryRepository`, `HeldApprovalRegistry`, `ApprovalPolicyRegistry`, `ApprovalEventStream`, and `ApprovalOperationsService`. Enable:

```ts
workspace: {
  features: { agents: true, approvals: true },
  operators: [IDENTITY, OTHER_OPERATOR],
},
approvals: {
  enabled: true,
  webApprovers: [IDENTITY, OTHER_OPERATOR],
  ttlMs: 60_000,
},
```

Register the production outbound policy and an explicitly test-only fixture policy capable of `low`, `elevated`, and `destructive` classifications. The test policy still returns explicit safe fields and never accepts arbitrary browser-defined kinds.

Keep the current approval database, repository, held registry, event stream, and service in mutable variables, and make `WebDeps.approvalOperations` delegate method calls to the current service so fixture restart can replace them without restarting Playwright's HTTP process. The workspace config object is mutable only through the bounded test endpoint below. Fixture shutdown closes both database handles and removes the temporary directory.

- [ ] **Step 2: Add deterministic test-only control endpoints and droppable SSE**

Under the existing `NODE_ENV === "test"` guard, add:

```text
POST /__e2e/approvals/create
POST /__e2e/approvals/resolve-as-other
POST /__e2e/approvals/expire
POST /__e2e/approvals/restart
POST /__e2e/approvals/workspace-feature
POST /__e2e/approvals/wait-effect-start
POST /__e2e/approvals/release-effect
POST /__e2e/approvals/drop-stream
GET  /__e2e/approvals/state
```

`create` accepts only a bounded fixture enum, an optional known seeded conversation ID, and a deterministic execution mode (`success`, `failure`, or one named deferred fixture); it calls the real service with a memory-only closure and increments `effectCallsByApproval[approvalId]` only when that approval's closure is invoked. Never assert a process-global cumulative counter, because one fixture serves sequential desktop/tablet/mobile projects. The deferred fixture owns explicit started and release promises. `resolve-as-other` starts the real service decision without awaiting final execution, stores/catches that promise, and for deferred mode waits only until the closure-start barrier is reached. `wait-effect-start` and `release-effect` operate only on that one named deferred fixture and are idempotent. `expire` advances the injected clock and calls `expireDue`.

`workspace-feature` accepts exactly `{enabled:boolean}` and mutates only `workspace.features.approvals`, leaving core approvals enabled for the `/legacy` rollback test. `restart` first drops every active approval SSE connection, discards the old held registry, closes the mutable approval database handle, reopens a new `Database` against the same temporary file, and constructs fresh repository/service/event/held instances. It calls reconciliation before making the new delegate visible and never resolves/replays the old closure. Release of an old in-flight deferred closure after restart may only produce a caught stale-finalization failure; it cannot change the reconciled `granted + interrupted` row. `state` returns test-only IDs/counts/outcomes plus bounded per-approval effect counts, not secrets.

Add `activeApprovalSseDrops` and a wrapper equivalent to the existing Agents droppable stream. Route `/api/operations/approvals/events` through it, close all drops before swapping streams during `restart`, and close them again during fixture shutdown. The reconnect must hit the new sequence space and receive cursor-ahead reset/snapshot invalidation rather than remain subscribed to the orphaned old stream.

- [ ] **Step 3: Write the main cross-viewport approval flow**

Create `tests/e2e/approvals.spec.ts`. Run the main test in every configured project:

1. Create a real elevated outbound approval with verified `designReview.id` provenance.
2. Observe the rail badge and banner above that conversation transcript.
3. Open the canonical queue/detail; assert desktop master-detail, tablet drawer, or mobile detail route behavior.
4. Verify text-labelled risk/state and no viewport horizontal overflow.
5. Confirm grant; wait for `granted + succeeded`; assert `effectCallsByApproval[createdApprovalId]` is exactly one, independent of prior projects/tests.
6. Create and confirm an elevated denial; assert `effectCallsByApproval[deniedApprovalId]` is zero.
7. Create another request, resolve it as the other operator, and observe canonical terminal UI through SSE.
8. Drop approval SSE, publish a change, and verify reconnect/snapshot reload restores badge/list/detail.
9. Run Axe and fail on serious/critical violations.
10. Visit `/legacy` and verify the compatibility Approvals section still loads.

Use role/label locators, not CSS implementation selectors, except for explicit geometry/overflow assertions.

Install a Playwright `afterEach` for this spec that best-effort releases any named deferred effect and restores `workspace.features.approvals=true`. Tests that toggle the flag also use `try/finally` around their assertions. Each test records created approval IDs and asserts per-approval counts or before/after deltas only; it never assumes a fresh process-global counter or empty durable history.

- [ ] **Step 4: Add focused desktop lifecycle cases**

Add desktop-only tests for:

- Direct low-risk denial versus confirmed elevated/destructive denial.
- Destructive grant copy.
- Expiry racing an open decision and canonical `expired` reconciliation.
- Pending restart interruption shown as fail-closed/discarded.
- A grant whose deferred closure has crossed the explicit start barrier but remains unreleased during a real approval-connection restart, shown as `granted + execution interrupted`, “outcome unknown,” with no retry; releasing the old closure afterward does not alter that row.
- A definitive outbound failure shown as a successful grant plus failed execution.
- Sanitized searchable history after closing and reopening the file-backed approval database connection.
- Workspace flag disabled through the bounded feature endpoint while core remains enabled and authenticated `/legacy` list/decision remains functional.

- [ ] **Step 5: Add the PWA no-operational-cache regression**

Extend `tests/e2e/pwa.spec.ts`:

1. Create and open `/approvals/:id` while online.
2. Confirm the service worker controls the page and the shell route has been warmed.
3. Go offline and reload the deep route.
4. Assert the application shell/offline-unavailable state renders.
5. Assert no approval summary, ID, target, detail, decision controls, or prior API JSON appears from cache.
6. Assert a safe route back to conversations remains available.
7. Inspect Cache Storage and prove no `/api/operations/approvals` response is present.

Do not modify the service worker caching strategy: `web/client/public/sw.template.js` already excludes all `/api/**` and SSE requests.

- [ ] **Step 6: Run focused browser verification**

Run: `bun run build:web && bunx playwright test tests/e2e/approvals.spec.ts tests/e2e/pwa.spec.ts --workers=1`

Expected: desktop, tablet, and mobile approval flows pass; supplemental lifecycle/PWA cases pass or use explicit project guards; no serious/critical Axe findings or overflow failures.

- [ ] **Step 7: Update operator and architecture documentation**

Update `docs/web-dashboard.md` with:

- `/approvals` and `/approvals/:id` routes and responsive behavior.
- Independent `workspace.features.approvals` and `approvals.enabled` meanings.
- Viewer/operator/`canDecide` behavior and exact/`"*"` `webApprovers` policy.
- Trusted-header boundary and the requirement for the upstream proxy to strip caller-supplied identity headers.
- Global sanitized shells versus separately authorized conversation context.
- Durable sanitized history versus memory-only executable effects.
- Denied, expired, lifecycle interrupted, granted success/failure, and granted unknown-execution meanings.
- Discord and authenticated `/legacy` compatibility, Discord-disabled operation, and rollback by disabling only the workspace feature.

Update `README.md` configuration/reference sections to include `webApprovers`, SQLite history, shared service, API routes, and the new workspace destination. Replace old claims that the `ApprovalRegistry` owns history or that all restart cases simply mean “unfired.” Remove “Approvals remain pending” wording from the Phase 4 status paragraph while leaving Operations, Settings, and Phase 4B pending.

Do not mark the roadmap checkbox yet; that happens only after Task 14's complete gate.

- [ ] **Step 8: Run documentation and focused regression checks**

Run:

```bash
bun test tests/approval.test.ts tests/webServer.test.ts web/client/components/ApprovalsWorkspace.test.tsx web/client/components/ApprovalDecisionDialog.test.tsx web/client/components/ApprovalContextBanner.test.tsx
bun run typecheck
bun run build:web
git diff --check
```

Expected: all focused tests/build checks pass and documentation has no whitespace errors.

- [ ] **Step 9: Commit E2E coverage and documentation**

```bash
git add tests/fixtures/workspaceE2eServer.ts tests/e2e/approvals.spec.ts tests/e2e/pwa.spec.ts README.md docs/web-dashboard.md
git commit -m "test(approvals): cover responsive durable lifecycle"
```

---

### Task 14: Independent Review, Full Phase Gate, and Roadmap Completion

**Files:**

- Modify after all gates pass: `docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md`

**Interfaces:**

- Produces: reviewed, fully verified Approvals vertical and the single accurate roadmap completion mark.
- Consumes: every implementation and test from Tasks 1–13.

- [ ] **Step 1: Run structural replacement and secret-surface checks**

Run:

```bash
git status --short
rg -n "ApprovalRegistry|pendingApprovalList|resolveApproval:" hub web tests
rg -n "effectFingerprint|decisionKey|approval_notifications" web/client hub/webServer.ts hub/web.ts
git diff --check
```

Expected:

- No production reference to the obsolete lifecycle registry, broad approval list, or duplicate web resolver.
- Browser/API projection code does not expose `effectFingerprint`, `decisionKey`, or notification references.
- Any matches in tests are explicit absence/regression assertions.
- Only scoped task files plus the three pre-existing user-owned untracked directories appear in status.

- [ ] **Step 2: Request independent code review before final verification**

Invoke `superpowers:requesting-code-review`. Ask at least one independent reviewer to compare the implementation against `docs/superpowers/specs/2026-07-14-phase4a-approvals-workspace-design.md`, focusing on:

- SQLite CAS/idempotency/reconciliation correctness.
- Secret/body/header/error redaction.
- Core/workspace flag and role/approver authorization independence.
- Discord generic-gate bypass without weakening other interactions.
- Startup ordering before agent/webhook/cron producers.
- Single-stream React lifecycle, conflict reconciliation, responsive focus, banner non-canonicity, and PWA cache safety.

If review reports findings, invoke `superpowers:receiving-code-review`, reproduce each claim with a focused test, fix valid findings task-by-task, commit them, and repeat focused verification. Do not accept a finding merely by assertion and do not skip a valid issue because the full suite was previously green.

- [ ] **Step 3: Run the complete fresh verification gate**

Invoke `superpowers:verification-before-completion`, then run in this order:

```bash
bun test
bun run typecheck
bun run build:web
bunx playwright test --workers=1
git diff --check
```

Expected: zero Bun test failures, successful TypeScript and production build, every non-intentionally-skipped desktop/tablet/mobile Playwright test passes, Axe/overflow/PWA checks pass, and diff check is clean.

Also manually confirm from the test output that legacy, Discord-optional, gateway, outbound delivery, Phase 2 composition, Agents, conversations, and PWA regressions ran; do not infer those gates from only the new approval tests.

- [ ] **Step 4: Mark only Approvals complete after the gate is green**

Change exactly:

```md
- [ ] Approvals workspace destination
```

to:

```md
- [x] Approvals workspace destination
```

Leave Operations, Settings, Phase 4B, soak, and `/legacy` redirect unchecked.

- [ ] **Step 5: Verify and commit roadmap completion**

Run:

```bash
git diff --check
git diff -- docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md
git status --short
```

Expected: the roadmap diff contains only the Approvals checkbox, and no user-owned scratch directory is staged.

```bash
git add docs/superpowers/plans/2026-07-12-standalone-web-client-roadmap.md
git commit -m "docs(phase4): complete approvals workspace"
```

- [ ] **Step 6: Record the final handoff evidence**

Report the final commit IDs, exact verification commands/results, any intentional Playwright skips, workspace status, and the fact that `/legacy`, Discord, and Discord-disabled paths remain covered. Do not claim Phase 4 overall completion; Approvals is the second completed Phase 4 destination and Operations is next.

---

## Implementation Coverage Matrix

| Design requirement | Primary tasks |
|---|---|
| Independent core/workspace flags and web approver policy | 1, 5, 8 |
| Safe generic model, outbound sanitization, process-keyed fingerprints | 2 |
| Additive SQLite history, invisible registration, strict decode | 3 |
| Versioned CAS, idempotency, expiry race, restart interruption | 4 |
| Shared lifecycle, authorization, audit, notifications, events | 5 |
| Discord versioning, authorization audit path, card updates | 6 |
| Awaited outbound execution, trusted provenance, startup order, web-only mode | 7 |
| Operations API/SSE, session, authenticated `/legacy`, aggregate-only status | 8 |
| Typed browser contract and reconnect recovery | 9 |
| Responsive master-detail queue, filters, pagination, accessible navigation | 10 |
| Tiered decisions, canonical conflicts, truthful execution outcomes | 11 |
| One live stream and non-canonical conversation banner | 12 |
| Desktop/tablet/mobile/PWA/legacy deterministic validation and docs | 13 |
| Independent review, full regressions, roadmap gate | 14 |
