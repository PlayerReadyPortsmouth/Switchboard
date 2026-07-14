# Phase 4A Operations Control Plane Design

**Date:** 2026-07-14

**Status:** Approved in conversation; pending written-spec review

## Objective

Move Switchboard's operational capabilities into the responsive React workspace without coupling them to Discord or prematurely removing the legacy dashboard. Phase 4A covers Agents, Approvals, Operations, and Settings. Conversation capability parity—canonical web attachments, consultations, delegations, and handoff—remains a separate Phase 4B slice.

The result must work when Discord and every other external transport are disabled. Discord, the web workspace, and future Slack, Teams, or other adapters must call the same authorization, application, audit, and persistence services.

## Product Structure and Delivery Order

Phase 4A adds four first-class workspace destinations:

1. **Agents:** Availability, current work, capabilities, usage and session state, configuration, and protected runtime actions.
2. **Approvals:** A global actionable queue, resolved history, originating-conversation context, and idempotent decisions.
3. **Operations:** Transport health, delivery failures and retries, workflows, tool activity, traces, audit, runtime status, and diagnostics.
4. **Settings:** Hub and transport configuration, identity-header policy, mirroring defaults, operations policy, and PWA preferences.

Implementation proceeds vertically in that order. Each destination includes its application services, APIs, authorization, auditing, responsive interface, accessibility, and tests before work begins on the next destination. Independent feature flags allow each destination to be deployed or rolled back without altering persisted state.

`/legacy` remains available throughout Phase 4A and the operational soak period.

## Architectural Boundaries

The React workspace consumes typed operations APIs and structured server-sent events. HTTP routes remain thin adapters over an operations application layer:

```text
React destinations
        |
Typed operations API and SSE events
        |
Authorization and application services
        |
Agent runtime | Approval registry | Delivery repository
Trace/audit stores | Workflow engine | Configuration services
```

Existing agent-list and configuration preview/confirm routes remain compatible while their behavior moves behind shared application services. New APIs expose stable, redacted view models rather than internal runtime objects or raw configuration structures.

The browser never invokes Discord-specific code. External adapters do not access SQLite directly, choose agents, mutate protected state, or bypass authorization and audit services. All surfaces call the same underlying operations.

SQLite remains authoritative for canonical conversations and deliveries. Existing trace and audit storage can remain in place initially, but access is wrapped behind repository interfaces so their storage can evolve independently of the web client.

## Mutation and Safety Model

The interface applies risk-based confirmation:

- Routine, reversible actions may execute directly.
- Session reset, agent restart, removal, approval grants, destructive decisions, delivery retry, and disruptive configuration changes require confirmation appropriate to their impact.
- Configuration changes always use preview, diff, restart-impact classification, and explicit confirmation.
- Full hub restarts are never triggered automatically from the browser.

Every mutation rechecks authorization and current resource state at execution time. Operations that may be repeated by reconnects or concurrent operators accept idempotency keys, including approval decisions, delivery retries, resets, and restarts.

Preview tokens are short-lived, single-use, bound to the requesting user, target resource, exact resource version, normalized proposed value, and classified impact. Confirmation performs a fresh drift check. Stale, consumed, cross-user, or mismatched tokens fail without mutation.

All authorization, redaction, validation, and audit enforcement occurs server-side. Disabling or hiding a browser control is not a security boundary.

## Live Updates

Operational state changes publish structured SSE events through the workspace's existing live-update boundary. Events update navigation badges, agent state, approval queues, delivery status, workflow runs, and diagnostics without polling.

Each stream uses ordered event identifiers and reconnect recovery. When a recoverable gap cannot be replayed, the client invalidates the affected query and reloads its canonical snapshot. Mutation responses remain authoritative for the initiating client; SSE reconciles other views and operators.

## Agents Destination

### Experience

Desktop uses a master-detail layout. The list shows agent status, active work, model or runtime, and attention indicators. The selected agent exposes:

- **Overview:** Availability, capabilities, current work, usage, and recent errors.
- **Sessions:** Active session state and protected reset controls.
- **Configuration:** Guided controls for common settings plus Advanced JSON for complete configuration access.
- **Activity:** Recent tool, workflow, and audit events scoped to the agent.

Tablet uses a list with a detail drawer. Mobile uses separate list and detail routes with browser-history integration and focus restoration.

Users with visibility but without mutation permission see the same authorized status data with controls removed or clearly read-only. The destination explicitly handles loading, empty, permission-denied, disconnected, partial-runtime, and stale-preview states.

### Configuration Flow

Guided controls and Advanced JSON edit one shared draft:

1. Load the current resource version.
2. Edit the shared draft through either representation.
3. Validate and preview a normalized, redacted diff.
4. Classify each change as `live`, `agent restart`, or `full hub restart`.
5. Confirm using the bound single-use preview token.
6. Report whether the change applied live, restarted the agent, or was saved pending a hub restart.

Routine reversible controls may execute directly. Session reset, restart, removal, and changes that could interrupt current work show that work and the expected impact before confirmation.

## Approvals Destination

Approvals provides a global queue and also surfaces requests inside their originating conversations. Each canonical request contains:

- Requested action and requesting agent.
- Originating conversation and user context.
- Resources, arguments, and sanitized command or tool detail.
- Risk classification, creation time, and expiry.
- Related audit and activity events.

Selecting a request opens its complete detail. Low-risk denials may resolve directly; grants and destructive decisions require confirmation of the exact held effect. The server resolves against current state, so concurrent or repeated decisions return the existing result and never execute the effect twice.

Pending requests update through SSE and produce an application-rail badge. Resolved and expired requests move into searchable history. Conversation links and approval links reference the same canonical request and preserve return position.

The UI handles resolution by another operator, expiry while open, lost connectivity, view-without-decide permissions, and restart behavior explicitly. Pending approvals retain the current fail-closed in-memory behavior during parity work: a hub restart drops the held effect. Durable approvals would be a separate behavior and threat-model change.

## Operations Destination

Operations remains one workspace destination with focused internal sections:

- **Overview:** Hub health, adapter connectivity, queue depth, active work, approval count, storage state, and diagnostic warnings.
- **Deliveries:** Pending, retrying, failed, and exhausted deliveries; attempt history; sanitized errors; target adapter; protected manual retry.
- **Workflows:** Registered workflows, active runs, recent outcomes, and supported safe controls.
- **Activity:** Live and historical tool calls, results, traces, and structured agent activity, filterable by conversation, agent, type, and correlation identifier.
- **Audit:** Searchable security and mutation ledger with actor, action, target, outcome, and correlation links.
- **Diagnostics:** Existing doctor and status checks rendered as structured results where possible.

Correlation links connect a failed delivery to its canonical message, conversation, adapter health, attempts, and audit events. Manual retry acts on the existing delivery record, rechecks eligibility, uses an idempotency key, and never creates a duplicate canonical message.

Sensitive trace, tool, delivery, and audit fields are redacted based on server-side permissions. Desktop favors dense tables and an expandable inspector. Tablet and mobile render scannable summary cards with drill-down routes. Filters persist locally, and route state provides useful deep links.

## Settings Destination

Settings groups configuration into:

- General hub behavior.
- Identity headers and authorization policy.
- Conversation and default two-way mirroring behavior.
- Agent and runtime defaults.
- Operations, retention, approvals, and workflows.
- Transport adapters.
- PWA and appearance preferences.

Transport configuration uses an extensible adapter descriptor. Each adapter supplies identity, capabilities, health summary, configurable non-secret fields, validation, and restart requirements. Discord is one adapter entry; Slack, Teams, and future transports add descriptors rather than changing core navigation or settings architecture.

Secrets are never returned to the browser. The UI may show a secret reference and whether a required value is present, but never its resolved value. Boot-critical fields that could prevent the hub from starting remain excluded from browser editing.

Guided controls and Advanced JSON share one draft. Preview validates the complete configuration, normalizes defaults, creates a redacted diff, classifies live and restart impact, identifies affected adapters or agents, and issues a bound confirmation token. Confirm rechecks drift, writes atomically, applies only explicitly supported live changes, and records the redacted audit diff. Full-restart changes are saved but do not trigger an automatic restart.

## Authorization and Redaction

Each operation declares separate view and mutate permissions. API list and detail responses omit resources and fields the caller cannot view. Mutations fail closed if the trusted identity is absent, unauthorized, or changes during confirmation.

The existing deployment choice remains: Switchboard trusts the configured upstream SSO identity headers and does not add a second mandatory login screen. Deployments may choose their identity-header mapping and authorization policy. Direct exposure without a trusted proxy remains an explicit unsupported or insecure configuration unless a future authentication provider is configured.

Audit records contain redacted diffs and correlation metadata sufficient to reconstruct who requested, previewed, confirmed, rejected, or retried an operation without recording secrets.

## Error and Concurrency Behavior

The workspace distinguishes validation, authorization, conflict, stale preview, unavailable runtime, disconnected client, and internal failure states. Errors preserve the user's draft when safe and give a recovery action.

Concurrent mutations use resource versions or equivalent compare-and-swap checks. Approval resolution and delivery claiming remain single-winner operations. An SSE disconnect never implies that a submitted mutation failed; the client queries the mutation result or reloads canonical state before offering a retry.

## Verification Strategy

Each vertical includes:

- Unit tests for view-model mapping, authorization, redaction, risk classification, preview tokens, drift detection, and idempotency.
- API integration tests using real SQLite repositories and runtime service boundaries.
- React tests for permissions, stale data, disconnection, keyboard navigation, responsive layouts, and destructive-action safeguards.
- End-to-end desktop, tablet, and mobile flows for every mutation class.
- Contract tests proving Discord and web operations reach the same approval, configuration, retry, and audit services.
- Failure tests for concurrent decisions, process restart, adapter outage, retry exhaustion, stale previews, malformed configuration, and SSE reconnection.

Accessibility checks cover landmarks, headings, names, focus order, dialogs, live announcements, status not conveyed by color alone, reduced motion, keyboard-only completion, and focus return across responsive drawers and routes.

## Rollout and Legacy Retirement

The four destinations ship behind independent feature flags in vertical order. Enabling a destination exposes its workspace route while retaining the matching `/legacy` capability. Rollback disables the route without reverting persisted data or service boundaries.

After all Phase 4A destinations and the separate Phase 4B conversation capabilities reach parity, `/legacy` enters an operational soak. Retirement requires:

- Every parity checklist item demonstrated in the workspace.
- No unresolved severity-one or severity-two regressions.
- Successful hub restart and adapter-outage exercises.
- Audit evidence for every mutation class.
- A tested rollback procedure.
- Completion of a configurable soak duration, with 14 days as the recommended default.

After the gate passes, `/legacy` redirects to the most relevant workspace destination. Embedded dashboard presentation code is removed only in a later cleanup release, preserving straightforward rollback during the initial redirect period.

## Phase Boundaries and Non-goals

Phase 4A does not include:

- Canonical web attachment composition or delivery.
- Consultation, delegation, or explicit agent handoff UI.
- Durable approval execution across hub restarts.
- Automatic hub restarts from the browser.
- Returning resolved secrets to any client.
- Removing or redirecting `/legacy` before Phase 4A, Phase 4B, and soak gates pass.
- Implementing Slack or Teams adapters; this phase establishes the extension contract they will use.

## Acceptance Criteria

Phase 4A is complete when:

- Agents, Approvals, Operations, and Settings are first-class responsive workspace destinations.
- Each works with Discord disabled and uses shared services also available to adapters.
- Every mutation is authorized and audited server-side, with idempotency or conflict protection appropriate to its effect.
- Configuration editing supports guided controls and Advanced JSON through one preview/confirm flow.
- Operational updates recover correctly across SSE disconnects.
- Discord behavior remains fully functional and passes shared-service contract tests.
- Adapter settings are descriptor-driven and do not require Discord-specific workspace code.
- `/legacy` remains usable pending full Phase 4 parity and operational soak.
