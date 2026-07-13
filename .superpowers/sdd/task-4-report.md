# Phase 3 Task 4 Report: Expandable Responsive Workspace Shell

## Status

Implemented, independently reviewed, revised, and verified.

## TDD evidence

### RED 1 — shell surface

- Command: `bun test web/client/App.test.tsx`
- Exit: 1.
- Expected failure: `Cannot find module './App'` because the responsive shell and components did not exist.
- Tests were written first for loading/opening, keyboard/focus order, loading/empty/forbidden/unavailable states, local search, create/archive dialogs, URL/popstate, semantic regions, and conditional install availability.

### GREEN 1 — shell behavior

- Implemented the application rail, conversation navigation, transcript shell, inspector, connection announcer, mobile navigation, routing, and dialogs.
- Intermediate focused run: 10 pass, 2 fail.
- The genuine behavior failure was the inspector exposing the implicit `complementary` role rather than the required named `region`; adding the explicit region role made the semantic contract pass.
- The other failure was fixture identity churn during `rerender`; preserving the same fake API instance kept the install-availability test scoped to the intended behavior.
- Focus-navigation investigation found `@testing-library/user-event`/Happy DOM looping on its combined focusable selector. The final test proves document order across rail, list, transcript actions, and composer with `compareDocumentPosition`, then proves programmatic focus reachability at the boundary controls without the non-terminating selector path.

### RED 2 — production stream wiring

- Command: `bun test web/client/App.test.tsx --test-name-pattern "production conversation stream" --timeout 5000`
- Exit: 1.
- Expected failure: named export `createWorkspaceStream` did not exist.
- This exposed that the first shell pass accepted an injected `ConversationStream` factory but did not create the real stream by default.

### GREEN 2 — production stream wiring

- Added `createWorkspaceStream`, backed by `WorkspaceApi.listMessages`, browser online state, and `EventSource`.
- Command: same focused production-stream test.
- Result: 1 pass, 0 fail.
- Typecheck result: exit 0.

### RED 3 — self-review and independent-review regressions

- Production dependency stability: the default-API test exposed repeated API construction across renders.
- Draft isolation: switching from Design to Operations expected `Ops draft` but received `Design draft` from the reused uncontrolled textarea.
- Modal semantics: the create dialog rendered visually but the `showModal()` call count was 0.
- Empty mobile drawer: the close control expected `disabled === true` but received false.
- Action-error isolation: a failed archive could carry stale error copy into a later create dialog.
- Stream canonicalization: a committed stream event reduced into state but initially had no observable canonical message count seam.
- Turn accessibility: after a `turn_state: working` event, `[data-turn-announcer]` was absent instead of announcing `Turn working.`.

### GREEN 3 — review revisions

- Stabilized default `WorkspaceApi` and `DraftStore` instances with component refs.
- Keyed the textarea by `conversationId`, made both dialogs native modal dialogs with Escape cancellation/cleanup, disabled the empty-list close action, and reset action errors on every open/close.
- Removed inactive responsive panes from keyboard/accessibility traversal with `visibility: hidden` and pointer gating until active.
- Canonical `message_committed` SSE events now enter reducer messages, and the latest structured turn state is announced through a visually hidden polite atomic live region.
- Review-focused run: 19 pass, 0 fail, 53 assertions.

## Implemented behavior

- `App` owns session/conversation loading, stable API/draft dependencies, workspace reducer state, URL selection, history/popstate, modal dialog actions, responsive pane state, and conversation-stream lifecycle.
- The data-driven 72px application rail contains the Switchboard signal mark, New conversation, Conversations, `/legacy`, live connection status, and install only when an install action is supplied.
- Conversation navigation provides case-insensitive local title search, active state, primary-agent/updated metadata, explicit empty/no-match states, create dialog with agent selection, and archive confirmation.
- URL state uses `history.pushState` and a `popstate` listener for `/` and `/conversations/<encoded-id>`; no router dependency was added.
- Create and archive actions update canonical API-backed state and navigation only after the API succeeds, with actionable inline failure copy.
- The default conversation stream performs gap-first message loading, canonicalizes committed SSE messages into reducer state, drives the connection announcer, and feeds a separate polite structured-turn announcer.
- DraftStore backs the deliberately minimal Task 4 composer shell; transcript/message composition internals remain for Task 5.
- Semantic regions are exposed as `application-navigation`, `conversation-navigation`, `transcript`, and `conversation-inspector` through labelled landmarks plus stable `data-region` names.
- Desktop uses `[72 rail][320 list][fluid transcript][320 inspector]`; tablet moves the inspector to a right drawer; mobile uses one fixed primary pane with full-screen list/inspector states and bottom navigation.
- Mobile controls are at least 44px, navigation includes safe-area insets, and reduced motion collapses transition durations.

## Verification

Fresh sequential gate, with one Bun command running at a time:

- `bun test web/client/App.test.tsx --timeout 5000`
  - Exit 0; 19 pass, 0 fail, 53 assertions.
- `bun run build:web`
  - Exit 0.
- `bun run typecheck`
  - Exit 0; `tsc --noEmit` clean.
- `bun test`
  - Exit 0; 875 pass, 0 fail, 2,208 assertions across 119 files in the final post-announcer run.
- `git diff --check`
  - Exit 0; only Git's existing LF/CRLF working-copy notices were emitted.

## Files

- Modified `web/client/main.tsx`.
- Created `web/client/App.tsx`.
- Created `web/client/App.test.tsx`.
- Created `web/client/components/AppRail.tsx`.
- Created `web/client/components/ConversationList.tsx`.
- Created `web/client/components/MobileNav.tsx`.
- Created `web/client/components/Inspector.tsx`.
- Created `web/client/components/ConnectionBanner.tsx`.
- Rebuilt `web/client/styles.css` around the required token contract and breakpoints.
- Overwrote this tracked report before the task commit.

## Design critique and accessibility review

- The design follows the approved quiet technical-studio direction: deep ink hierarchy and hairline boundaries carry structure, while Inter/system remains restrained and monospace is limited to technical metadata.
- The single memorable device is the crisp teal signal trace/node on the active conversation and Switchboard mark. Teal also conveys live state; warm is reserved for connecting activity and coral for danger. No gradients, glassmorphism, decorative numbering, generic card grids, or excessive pills were introduced.
- The shell remains truthful: only Conversations and the existing Legacy console are destinations; there are no dead Agents, Approvals, Operations, Settings, or PWA controls.
- Visible `:focus-visible` treatment uses the accent with an ink separation ring. Controls are labelled, dialogs use native modal isolation and labelled headings, connection and structured turn changes use separate `aria-live="polite"` announcers, and mobile controls meet the 44px target.
- The transcript content column is capped at 780px. Mobile safe-area padding covers the top, horizontal edges, dialog, composer, and bottom navigation. `prefers-reduced-motion` disables effective drawer/message transition duration.
- The in-app browser backend was unavailable (`agent.browsers.list()` returned no browser), and the browser skill prohibited switching to an unrelated automation backend. Therefore visual critique was completed from the rendered semantic structure and CSS contract rather than screenshots; this is the principal verification limitation.

## Self-review

- Scope stays within Task 4: transcript content and composer sending are intentionally placeholders, and no service worker/install-event capture was added.
- API and Discord server behavior were not modified.
- Conversation IDs are encoded on writes and decoded defensively on reads.
- Stream cleanup runs on selection changes/unmount, and API failures cannot silently imply successful creation or archive.
- Inactive tablet/mobile drawers are visibility-hidden and pointer-disabled until active, preventing off-screen focus and assistive-technology traversal.
- Composer nodes remount per conversation, preventing one conversation's displayed draft from being written into another conversation.
- Empty, forbidden, unavailable, retry, no-match, and action-error paths all give explicit next steps.
- No new runtime service, router, global state library, font fetch, or PWA dependency was introduced.

## Concerns

- Live screenshot/browser inspection could not be performed because the in-app browser backend was unavailable; the responsive and accessibility review is code/test based.
- Task 5 must replace the transcript and composer placeholders without weakening the shell's region naming, focus order, 780px cap, or canonical-send semantics.

## Independent review

- Initial review found no Critical issues and identified inactive-drawer focus exposure, draft leakage, modeless dialogs, missing committed-message canonicalization, stale action errors, unstable default dependencies, and a missing turn announcer.
- All in-scope findings were fixed with focused regressions.
- The reviewer accepted CSS visibility/pointer gating as resolving the actual responsive focus issue and accepted that transcript rendering remains Task 5 scope.
- Final re-review: **approved**, with no remaining Critical or Important issues.
- This report is finalized before the task commit and is not edited afterward.
