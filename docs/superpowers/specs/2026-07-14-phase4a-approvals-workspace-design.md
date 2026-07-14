# Phase 4A Approvals Workspace Design

**Date:** 2026-07-14

**Status:** Approved in conversation; pending written-spec review

## Objective

Add Approvals as the second Phase 4A workspace destination. The destination provides a global actionable queue, searchable terminal history, exact held-effect context, conversation links, and safe decisions without depending on Discord.

Discord cards, `/legacy`, the React workspace, and future adapters must call the same authorization, application, persistence, notification, event, and audit boundaries. Existing pending effects remain memory-only and fail closed across a hub restart.

## Confirmed Product Decisions

- The application service is generic even though outbound webhooks are initially the only approval producer.
- Sanitized approval records and terminal history persist in SQLite.
- Executable closures are never persisted.
- Workspace viewers and operators may inspect every globally sanitized approval record. Originating-conversation content and links still require conversation access.
- Web decisions require a workspace operator and, when configured, a matching web approver identity.
- The primary workspace uses a responsive master-detail queue.
- Originating conversations show a live context banner above the transcript. The banner is not a canonical message.
- `/legacy` and existing Discord approval cards remain available throughout rollout.

## Scope

This vertical includes:

- A transport-neutral approval operations service.
- A sanitized SQLite approval-history repository.
- A memory-only held-effect registry.
- Ordered approval events and reconnect recovery.
- Typed list, detail, decision, and SSE APIs.
- A responsive Approvals destination and application-rail badge.
- Originating-conversation approval banners.
- Shared Discord, legacy-web, and workspace decision handling.
- Authorization, redaction, audit, accessibility, and end-to-end coverage.

This vertical does not add new approval-producing effect classes. Existing gated outbound routes are the first producer of the generic contract.

## Architecture

`ApprovalOperationsService` is the only boundary for requesting, viewing, deciding, expiring, interrupting, and reporting execution outcomes for approvals.

```text
Outbound approval producer
Discord buttons | /legacy | React workspace | future adapters
                         |
                ApprovalOperationsService
         /             |             |             \
Authorization   SQLite history   Held effects   Event stream
and redaction   and CAS updates   in memory      and audit
                         |
              ApprovalNotificationPort
                         |
                 Discord card adapter
```

HTTP routes remain thin adapters. Discord-specific code may render or update cards through a notification port, but it does not resolve the registry directly. Browser code never calls Discord-specific code.

Two independent flags retain their existing meanings:

- `approvals.enabled` controls approval production, held-effect lifecycle, Discord notifications, and shared resolution behavior.
- `workspace.features.approvals` controls only the React destination, workspace session capability, operations API/SSE exposure, application-rail badge, and conversation banner.

Disabling the workspace flag never disables Discord or `/legacy`. When the workspace flag is enabled while the core approval subsystem is disabled, the destination remains available for authorized durable history but clearly reports that new approval production and decisions are disabled.

### Focused units

The vertical is split into units with explicit responsibilities:

- `ApprovalOperationsService`: lifecycle orchestration, authorization, concurrency, idempotency, and canonical results.
- `ApprovalHistoryRepository`: SQLite registration, activation, filtering, pagination, compare-and-swap decisions, execution outcomes, startup reconciliation, idempotency records, and notification references.
- `HeldApprovalRegistry`: memory-only closures keyed by approval ID. It never authorizes, persists, or audits.
- `ApprovalPolicy`: role checks, surface approver checks, kind-specific sanitization, and risk classification.
- `ApprovalEventStream`: ordered events, bounded replay, gap invalidation, and restart-cursor reset.
- `ApprovalNotificationPort`: optional post/update integration for Discord and future adapters.

Each unit can be tested without starting Discord, a real agent process, or the production web server.

## Canonical Approval Model

### Request descriptor

An approval producer submits a structured descriptor and a memory-only closure:

```ts
interface ApprovalRequestDescriptor {
  kind: string
  target: string
  requestedBy: ApprovalPrincipal
  origin?: {
    conversationId?: string
    surface?: string
    externalLocation?: string
  }
  summary: string
  detail: unknown
}

interface ApprovalExecutionResult {
  outcome: "succeeded" | "failed"
  detail?: unknown
}

type ApprovalFire = (correlationId: string) => Promise<ApprovalExecutionResult>
```

The service does not accept arbitrary producer detail for browser storage. Each registered approval kind supplies request, view, and execution-result sanitizers plus a classifier. Unknown kinds fail closed unless they have an explicit policy registration. Unknown risk defaults are never treated as low risk.

The initial outbound sanitizer retains only safe route identity and effect metadata. It never stores URLs containing credentials, request headers, secret values, raw message bodies, or executable closures.

### Initial outbound projection

The initial outbound policy always classifies a gated route as `elevated`. No producer-supplied field can lower that risk. Test fixtures may register additional policies to exercise destructive confirmation, but adding a production risk configuration is outside this vertical.

The exact-effect record contains only:

- Route ID.
- Uppercase HTTP method.
- Destination hostname with user information, path, query, and fragment removed.
- Payload byte count.
- An opaque payload fingerprint computed with an in-process random HMAC key that is never persisted.
- A route-configuration version fingerprint HMAC-bound with the same in-process key.
- An opaque combined effect fingerprint, also HMAC-bound to the exact route snapshot and body, stored on both the record and held registry entry.

Two payloads to the same route therefore produce distinguishable confirmation fingerprints without exposing a brute-forceable raw body hash. Decision handling verifies that the registry fingerprint matches the persisted record before invoking the closure. A restart loses the HMAC key and held closure, so reconciliation interrupts the record instead of attempting verification or replay.

The producer captures an immutable route snapshot and exact body in the memory-only closure. Later configuration changes do not alter that held effect.

The outbound producer must refactor the current fire-and-forget delivery wrapper to return and await `OutboundDelivery.deliver`. Its approval closure resolves only after bounded retries produce a definitive delivery result. The service must not mark execution succeeded merely because delivery was scheduled.

Before persistence, API projection, notification, or audit, the outbound execution-result sanitizer retains only integer HTTP status when present, bounded non-negative attempt count, and a bounded enumerated failure code. Raw response bodies, exception messages, headers, destinations, and producer-defined keys are dropped. A thrown or rejected closure becomes `failed` with the safe code `effect_rejected`.

### Origin provenance

Approval producers do not supply trusted conversation IDs from request bodies or agent-controlled arguments. Hub composition derives origin from the current server-side turn context or resolves a transport location through the canonical conversation-link repository.

An outbound request records `conversationId` only when that provenance is verified. Text-triggered replies use their canonical turn context when available; legacy chat locations are resolved server-side. Tool-triggered and hub-event routes with no verified canonical origin omit the conversation ID. The conversation banner is guaranteed only for records with verified provenance.

### Persisted record

SQLite stores a canonical sanitized record with:

- A cryptographically random UUID approval ID protected by a unique constraint and collision retry.
- A monotonically changing resource version.
- Kind, target, summary, and sanitized structured detail.
- Requesting principal and optional authorized conversation reference.
- Server-classified `low`, `elevated`, or `destructive` risk.
- Creation and expiry timestamps.
- Lifecycle state.
- Decision principal, decision time, idempotency key, and outcome reason.
- Execution outcome and timestamps.
- Approval correlation ID and safe audit references.

The lifecycle state is one of:

- `pending`
- `granted`
- `denied`
- `expired`
- `interrupted`

SQLite also uses an internal `registering` state that is never returned by list, detail, count, search, banner, or event APIs. It exists only to make activation of a SQLite record and memory-only closure atomic from every reader's perspective.

Execution outcome is tracked separately:

- `not_applicable`
- `pending`
- `succeeded`
- `failed`
- `interrupted`

This distinction lets the UI say that an operator granted a request while the effect itself later failed or was interrupted.

Valid public lifecycle/execution pairs are:

| Lifecycle | Allowed execution outcome | Meaning |
|---|---|---|
| `pending` | `not_applicable` | Awaiting a decision; the held closure is present. |
| `denied` | `not_applicable` | The held closure was discarded and never invoked. |
| `expired` | `not_applicable` | The held closure was discarded after its deadline and never invoked. |
| `interrupted` | `not_applicable` | Registration or a pending request was discarded fail-closed. |
| `granted` | `pending`, `succeeded`, `failed`, `interrupted` | The decision won; execution is running, known, failed, or unknown after interruption. |

`granted` plus execution `interrupted` means the effect may or may not have occurred before completion was recorded. It is non-replayable and must be described as **execution outcome unknown**, never as safely discarded. Only a lifecycle-interrupted registration or pending request may use fail-closed discarded language.

### SQLite tables

The existing Switchboard SQLite database receives additive migrations for:

- `approval_records`: canonical sanitized lifecycle and execution state.
- `approval_idempotency`: principal-scoped decision keys, bound request hashes, and canonical results.
- `approval_notifications`: server-only adapter/message references needed to update existing cards.

History queries use the sort-specific composite keyset cursors defined by each endpoint. Structured JSON fields are decoded through strict runtime validation. Unknown persisted keys are never spread into browser or audit views.

No table contains an executable payload, closure, resolved secret, raw command, or unsanitized producer object.

## Lifecycle and Data Flow

### Request

1. The producer supplies a descriptor and held closure.
2. The service authenticates the producer boundary and selects the registered kind policy.
3. The policy validates, sanitizes, and classifies the descriptor.
4. The service allocates a random UUID, retrying only a uniqueness collision.
5. The repository inserts the sanitized record in internal `registering` state.
6. The held-effect registry activates the closure and its exact-effect fingerprint under the same ID.
7. The repository compare-and-swaps `registering` to visible `pending`.
8. If activation or the final transition fails, the registry discards the closure and the repository marks the record interrupted.
9. Only after visible activation does the service record correlated audit evidence, publish an approval event, and invoke optional notification ports.

All read paths exclude `registering`, so no caller can observe a pending record without an activated closure. Notification failure does not execute or discard the effect. It is recorded as an operational error while the workspace remains able to resolve the pending request.

### Decision

1. The caller submits the decision, current resource version, and idempotency key.
2. The service rechecks the appropriate core or workspace gate, identity, role, approval policy, and request visibility even when an idempotent result already exists.
3. Within one SQLite transaction, the repository checks the principal-scoped idempotency binding before stale-version handling. Its uniqueness scope is `(principal surface, principal ID, idempotency key)`; different principals have independent key namespaces.
4. Within one principal namespace, the same key with the same approval ID, decision, and expected version returns its original canonical result. Reuse with a different approval, decision, or version conflicts.
5. The repository performs a single-winner compare-and-swap whose predicate requires `state = pending`, the exact expected version, and `expires_at > now`.
6. If the compare-and-swap loses, the service loads the canonical row and distinguishes expiry, stale version, or an existing winner.
7. A denial consumes and discards the held closure without running it.
8. A grant marks execution `pending`, consumes the closure once, verifies its fingerprint against the record, and invokes it with the approval ID as the correlation identifier.
9. A missing or mismatched closure after a winning grant transitions execution to `interrupted`; it is never reconstructed or retried.
10. Success or failure updates execution outcome, audit, notifications, and SSE state.

Repeated identical decisions return the canonical result and never run the closure again. A conflicting decision returns the existing winner. A caller that loses connectivity reloads canonical state before offering another decision.

The service also keeps an in-process promise for the winning idempotency binding. Concurrent identical requests from the same principal await that promise and receive the same final canonical execution result. After completion, SQLite stores that result for later duplicates. If the process exits while the promise is in flight, startup reconciliation records interrupted execution and a later duplicate returns that canonical non-replayable state.

### Expiry

The existing periodic sweep moves due pending records to `expired` through the service. Its SQLite compare-and-swap requires `state = pending` and `expires_at <= now`. Decision and expiry transactions therefore have exactly one winner. Expiry discards the held closure and never invokes it. Notifications, audit, and SSE reflect the terminal state.

### Restart interruption

At startup, repository reconciliation transitions:

- Persisted `registering` records from a previous process to lifecycle `interrupted`.
- Persisted `pending` records from a previous process to `interrupted`.
- `granted` records whose execution remained `pending` to execution outcome `interrupted`.

The service never reconstructs or replays a held effect. Lifecycle-interrupted records are known to have been discarded fail-closed. Granted records with interrupted execution have an unknown outcome and carry explicit non-retry guidance. When adapter notification references exist, the notifier updates stale cards after the relevant adapter starts.

Database migration and reconciliation finish before approval producers, HTTP routes, Discord button handlers, or notification adapters begin accepting work. This ordering prevents ID collisions, invisible held effects, and stale pending cards during startup.

## Authorization and Identity

The service receives a canonical principal containing surface and identity. Adapter code performs surface authentication; the service applies approval authorization.

```ts
interface ApprovalPrincipal {
  surface: "web" | "discord" | string
  id: string
}
```

The rollout adds these explicit configuration fields:

```jsonc
{
  "workspace": {
    "features": { "approvals": false }
  },
  "approvals": {
    "enabled": true,
    "approvers": ["existing-discord-user-id"],
    "webApprovers": ["verified@example.com"]
  }
}
```

`approvals.approvers` retains its current Discord-ID meaning. `approvals.webApprovers` contains exact trusted-header identities or `"*"`. An absent or empty web list leaves workspace operators as compatibility approvers; a non-empty list requires both operator role and a list match.

### Workspace reads

- The workspace Approvals feature must be enabled for the React operations APIs, SSE stream, badge, and banners.
- Workspace viewers and operators may list, search, count, and open every globally sanitized approval record.
- The same global rule applies consistently to pending and history lists, detail shells, aggregate counts, and approval IDs carried by workspace SSE.
- Originating-conversation fields and links are omitted when the caller lacks permission for that conversation.
- A restricted origin may be represented as unavailable context, never by leaking its identifier or content.

### Workspace decisions

- The caller must be a workspace operator.
- When web approvers are configured, the trusted web identity must also match that list.
- When no web approver list is configured, workspace operators retain compatibility decision access.
- The service rechecks both requirements at decision time.

### Discord compatibility

Existing Discord approver IDs remain valid. The gateway authenticates and normalizes the button actor, but the shared policy service makes and audits the approval authorization decision. The generic pre-button gate must not silently reject the `approval:` namespace before the service can record a denied attempt.

Discord resolution passes a canonical Discord principal through the same service. A web identity cannot satisfy a Discord-specific policy merely because its raw string happens to match.

The policy boundary is extensible to namespaced Slack, Teams, and other principals without changing approval lifecycle code.

### `/legacy` compatibility

`/legacy` uses the same trusted web identity and the same web decision policy as the React workspace, but it is not gated by `workspace.features.approvals`. It remains available whenever the core approval subsystem and legacy dashboard are enabled.

The legacy dashboard no longer receives approval records inside the broadly consumed `/api/status` payload. That payload retains only a non-sensitive pending aggregate. The dashboard loads records from an authenticated compatibility endpoint backed by the shared service.

### Trusted web identity

Switchboard continues to trust the configured upstream SSO header. It does not add a second login screen. Deployments must strip caller-supplied identity headers and set exactly the verified identity before forwarding requests.

## Redaction and Audit

Kind-specific policies construct safe view models from explicit allowlists. They do not clone or spread producer objects.

Audit events cover:

- Request creation.
- Notification success or failure.
- Grant and denial attempts and winners.
- Expiry and restart interruption.
- Effect execution success or failure.
- Authorization, stale-version, and conflict outcomes.

Every event uses the approval ID as `corr` and includes only safe actor, action, target, risk, state, and outcome metadata. Audit records never contain the held closure, resolved secrets, raw headers, raw command arguments, or unsanitized details.

## HTTP API

The operations namespace exposes:

```text
GET  /api/operations/approvals
GET  /api/operations/approvals/:id
POST /api/operations/approvals/:id/decision
GET  /api/operations/approvals/events
```

`/legacy` additionally uses authenticated compatibility routes:

```text
GET  /api/approvals
POST /api/approvals/:id
```

Both compatibility routes call the same service and policy. They remain available independently of the workspace feature flag.

### List

The list endpoint supports bounded keyset pagination and filters for:

- Lifecycle state or pending/history group.
- Risk.
- Kind.
- Requesting principal.
- Conversation ID when the caller may view that conversation.
- Creation/decision time.
- Sanitized text search over summary and target.

Pending results sort by risk rank descending, expiry ascending, creation time ascending, and ID ascending. The opaque pending cursor encodes all four values. History sorts by terminal-transition time descending and ID descending, and its opaque cursor encodes both values.

### Detail

Detail returns the canonical sanitized record, permissions, related safe audit activity, current version, expiry information, and an authorized conversation link when available.

The API exposes resource versions as opaque non-empty strings. SQLite may implement them as incrementing integers, but clients compare and return the strings without interpreting them.

### Decision

The decision endpoint requires:

- `grant` or `deny`.
- A non-empty expected resource version.
- A non-empty `Idempotency-Key` header.

It returns the canonical record and execution result available at response time. A definitive execution failure is not described as an ambiguous network failure.

For the initial outbound producer, the decision request awaits the bounded delivery promise and returns the final execution outcome. A winning grant whose delivery definitively fails still returns HTTP `200` with the canonical `granted` record and `execution = failed`; the decision itself succeeded. If the client connection fails before receiving that result, the client reloads detail before offering any further action.

The legacy dashboard renders each record's current version, generates one idempotency key per decision attempt, and reuses that key only for an ambiguous retry. Its POST includes the rendered expected version and `Idempotency-Key` header.

Discord card custom IDs include approval ID, decision, and rendered version. The adapter derives a stable principal-scoped key from the platform interaction ID when available, otherwise from approval ID, version, decision, and Discord principal. The service's payload binding and compare-and-swap remain authoritative.

### Errors

Typed errors distinguish:

- Feature disabled or hidden.
- Missing identity.
- Forbidden view or decision.
- Invalid request.
- Stale version.
- Already resolved by the same or another actor.
- Expired or restart-interrupted request.
- Held effect unavailable.
- Internal unavailable state.

Error payloads contain safe codes and recovery guidance, not raw exceptions.

A definitive effect execution failure after a winning grant is a canonical terminal result, not an HTTP error. It returns the sanitized `granted` record with `execution = failed`.

Concrete HTTP mappings are:

- Hidden feature, disabled workspace API, unknown resource, or non-visible resource: `404`.
- Authenticated viewer without decision capability: `403`.
- Malformed decision, version, key, cursor, or filter: `400`.
- Stale version, conflicting idempotency binding, expiry race, or another decision winner: `409` with safe canonical state when authorized.
- Winning grant with definitive effect failure: `200` with `state = granted` and `execution = failed`.
- Unexpected internal failure before a canonical decision: `500` with a safe code.

Approval list, detail, compatibility, and decision responses set `Cache-Control: no-store`. SSE uses `Cache-Control: no-cache` and disables intermediary buffering where supported.

## Events and Live State

The approval stream follows the ordered Agents stream contract:

- Monotonic sequence IDs within a process.
- Bounded replay after a cursor.
- `snapshot_required` when a retained gap cannot be replayed.
- An explicit reset snapshot when a client cursor is ahead after a hub restart.
- Copy-isolated immutable event delivery.

Events identify changed approval IDs and safe aggregate counts. They do not carry full approval detail. Clients invalidate and reload canonical list, detail, rail badge, and conversation-banner queries.

The SSE endpoint authenticates before subscription and is available only to workspace viewers/operators while the workspace feature is enabled. Because those roles may view every globally sanitized approval shell, changed IDs and authorized global counts do not create a second visibility rule. Conversation IDs and conversation-derived content never appear in events.

The application owns one stable approval stream while the feature is visible. Navigating between Approvals and conversations does not create duplicate streams.

## Workspace Experience

### Navigation

Approvals is a first-class rail and mobile destination. Its badge displays the authorized pending count and has an accessible label that does not rely on color.

The workspace session contract exposes:

- Whether the Approvals destination is visible.
- Whether the core approval subsystem is producing requests.
- Approval role: `hidden`, `viewer`, or `operator`.
- Independent `canDecide` capability after `webApprovers` policy.
- Authorized pending aggregate when visible.

Navigation uses this contract rather than probing approval endpoints. An operator excluded by `webApprovers` sees read-only operator context without decision controls.

Routes are:

```text
/approvals
/approvals/:id
```

### Master-detail queue

Desktop uses a master-detail layout consistent with Agents:

- The master pane switches between Pending and History.
- Search and filters remain local route/query state.
- Pending rows emphasize risk and time to expiry.
- History rows show terminal decision and execution outcome.
- The detail pane contains exact sanitized effect context and actions.

Tablet uses a list and focus-managed detail drawer. Mobile uses separate list and detail routes with browser-history integration and focus restoration.

### Detail and decisions

Detail shows:

- Requested action, target, and server-classified risk.
- Requesting agent or hub principal.
- Authorized originating-conversation context.
- Sanitized resources and effect detail.
- Creation time, expiry, and current state.
- Decision and execution outcomes.
- Related safe audit activity.

Viewers see the same authorized operational facts without decision controls.

Decision safeguards are tiered:

- Low-risk denial may resolve directly.
- Elevated or destructive denial uses a lightweight irreversible-decision confirmation.
- Every grant confirms the exact held effect.
- Destructive grants use stronger impact language and deliberate confirmation.

Controls disable while offline or while a request is in flight. An open request resolved by another operator, expiry, or restart interruption transitions to its canonical terminal view through SSE. Ambiguous network responses force canonical reload before retry.

### Originating-conversation banner

When the active conversation has pending approvals the workspace displays a compact live banner above the transcript:

- The banner gives count, highest risk, nearest expiry, and a link to the canonical request.
- It is an operational projection, not a synthetic message.
- It never changes canonical transcript ordering or replay.
- Returning from Approvals restores the prior conversation route and focus when possible.
- Multiple requests open a conversation-filtered approval queue rather than hiding all but one.

The banner is omitted when the user cannot view the approval, even if they can view the conversation.

## Notification Adapters

`ApprovalNotificationPort` supports posting a pending notification and updating it after state changes. The service stores only opaque server-side notification references.

Discord implements the initial port with the existing approval card language and buttons. Button handlers authenticate through the existing Discord gate, then call `ApprovalOperationsService.decide`.

No notification adapter is required for web-only operation. A notifier failure cannot bypass authorization, resolve a request, or execute an effect.

## Accessibility and Responsive Behavior

The vertical includes:

- Correct navigation, list, region, dialog, status, and live-region semantics.
- Keyboard completion of search, filters, queue selection, detail, and decisions.
- Focus entry and return for tablet drawers and confirmation dialogs.
- Screen-reader announcement of pending-count, expiry, decision, and execution changes.
- Risk and state communicated by text and iconography, not color alone.
- Reduced-motion behavior.
- Minimum touch targets and no global horizontal overflow.
- Offline and unavailable states that preserve safe navigation and context.

## Verification Strategy

### Unit and repository tests

- SQLite migration idempotency and reopen persistence.
- UUID uniqueness across repository reopen and process restart.
- Invisible `registering` rows and startup interruption of abandoned registration.
- Strict decode and recursive redaction of persisted JSON.
- Exact pending/history ordering and composite keyset pagination behavior.
- Outbound allowlist sanitization, elevated risk, route version, body byte count, distinct keyed payload/effect fingerprints, and secret absence.
- Execution-result allowlisting, bounded fields, thrown-closure mapping, and raw error/response absence.
- Authorization across viewer, operator, configured web approver, Discord approver, and hidden identities.
- Global sanitized record visibility with separately protected conversation context.
- Single-winner compare-and-swap decisions.
- Decision-versus-expiry races enforced inside SQLite predicates.
- Idempotent duplicate and conflicting decisions.
- Concurrent identical idempotency requests sharing one final promise and cross-principal namespace independence.
- Expiry and startup interruption.
- Every valid lifecycle/execution pair and rejection of invalid pairs.
- Grant execution success, definitive delivery failure, missing closure, and crash-window reconciliation.
- Granted/interrupted unknown-outcome language and prohibition on automatic replay.
- Notification failure isolation.
- Immutable SSE replay, gap, and restart reset.

### API and composition tests

- Feature-disabled and missing-identity hiding.
- Independence of `approvals.enabled` from `workspace.features.approvals`.
- Typed list, detail, filter, decision, and event responses.
- Required version and idempotency boundaries.
- `no-store` API and `no-cache` SSE headers with exact HTTP error mappings.
- Conversation authorization and restricted-origin omission.
- Server-derived canonical provenance and omission when provenance cannot be verified.
- Real SQLite repository integration.
- Discord and web decisions reaching the same application service.
- Discord authorization denial reaching shared audit rather than being silently pre-gated.
- Legacy authenticated listing outside `/api/status`, rendered version submission, and idempotent retry.
- Existing outbound approval creation reaching the generic service.
- Outbound execution awaiting actual bounded delivery completion.
- Discord-disabled request, view, and decision flows.

### React tests

- Pending/history queue, filters, detail, and rail badge.
- Session-contract behavior for hidden, viewer, operator, and approver-excluded operator.
- Viewer/operator/approver control differences.
- Tiered confirmation language.
- Offline, stale, expired, interrupted, concurrently resolved, and definitive failure states.
- Stable stream lifecycle.
- Conversation banner projection and return navigation.
- Desktop master-detail, tablet drawer, and mobile route/focus behavior.

### End-to-end tests

Deterministic desktop, tablet, and mobile flows cover:

1. Creation of a real in-memory held approval through the generic service.
2. Rail badge and pending queue appearance.
3. Originating-conversation banner and deep link.
4. Grant confirmation and exactly-once effect count.
5. Definitive outbound delivery success and failure reflected truthfully.
6. Direct or confirmed denial according to risk.
7. Concurrent decision-versus-expiry reconciliation.
8. Pending fail-closed interruption and granted unknown-execution interruption presentation.
9. SSE disconnect and snapshot recovery.
10. Searchable SQLite history after a fixture restart.
11. `/legacy` approval compatibility with the workspace feature disabled.
12. Axe serious/critical checks and viewport overflow checks.

The complete `bun test`, typecheck, production web build, and single-worker Playwright matrix remain phase gates.

## Rollout

The new workspace surface ships behind `workspace.features.approvals`, default off. The existing `approvals.enabled` flag continues to control whether gated effects create approvals. Enabling the workspace flag exposes the destination and conversation banners without changing core production behavior or removing `/legacy` or Discord cards.

The migration is additive. Rollback disables the workspace feature but retains sanitized history and shared service behavior. Existing pending approvals retain memory-only fail-closed semantics.

Documentation covers:

- Feature and role configuration.
- Web approver policy and trusted-header boundary.
- Discord compatibility.
- Pending versus durable history semantics.
- Grant, denial, expiry, interruption, and execution-failure meanings.
- Rollback through `/legacy`.

Only the Approvals item is marked complete in the Phase 4 roadmap after the implementation and verification gate passes.

## Non-Goals

This vertical does not include:

- Persisting or resuming executable effects across restarts.
- Introducing new approval producers beyond the existing outbound route.
- Implementing Slack or Teams adapters.
- Allowing browser-defined approval kinds or arbitrary detail objects.
- Returning secrets, raw headers, raw commands, or unsanitized arguments.
- Completing Operations, Settings, or Phase 4B conversation parity.
- Redirecting or removing `/legacy`.

## Acceptance Criteria

The Approvals vertical is complete when:

- The responsive destination works with Discord disabled.
- Pending effects remain memory-only and fail closed across restarts.
- Sanitized history survives restarts in SQLite.
- Registration is invisible until both the durable record and held closure are active.
- Discord, `/legacy`, and workspace decisions use one service.
- Discord and `/legacy` remain functional when the workspace feature is disabled.
- View and decision authorization is enforced server-side.
- Decisions are versioned, idempotent, single-winner, and audited.
- Expiry races are decided by SQLite predicates rather than application timing.
- Grant execution outcome reflects awaited delivery and is reported separately from operator decision state.
- Granted execution interrupted by restart is shown as unknown and is never replayed automatically.
- Pending counts, queue/detail state, and conversation banners recover across SSE gaps and hub restarts.
- Desktop, tablet, mobile, PWA, accessibility, and Discord regression gates pass.
- `/legacy` remains available for rollback and remaining Phase 4 parity.
