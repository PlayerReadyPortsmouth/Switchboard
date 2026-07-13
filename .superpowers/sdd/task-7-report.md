# Task 7 report — responsive, accessibility, reconnect, and installability gate

## Status

Implemented, independently reviewed, remediated, and verified. Phase 3 is complete for durable responsive web text conversations and PWA shell installability. This report does not claim Phase 4 operations parity.

## Implementation

- Added Playwright projects with the exact approved desktop (`1440×1000`), tablet (`900×1100`), and mobile (`390×844`, mobile/touch) settings.
- Added a single loopback-only fixture process at `127.0.0.1:4173`. It keeps one SQLite `:memory:` database open for its lifetime and routes real requests through `handleWebRequest`, `ConversationService`, `ConversationEventStream`, and `SqliteConversationRepository`.
- The fixture strips caller-provided trusted identity headers and sets `owner@example.com`. Its mutation namespace returns `404` unless `NODE_ENV=test`.
- Added per-conversation, idempotent SSE drop/close support and deterministic gap commits through the real service. Reconnect tests assert gap-first recovery, canonical sequence order, and one rendered row.
- Added commit-then-network-abort coverage proving Retry reuses the original idempotency key and yields one canonical user message and one agent reply.
- Added real UI workflows for create, multi-turn send/reply, primary-agent change, search, archive, `/legacy`, trusted identity, draft reload, responsive pane geometry, inspector collapse/drawer focus, mobile overflow/touch/safe-area controls, dialog/drawer focus traps, Enter/Shift+Enter, and whole-workspace Axe scans.
- Added manifest, exact icon dimension/content-type, active service-worker, cached-shell offline reload, offline API failure, and service-worker/cache cleanup coverage.
- Added `bunfig.toml` so the exact `bun test` command excludes Playwright-owned `tests/e2e/**`, and ignored Playwright output directories.
- Added the mobile creation control required when the application rail is hidden, raised Reply control contrast, and fixed modal Tab boundary trapping.
- Updated operator, configuration, architecture, and roadmap documentation for `/` versus `/legacy`, build/hub behavior, configurable trusted-header proxy requirements, shell-only caching/no offline submit, Discord-disabled web conversations, Phase 3 completion, the explicit Phase 4 backlog, and uncancellable adapter-send shutdown delay.

## RED → GREEN evidence

- Initial mobile gate reached the real app and failed waiting for the absent `Design review` fixture conversation. Seeding it through `ConversationService` made the required draft/reload case pass.
- The per-project mobile workflow failed because the rail-only New action was hidden on mobile. A mobile list-header action made the workflow pass.
- Whole mobile Axe coverage failed on the Reply control at 4.38:1. Removing its opacity reduction made serious/critical violations zero.
- Reconnect initially remained at `Connecting` because Bun did not flush empty SSE response headers. A valid ignored SSE comment established observable readiness; drop/gap recovery then passed without sleeps or server errors.
- The strengthened dialog boundary test proved Shift+Tab could leave the native dialog. An explicit shared modal Tab trap made the boundary and focus-return assertions pass.
- The first phase-gate typecheck identified incomplete fixture `AgentStatus` projections. Supplying the required status-safe fields made typecheck pass.
- The first full Bun run discovered Playwright `.spec.ts` files and rejected Playwright hooks under Bun. Native `test.pathIgnorePatterns` restored the exact `bun test` command to its unit/integration boundary.

## Independent review and remediation

The read-only review found no Critical issues. All Important findings were fixed:

- Axe now scans the complete rendered workspace in both list and transcript states rather than isolated fragments.
- Desktop asserts non-overlapping rail/list/transcript/inspector geometry and transcript expansion after inspector collapse; mobile asserts touch capability, bottom-navigation/control bounds, safe-area CSS presence, and no horizontal overflow.
- The new-conversation dialog now cycles both focus boundaries, and the E2E gate retains Escape/focus-return coverage.

The Minor artifact finding was also fixed by removing generated output and ignoring `test-results/` and `playwright-report/`.

## Final phase gate

Commands ran from fresh shells in the required order after remediation:

1. `bun run typecheck` — exit 0.
2. `bun test` — 924 passed, 0 failed, 2370 expectations across 121 files.
3. `bun run build:web` — exit 0; production workspace/PWA assets emitted.
4. `bun run test:e2e` — 15 passed, 12 intentional project skips, 0 failed across 27 discovered cases.
5. `git diff --check` — exit 0; no whitespace errors (line-ending notices only).

Playwright totals:

- Desktop: 7 passed, 2 skipped.
- Tablet: 4 passed, 5 skipped.
- Mobile: 4 passed, 5 skipped.
- PWA spec: 2 passed on desktop, 4 intentionally skipped on tablet/mobile because installability behavior is viewport-independent.
- Aggregate: 15 passed, 12 skipped, 0 failed.

## Self-review

- Determinism: no fixed sleeps; readiness uses visible states, service-worker readiness, request completion, and Playwright polling. Titles are project-unique and SSE drops are scoped by conversation id.
- Security: fixture binds only `127.0.0.1`, strips and sets the trusted header, and fail-closes `__e2e` routes outside test mode.
- Business boundaries: canonical data and events use the real repository/service/event/request boundaries; no mock conversation API substitutes for production behavior.
- Lifetime and cleanup: one fixture application process and one open in-memory database per Playwright run; SSE readers, server, database, offline state, service workers, caches, and generated Playwright artifacts are cleaned or ignored appropriately.
- Documentation: Phase 3 is described as durable text-conversation/PWA completion only. Canonical web attachments, consultations, delegations, handoff, approvals, agent management, operations, and settings remain explicitly in Phase 4.

## Concerns

No blocking concern remains. The PWA cases intentionally execute once in the desktop project; responsive behavior is separately covered in every configured viewport.
