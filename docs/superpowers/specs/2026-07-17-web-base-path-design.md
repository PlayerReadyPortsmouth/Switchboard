# Configurable Web URL Base Path Design

**Date:** 2026-07-17
**Status:** Approved design

## Objective

Make the web workspace (the React SPA under `web/client/`, built by `scripts/build-web.ts`
into `dist/web/`) servable under a configurable URL **base path** (e.g. `/switchboard/`) so it
can be deployed behind a reverse proxy that forwards `https://host/switchboard/*` (prefix
stripped) to the hub. Every asset, manifest, service-worker, API, and router URL the client
emits must be prefixed with the base so the browser addresses them under `/switchboard/…`,
while the hub — which sees the stripped path — continues to serve `/`, `/api/…`, `/sw.js`
unchanged.

## Hard constraint

Default base `"/"` (env unset) MUST produce **byte-identical** build output and identical
runtime behaviour to today. Every existing test passes unchanged. New behaviour only activates
when the base is set. This matches the repo's "off by default = byte-identical" ethos.

## Single source of truth

Env var **`SWITCHBOARD_WEB_BASE`**, read at **build time** by `scripts/build-web.ts`. The
resolved value (`BASE`) is baked into the emitted artifacts:

- `Bun.build({ publicPath: BASE })` prefixes every hashed chunk URL.
- A `<meta name="switchboard-base" content="${BASE}">` tag (emitted only when `BASE !== "/"`)
  carries the base to the client at runtime.
- The manifest, service worker, and PWA links are templated with `BASE`.

The client reads the meta tag once at load and threads the value through the router, API
client, and service-worker registration.

## Normalizer

A pure, unit-tested `normalizeWebBase(raw: string | undefined): string` in `web/webBase.ts`
(importable by both the build script and the client bundle):

- unset / `""` / `"/"` → `"/"`
- otherwise exactly one leading and one trailing slash, duplicate end slashes collapsed:
  `"switchboard"` → `"/switchboard/"`, `"/switchboard"` → `"/switchboard/"`,
  `"/a/b/"` → `"/a/b/"`. Internal slashes are preserved.

The result is `BASE` and always ends with a trailing slash.

## Build (`scripts/build-web.ts`)

1. `BASE = normalizeWebBase(process.env.SWITCHBOARD_WEB_BASE)`.
2. `Bun.build({ ..., publicPath: BASE })`.
3. PWA links: `href="${BASE}manifest.webmanifest"`, `href="${BASE}icons/icon-192.png"`.
4. Meta injection: when `BASE !== "/"`, prepend
   `<meta name="switchboard-base" content="${BASE}" />` to the pwaLinks block (so it lands in
   `<head>` right before the title insertion). When `BASE === "/"` no meta is emitted, keeping
   the HTML byte-identical to today.
5. Manifest templating: `manifest.webmanifest` is copied verbatim (as today). When
   `BASE !== "/"` it is re-written with `id`/`start_url`/`scope` = `BASE` and each icon
   `src` = `${BASE}<src-without-leading-slash>`. When `BASE === "/"` the verbatim copy is left
   untouched, preserving byte-identity.
6. Service-worker shell list: shell assets become `[BASE, "${BASE}index.html",
   "${BASE}chunk-*.js", …]` with no double slashes. The cache-version hash is computed over the
   BASE-prefixed served path plus the bytes of the physical file (read from `dist/web/<rel>`),
   so for `BASE === "/"` the hash — and therefore the whole sw.js and its cache name — is
   identical to today.
7. Service worker base token: a new `__SWITCHBOARD_BASE__` placeholder in `sw.template.js` is
   replaced with `BASE`. The SW uses it for the navigate fallback
   (`caches.match(\`${BASE}index.html\`)` → `caches.match(BASE)`) and the API bypass
   (`url.pathname.startsWith(\`${BASE}api/\`)`). For `BASE === "/"` these evaluate to the exact
   strings used today.

## Client

- **`web/webBase.ts`** — the pure `normalizeWebBase` (shared).
- **`web/client/base.ts`** — `readWebBase(doc = document)` returns the normalized content of the
  `switchboard-base` meta tag, or `"/"` when absent. Exports a module const `webBase` the app
  imports. Injectable `doc` for tests.
- **`web/client/routes.ts`** — `parseWorkspaceRoute(pathname, base = "/")`,
  `pathForConversation(id, base = "/")`, `pathForAgent(agent, base = "/")`. When `base !== "/"`,
  `parseWorkspaceRoute` strips the base prefix (treating the base or the base-without-trailing-
  slash as `/`) before applying today's logic, and returns `not_found` for a pathname not under
  the base. The path builders prefix their result with the base without producing `//`.
  `base === "/"` returns exactly today's strings.
- **`web/client/api.ts`** — `WorkspaceApi` gains a `basePath = "/"` constructor param. `request()`
  builds the URL as `${basePath-without-trailing-slash}${path}` against `baseUrl`. `"/"` →
  identical to today; `/switchboard/` → `/switchboard/api/…`.
- **`web/client/pwa.ts` / `main.tsx`** — `registerPwa(base = "/")` registers
  `\`${base}sw.js\`` with `{ scope: base }`. `main.tsx` passes `webBase`.
- **`web/client/App.tsx`** — all `location.pathname` reads, `pushState`/`replaceState`, and
  `popstate` handling go through the base-aware `routes.ts` helpers with `webBase`;
  `WorkspaceApi` is constructed with `webBase` as `basePath`; the not-found "Return to
  conversations" link targets `webBase`.
- **`web/client/components/AppRail.tsx`** — the legacy-console link targets `${webBase}legacy`
  so it stays under the base (identical to `/legacy` for the default base).

## Non-goals

No hub/server-side change: the reverse proxy strips the prefix, so the hub keeps serving `/`,
`/api/…`, and `/sw.js`. No config-file key is added (the base is a build-time env var). The
base is not hot-reloadable; it is chosen at build time per deployment.

## Testing

- `web/webBase.test.ts` — normalizer table.
- `web/client/base.test.ts` — meta-tag read (present / absent / injected doc).
- `web/client/routes.test.ts` — new non-root-base cases (existing default cases unchanged).
- `web/client/api.test.ts` — new non-root-base request case (existing default cases unchanged).
- `web/client/pwa.test.ts` — new based registration case (existing default case unchanged).
- `tests/buildWeb.test.ts` — new based-build assertions (existing default assertions unchanged):
  based `index.html` asset/manifest hrefs, meta tag, templated manifest, and based sw.js shell
  list + API bypass.
</invoke>
