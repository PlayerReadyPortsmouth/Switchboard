# Task 6 RED/GREEN Report

## Status

Complete. The browser now owns typed agent/session contracts, operations API methods, workspace route parsing/path generation, and a reconnecting operations SSE stream. No React destination components were added.

## Baseline and contract review

- Starting head: `69c09b1 feat(agents): expose shared operations APIs`.
- Existing focused baseline: `bun test web/client/api.test.ts` -> 4 passed, 0 failed.
- Confirmed the client contract against Task 5's `hub/operations/agentViews.ts`, `hub/operations/agentEvents.ts`, `hub/operations/agentService.ts`, `hub/operations/operationPreview.ts`, and `hub/webServer.ts`.
- No server/client JSON or SSE shape divergence was found.
- The worktree already contained unrelated modifications to task 1-4 reports; they were preserved and excluded from this task's commit.

## RED

Tests were written before production implementation in:

- `web/client/routes.test.ts`
- `web/client/api.test.ts`
- `web/client/agentStream.test.ts`

Command:

```text
bun test web/client/routes.test.ts web/client/api.test.ts web/client/agentStream.test.ts
```

Observed result: 4 passed, 3 failed, 2 module-load errors.

Expected failures:

- `Cannot find module './routes'`
- `Cannot find module './agentStream'`
- `TypeError: api.listAgents is not a function`

These failures demonstrated that the route module, stream module, and agent API surface were absent.

## GREEN

Implemented:

- Browser-owned agent view, editable config, preview/result, event, and required session feature/permission types.
- Six typed `/api/operations/agents` API methods with encoded names, exact JSON bodies, and action-confirm idempotency headers.
- `WorkspaceRoute`, `parseWorkspaceRoute`, `pathForConversation`, and `pathForAgent`, including malformed percent-encoding rejection.
- `AgentStream` with injected source/network/timer dependencies, one monotonic cursor, duplicate/out-of-order suppression, snapshot invalidation, connection states, reconnect backoff, online recovery, and stale callback suppression after `stop()`.
- Required session metadata in existing production fallback and typed test fixtures so the stricter Task 5 session contract typechecks.

Focused verification after implementation:

```text
bun test web/client/routes.test.ts web/client/api.test.ts web/client/agentStream.test.ts
14 passed, 0 failed, 41 assertions

bun run typecheck
exit 0
```

## Final verification

Fresh completion gate:

```text
bun test
1009 passed, 0 failed, 2596 assertions across 128 files

bun run typecheck
exit 0

bun run build:web
exit 0
```

`git diff --check` reported no whitespace errors. The line-ending warnings concern the repository's existing Windows checkout policy and not malformed diff content.

## Self-review

- Verified no client import reaches into `hub/`; all browser contracts are locally owned.
- Compared every agent endpoint path/body/header to `hub/webServer.ts`.
- Compared agent summary/detail/config/event fields to the Task 5 server view and service result types.
- Widened `previewAgentConfig` to accept `EditableAgentConfig | AgentConfig | null`, matching the server and preserving the opaque configured-value workflow needed by Task 8.
- Confirmed `snapshot_required` advances the same cursor before invalidation, so reconnect resumes after the server's replay boundary.
- Confirmed source callbacks are generation/attempt guarded and cannot mutate state after `stop()`.

## Concerns

None. The required `Session` fields caused expected compile-time fallout in existing local fallback/test fixtures; those fixtures were updated to the exact server contract.
