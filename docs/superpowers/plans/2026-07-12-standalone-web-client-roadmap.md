# Standalone Web Client Delivery Roadmap

> **For agentic workers:** Execute each linked implementation plan in order. Do not begin a later phase until the preceding phase's verification gate passes.

**Goal:** Deliver the approved standalone web client through independently testable, reversible phases.

**Source design:** `docs/superpowers/specs/2026-07-12-standalone-web-client-and-transport-architecture-design.md`

## Phase 1: Canonical Conversations and SQLite

Plan: `docs/superpowers/plans/2026-07-12-canonical-conversations-sqlite.md`

Introduce the transport-neutral domain, SQLite migrations and repositories, authorization service, sequenced event stream, and conversation HTTP API. Existing Discord behavior remains unchanged. The gate is durable CRUD, ordered/idempotent messages, role enforcement, and resumable events under unit and API tests.

## Phase 2: Transport Contract and Discord Migration

Create a follow-on plan after Phase 1 types and repository interfaces are merged. Define the adapter contract, delivery planner, receipts and retries; wrap the current Discord gateway; move Discord ingestion and output through canonical conversations; and support web-only agent turns when Discord is disabled. The gate is full existing Discord regression coverage plus web-only and two-way mirror integration tests.

## Phase 3: Responsive Workspace and PWA

Create a follow-on plan after the Phase 2 API/event contract stabilizes. Replace the embedded HTML dashboard with a bundled TypeScript client implementing the application rail, conversation list and transcript, composer, agent activity, responsive drawers, service worker, manifest, accessibility, and reconnect behavior. The gate is desktop/tablet/mobile end-to-end coverage and installable-PWA verification.

## Phase 4: Operations Parity and Legacy Retirement

Create a follow-on plan after the workspace shell is usable. Move agents, approvals, delivery failures, tools, traces, workflows, audit, and settings into their workspace destinations. Preserve preview/confirm safety flows. Redirect the legacy dashboard only after a parity checklist and operational soak pass.

## Cross-Phase Constraints

- Switchboard must remain deployable as one Bun/TypeScript process.
- SQLite defaults to `<stateDir>/switchboard.sqlite`; no external database is required.
- Existing trusted-proxy identity remains supported and configurable.
- Discord regressions block every phase that touches the gateway or routing pipeline.
- Canonical messages are committed before agent work or external delivery.
- No phase may make an external transport a runtime requirement for the web client.
- New transport-neutral code uses `conversationId`; `chatId` survives only at compatibility boundaries.
- Each phase ends with `bun test` and `bun run typecheck` passing.
