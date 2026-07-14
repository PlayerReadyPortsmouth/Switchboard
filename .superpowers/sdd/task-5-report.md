# Task 5 Report — Hub Runtime Wiring, HTTP Routes, and SSE

## Status

Implemented and focused verification is green.

## RED evidence

Command:

```text
bun test tests/webServer.test.ts tests/conversationWeb.test.ts
```

Observed before production changes:

```text
9 tests failed
44 pass
9 fail
121 expect() calls
Ran 53 tests across 2 files
```

Expected route failures included:

```text
agent operations routes dispatch list, detail, config, and action requests
  SyntaxError: Failed to parse JSON
agent operations map authorization errors and hide routes before identity
  Expected: 403, Received: 404
agent operations reject malformed names and missing action idempotency keys
  Expected: 400, Received: 404
GET agent operation events emits SSE IDs, honors after, and unsubscribes on cancel
  content-type was absent because the route returned 404
```

The five legacy-route failures in the same RED run were expected while their test fixtures had already been migrated from the removed callbacks to `agentOperations`, but production still called the old callback properties.

## GREEN evidence

Immediate route GREEN command:

```text
bun test tests/webServer.test.ts tests/conversationWeb.test.ts
```

Result:

```text
53 pass
0 fail
152 expect() calls
Ran 53 tests across 2 files
```

Fresh final focused verification command (operation files expanded explicitly because PowerShell did not expand the plan's wildcard for Bun):

```text
bun test tests/webServer.test.ts tests/conversationWeb.test.ts hub/operations/access.test.ts hub/operations/agentEvents.test.ts hub/operations/agentService.test.ts hub/operations/agentViews.test.ts hub/operations/operationPreview.test.ts hub/agentConfigPreview.test.ts
bun run typecheck
```

Result:

```text
103 pass
0 fail
288 expect() calls
Ran 103 tests across 8 files
$ tsc --noEmit
```

## Full-suite evidence

Command run once:

```text
bun test
```

The full suite had one unrelated load-sensitive failure: `tests/buildWeb.test.ts` timed out at its 5-second limit while spawning the web build. The test was then isolated without code changes:

```text
bun test tests/buildWeb.test.ts --test-name-pattern "emits a stable install manifest"
1 pass
5 filtered out
0 fail
8 expect() calls
```

The isolated test completed in 1.268s (the test body in 886.66ms), supporting a suite-load timeout rather than a Task 5 regression.

## Implementation summary

- Replaced the three agent-specific web callbacks with the shared `AgentOperationsService` interface while preserving legacy agent URLs.
- Added list/detail/config/action operations routes, direct service-error mapping, encoded-name validation, idempotency-key enforcement, and resumable/cancellable SSE.
- Added session feature and role projection.
- Refactored reset to accept optional actor/channel context, so web resets do not send Discord messages while governor and Discord resets retain their channel behavior.
- Instantiated one event stream, config/action preview registries, idempotency registry, and operations service in the hub.
- Reused atomic agent config writes, safe-field application, home expansion, hard respawn, and full-restart reporting.
- Centralized status refresh/fingerprinting and added a feature-gated transport-independent heartbeat while keeping Discord board throttling separate.

## Self-review

- All seven required operations URLs are guarded before method disclosure.
- Agent names are decoded inside the service-adapter error boundary; malformed encodings return 400.
- SSE authorizes visibility before subscribing, honors query `after` over `Last-Event-ID`, emits sequence IDs, and unsubscribes on cancellation.
- Successful config/action confirmations publish their service-owned events once; status snapshots publish only when the public status rows change.
- No pre-existing Task 1–4 report changes were staged or included.

## Concern

The only verification concern is the unrelated full-suite web-build timeout described above; its isolated rerun passed.
