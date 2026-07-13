# Phase 3 Task 1 Report: React build pipeline and static workspace boundary

Status: `DONE_WITH_CONCERNS`

## Implementation summary

- Added the pinned React 19.2.7 client dependencies, browser-testing dependencies, Playwright/axe/sharp tooling, and the matching `@happy-dom/global-registrator@20.10.6` package required by the brief's exact test setup import.
- Added `build:web`, `hub:server`, and `test:e2e` scripts while preserving `test` and `typecheck`; `hub` now builds the browser client before starting the server.
- Enabled `react-jsx` and included `web` and `scripts` in TypeScript checking.
- Added the native Bun HTML/TSX/CSS build, initial React workspace shell, shared Happy DOM setup, and temporary minimal manifest/icon source inputs.
- Added `WorkspaceAssetHandler` and `createBuiltWorkspaceAssets()`, with MIME allowlisting, resolved-path containment, SPA fallback, no-cache handling for stable shell/PWA paths, and immutable caching limited to hashed `/assets/*` and `/icons/*` files.
- Moved the embedded dashboard to `/legacy`, redirects `/legacy/` to `/legacy`, delegates non-API GET routes to the workspace asset handler, preserves API dispatch, and creates the built asset handler once per active web server.
- Added focused tests for safe static routing, workspace/legacy isolation, and native build output.
- Adjusted the existing `scripts/smoke-peer.ts` callback state to a mutable wrapper because adding `scripts` to `tsconfig.json` exposed TypeScript's closure-narrowing limitation there.

## TDD evidence

### Routing RED

Command:

```powershell
bun test tests/webAssets.test.ts tests/webServer.test.ts
```

Expected relevant failures:

- `Cannot find module '../hub/webAssets'` because the asset boundary did not exist.
- `Expected: 503, Received: 200` for `/` because the old dashboard still owned the root.
- Injected workspace expected `workspace` but received the embedded dashboard because `handleWebRequest` had no workspace handler parameter.
- Unknown non-API GET expected 503 but received 404 because delegation was not implemented.

These failures were caused by the missing feature, not test syntax or fixture errors.

### Routing GREEN

Command:

```powershell
bun test tests/webAssets.test.ts tests/webServer.test.ts
```

Result: `33 pass, 0 fail, 68 expect() calls`.

### Native build RED

Commands:

```powershell
bun run build:web
bun test tests/buildWeb.test.ts
```

Expected relevant failure:

```text
Could not resolve: "/manifest.webmanifest"
Could not resolve: "/icons/icon-192.png"
```

Bun 1.3.14's native HTML loader treats manifest and icon links as mandatory build inputs. The task brief referenced future PWA files that were not part of the original Task 1 file list.

### Native build GREEN

After parent-approved compatibility inputs and source-relative URLs were added:

```powershell
bun test tests/buildWeb.test.ts
```

Result: `1 pass, 0 fail, 3 expect() calls`.

## Verification commands and results

```powershell
bun test tests/buildWeb.test.ts tests/webAssets.test.ts tests/webServer.test.ts
```

Result: `34 pass, 0 fail, 71 expect() calls`.

```powershell
bun run build:web
```

Result: exit 0; `dist/web/index.html` exists.

```powershell
bun run typecheck
```

Result: exit 0; `tsc --noEmit` reported no diagnostics.

```powershell
bun test
```

Result: `826 pass, 0 fail, 2071 expect() calls` across 115 files.

```powershell
git diff --check
```

Result: exit 0; no whitespace errors. Git only emitted existing LF-to-CRLF working-copy notices.

## Files changed

- `package.json`
- `bun.lock`
- `tsconfig.json`
- `scripts/build-web.ts`
- `scripts/smoke-peer.ts`
- `web/client/index.html`
- `web/client/main.tsx`
- `web/client/styles.css`
- `web/client/testSetup.ts`
- `web/client/manifest.webmanifest` (approved temporary compatibility input)
- `web/client/icons/icon-192.png` (approved temporary 192×192 compatibility input)
- `hub/webAssets.ts`
- `hub/webServer.ts`
- `tests/buildWeb.test.ts`
- `tests/webAssets.test.ts`
- `tests/webServer.test.ts`

## Self-review findings

- Completeness: all produced interfaces and package scripts from the brief are present; the focused build, asset routing, workspace/legacy routing, typecheck, and full suite are green.
- Scope: existing `/api/**` dispatch remains below the new non-API GET boundary and API tests pass. `startWebServer` retains its original stop behavior and constructs the asset handler only after a nonzero port is supplied.
- File responsibilities: browser entry/build logic, filesystem asset serving, request routing, and test setup remain separate.
- Safety: asset paths are decoded, resolved under the configured build root, checked for containment, and restricted to an explicit MIME map. Extensionless routes fall back only to `index.html`.
- Test quality: the new tests exercise real temporary files and the real Bun build rather than mocks. RED and GREEN were observed for both routing and the Bun HTML compatibility seam.
- Output: focused tests, build, and typecheck were pristine. The full suite passed but retains pre-existing intentional diagnostic lines from failure-path tests (for example `audit record failed: Error: disk full`).
- Worktree hygiene: unrelated untracked SDD coordination files were preserved and excluded from the commit.

## Concerns

- Bun 1.3.14 cannot build the brief's root-absolute source manifest/icon links from worktree-local inputs. With parent approval, Task 1 uses `./manifest.webmanifest` and `./icons/icon-192.png` in source plus `publicPath: "/"`. Bun emits root-safe but content-hashed paths such as `/manifest-<hash>.webmanifest` and `/icon-192-<hash>.png`.
- Task 6 must replace the temporary manifest/icon set, implement the production 192/512/maskable assets and public-file copying, and restore exact stable output URLs `/manifest.webmanifest` and `/icons/icon-192.png`.
- Bun currently emits JS/CSS and the compatibility assets at the output root, so the handler serves them correctly but the `/assets/*` and `/icons/*` immutable-cache rule does not apply to those emitted filenames. Task 6/build naming should reconcile stable PWA paths and hashed asset directories.

## Review fix: remove broken temporary manifest icon reference

Review verified that the temporary source manifest advertised `/icons/icon-192.png`, while Bun emits the HTML favicon input as a root-level hashed file such as `/icon-192-<hash>.png`. The temporary manifest now omits `icons` entirely. The HTML favicon source input and native build behavior are unchanged; Task 6 still owns the final production manifest and icon declarations.

### Review-fix RED

Command:

```powershell
bun test tests/buildWeb.test.ts
```

Result: `0 pass, 1 fail, 5 expect() calls`. The new emitted-manifest assertion expected `manifest.icons` to be undefined but received the broken `/icons/icon-192.png` entry.

### Review-fix GREEN and verification

```powershell
bun test tests/buildWeb.test.ts
```

Result: `1 pass, 0 fail, 5 expect() calls`.

```powershell
bun run build:web
```

Result: exit 0. The emitted hashed `.webmanifest` contains no `icons` property.

```powershell
bun run typecheck
```

Result: exit 0; `tsc --noEmit` reported no diagnostics.

Review-fix self-review found no changes outside `tests/buildWeb.test.ts`, `web/client/manifest.webmanifest`, and this report. The emitted temporary manifest no longer advertises a nonexistent asset, while the favicon remains available through the HTML link. Remaining Task 6 concerns are unchanged.
