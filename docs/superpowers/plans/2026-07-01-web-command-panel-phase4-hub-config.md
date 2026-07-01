# Web Command Panel Phase 4: Hub Config Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator edit `config/hub.config.json` from the web panel — one JSON textarea for the whole object, minus four boot-critical fields excluded entirely — through the same preview-then-confirm flow Phase 3 built for agents, adapted for a singleton (no create/remove, no per-row list).

**Architecture:** A pure classifier (`classifyHubChange`, set-difference over a small explicit `SAFE_KEYS` list — no `planReload` involvement, since hub-level classification needs no agent-registry diffing) + a short-lived preview registry (`HubConfigPreviewRegistry`, a simpler sibling of Phase 3's `AgentConfigPreviewRegistry` with no name key) + three new `/api/hub-config*` routes + a singleton editor panel in the dashboard, reading/writing `config/hub.config.json` directly in its raw on-disk shape end to end (never through the boot-time `loadConfigs`, which expands `~` in several fields).

**Tech Stack:** Bun + TypeScript (hub), `bun:test`, vanilla-JS dashboard (no build step).

## Global Constraints

- Hub tests use `bun:test`, run via `bun test` from the Switchboard repo root. No mocking library — small hand-rolled fakes.
- Dashboard JS uses plain `function(){}`/`var`/string concatenation — no arrow functions, no template literals, matching the existing script block's style exactly. No CSS classes on buttons anywhere in this file — every button is a bare `<button type="button">` styled only by element-selector CSS; interaction state goes through `data-*` attributes, not classes.
- New/changed pure logic lives in small, dependency-injected modules; `hub/index.ts` is wiring-only and is not unit-tested directly.
- `botTokenEnv`, `socketPath`, `stateDir`, `guildIds` are excluded from the editor entirely — never returned by `GET /api/hub-config`, and `POST /api/hub-config/preview` rejects (400, `{error}` shape) if a submitted config contains any of the four keys at all.
- This phase reads `config/hub.config.json` fresh from disk everywhere (`GET`, preview, confirm's drift check) — never the live in-memory `hub` object — mirroring Phase 3's raw-disk-always design, which exists specifically to avoid the class of bug Phase 3's final review caught (an in-memory value normalized at boot silently diverging from what's on disk).
- No auto-restart capability, ever, even for changes classified as needing one.
- No `"hard"` tier at the hub level — a change is either `"safe"` (hot-swappable now, applied automatically on confirm) or `"restart"` (written to disk, reported, never applied). There is no hub-level hard-respawn concept.
- Commit after each task.

---

### Task 1: `hub/hubConfigDraft.ts` — pure classifier

**Files:**
- Create: `hub/hubConfigDraft.ts`
- Test: `hub/hubConfigDraft.test.ts`

**Interfaces:**
- Consumes: `type HubConfig` from `./types`.
- Produces:
  - `export type HubChangeTier = "safe" | "restart"`
  - `export interface HubChangeClassification { tier: HubChangeTier; fullRestart: string[] }`
  - `export function classifyHubChange(before: HubConfig, after: HubConfig): HubChangeClassification`
- Consumed by: Task 3 (webServer route test fakes), Task 4 (`hub/index.ts`'s real preview/confirm implementation).

**Design note (do not deviate):** this classifier does NOT call `planReload` or import anything from `hub/configReload.ts`. `planReload` is shaped around diffing two whole agent registries plus hub-level keys together — hub-only classification needs none of that machinery. `classifyHubChange` is a plain set-difference: a small explicit `SAFE_KEYS` list (the exact 7 fields `!reload`'s existing apply logic hot-swaps today), and *any other top-level key that changed* — whether it's one of `planReload`'s own `HUB_FULL_RESTART_KEYS` (`defaultAgent`, `metricsPort`, `metricsHost`, `webPort`, `webHost`, `webhookPort`, `socketPath`, `stateDir`) or a field neither reload tier ever applies (`audit`, `escalation`, `statusRefreshMs`, etc.) — is uniformly `"restart"`. Both cases mean the same thing to the operator ("won't take effect until the hub restarts"), so there is no reason to special-case one list over the other, and no reason to export or import `HUB_FULL_RESTART_KEYS` from `configReload.ts` for this purpose.

- [ ] **Step 1: Write the failing tests**

```ts
// hub/hubConfigDraft.test.ts
import { test, expect } from "bun:test"
import { classifyHubChange } from "./hubConfigDraft"
import type { HubConfig } from "./types"

const base: HubConfig = {
  botTokenEnv: "DISCORD_TOKEN", guildIds: ["123"], socketPath: "/tmp/sb.sock", stateDir: "/srv/state",
  routerModel: "claude-haiku-4-5", switchThreshold: 0.5, defaultAgent: "qa",
  ephemeralTimeoutMs: 60000, tagStyle: "prefix", chatKeyScope: "channel",
  statusRefreshMs: 15000,
}

test("changing routerModel only classifies as safe", () => {
  const after: HubConfig = { ...base, routerModel: "claude-sonnet-4-6" }
  expect(classifyHubChange(base, after)).toEqual({ tier: "safe", fullRestart: [] })
})

test("changing contextWindows only classifies as safe", () => {
  const after: HubConfig = { ...base, contextWindows: { default: 100000 } }
  expect(classifyHubChange(base, after)).toEqual({ tier: "safe", fullRestart: [] })
})

test("changing a generic unlisted field (statusRefreshMs) classifies as restart, labeled with the field name", () => {
  const after: HubConfig = { ...base, statusRefreshMs: 30000 }
  expect(classifyHubChange(base, after)).toEqual({ tier: "restart", fullRestart: ["statusRefreshMs"] })
})

test("changing a planReload-tracked full-restart field (webPort) classifies as restart, identically to any other unsafe field", () => {
  const after: HubConfig = { ...base, webPort: 9090 }
  expect(classifyHubChange(base, after)).toEqual({ tier: "restart", fullRestart: ["webPort"] })
})

test("a mixed change (one safe field + one unsafe field) classifies as restart, listing only the unsafe field", () => {
  const after: HubConfig = { ...base, routerModel: "claude-sonnet-4-6", defaultAgent: "triage" }
  expect(classifyHubChange(base, after)).toEqual({ tier: "restart", fullRestart: ["defaultAgent"] })
})

test("no change at all classifies as safe with an empty fullRestart", () => {
  expect(classifyHubChange(base, { ...base })).toEqual({ tier: "safe", fullRestart: [] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/hubConfigDraft.test.ts`
Expected: FAIL — cannot find module `./hubConfigDraft`

- [ ] **Step 3: Implement `hubConfigDraft.ts`**

```ts
// hub/hubConfigDraft.ts
import type { HubConfig } from "./types"

export type HubChangeTier = "safe" | "restart"

export interface HubChangeClassification {
  tier: HubChangeTier
  fullRestart: string[]   // names of changed top-level HubConfig fields nothing applies live —
                           // whether that's because they're boot-time-only (ports, socketPath,
                           // defaultAgent, ...) or simply not covered by !reload's existing hot-swap
                           // logic (audit, escalation, statusRefreshMs, ...). Both mean the same
                           // thing to the operator, so this list makes no distinction between them.
}

// The exact 7 fields !reload's existing apply logic hot-swaps live today
// (see hub/index.ts's !reload branch and the applySafeHubFields helper it uses).
const SAFE_KEYS: (keyof HubConfig)[] = [
  "routerModel", "librarianModel", "distillerModel", "overseerModel",
  "contextWindows", "commands", "directCommands",
]

const j = (v: unknown): string => JSON.stringify(v ?? null)

/** Classify a hub-config before→after transition. Deliberately does not use
 *  planReload (see this file's header note in the plan) — a plain set-difference
 *  against SAFE_KEYS is both correct and simpler for a hub-only, non-registry diff. */
export function classifyHubChange(before: HubConfig, after: HubConfig): HubChangeClassification {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)])
  const fullRestart: string[] = []
  for (const key of keys) {
    const k = key as keyof HubConfig
    if (j(before[k]) !== j(after[k]) && !SAFE_KEYS.includes(k)) fullRestart.push(key)
  }
  return fullRestart.length > 0 ? { tier: "restart", fullRestart } : { tier: "safe", fullRestart: [] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/hubConfigDraft.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add hub/hubConfigDraft.ts hub/hubConfigDraft.test.ts
git commit -m "feat(hub-config): classifyHubChange — set-difference safe/restart classification"
```

---

### Task 2: `hub/hubConfigPreview.ts` — short-lived preview registry

**Files:**
- Create: `hub/hubConfigPreview.ts`
- Test: `hub/hubConfigPreview.test.ts`

**Interfaces:**
- Consumes: `type HubConfig` from `./types`; `type HubChangeClassification` from `./hubConfigDraft` (Task 1).
- Produces:
  - `export interface HubConfigPreview { id: string; before: HubConfig; after: HubConfig; classification: HubChangeClassification; createdAt: number; expiresAt: number }`
  - `export class HubConfigPreviewRegistry { constructor(now: () => number, genId: () => string, ttlMs: number); create(before, after, classification): HubConfigPreview; get(id): HubConfigPreview | undefined; consume(id): HubConfigPreview | null; sweepExpired(): HubConfigPreview[] }`
- Consumed by: Task 4 (`hub/index.ts` constructs the real instance and wires it into the preview/confirm routes).

**Design note:** a simpler sibling of Phase 3's `AgentConfigPreviewRegistry` (`hub/agentConfigPreview.ts`) — no `agentName` field, since there is exactly one hub config (no per-name keying, no create/remove variants: `before`/`after` are always full `HubConfig` objects, never `null`). Same TTL/single-shot-`consume`(expiry-checked)/`sweepExpired` shape otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
// hub/hubConfigPreview.test.ts
import { test, expect } from "bun:test"
import { HubConfigPreviewRegistry } from "./hubConfigPreview"
import type { HubConfig } from "./types"

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new HubConfigPreviewRegistry(() => now, () => `hubprev-${++n}`, ttl)
  return { r, at: (v: number) => { now = v }, advance: (d: number) => { now += d } }
}

const cfg = (routerModel: string): HubConfig => ({
  botTokenEnv: "DISCORD_TOKEN", guildIds: [], socketPath: "/tmp/x", stateDir: "/srv/x",
  routerModel, switchThreshold: 0.5, defaultAgent: "qa",
  ephemeralTimeoutMs: 60000, tagStyle: "prefix", chatKeyScope: "channel",
})
const classification = { tier: "safe" as const, fullRestart: [] }

test("create returns a preview with a generated id and computed expiry", () => {
  const h = harness()
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  expect(p.id).toBe("hubprev-1")
  expect(p.before).toEqual(cfg("a"))
  expect(p.after).toEqual(cfg("b"))
  expect(p.expiresAt).toBe(p.createdAt + 1000)
})

test("get returns the stored preview by id, undefined for unknown", () => {
  const h = harness()
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  expect(h.r.get(p.id)).toBe(p)
  expect(h.r.get("nope")).toBeUndefined()
})

test("consume is single-shot: second consume returns null", () => {
  const h = harness()
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  expect(h.r.consume(p.id)).toBe(p)
  expect(h.r.consume(p.id)).toBeNull()
})

test("consume past expiresAt returns null even if never swept", () => {
  const h = harness(1000)
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  h.advance(1001)
  expect(h.r.consume(p.id)).toBeNull()
})

test("sweepExpired removes and returns only expired entries", () => {
  const h = harness(1000)
  const p1 = h.r.create(cfg("a"), cfg("b"), classification)
  h.advance(500)
  const p2 = h.r.create(cfg("c"), cfg("d"), classification)
  h.advance(600)   // p1 (expires at 1000) is now expired, p2 (expires at 1500) is not
  const swept = h.r.sweepExpired()
  expect(swept).toEqual([p1])
  expect(h.r.get(p1.id)).toBeUndefined()
  expect(h.r.get(p2.id)).toBe(p2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/hubConfigPreview.test.ts`
Expected: FAIL — cannot find module `./hubConfigPreview`

- [ ] **Step 3: Implement `hubConfigPreview.ts`**

```ts
// hub/hubConfigPreview.ts
import type { HubConfig } from "./types"
import type { HubChangeClassification } from "./hubConfigDraft"

export interface HubConfigPreview {
  id: string
  before: HubConfig
  after: HubConfig
  classification: HubChangeClassification
  createdAt: number
  expiresAt: number
}

/** Short-lived staging area for a hub-config edit pending operator confirmation.
 *  A simpler sibling of AgentConfigPreviewRegistry (hub/agentConfigPreview.ts) —
 *  no name key, since there is exactly one hub config (before/after are always
 *  full HubConfig objects, never null; no create/remove variant). Same TTL /
 *  single-shot-consume(expiry-checked) / sweepExpired shape otherwise. */
export class HubConfigPreviewRegistry {
  private pending = new Map<string, HubConfigPreview>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  create(before: HubConfig, after: HubConfig, classification: HubChangeClassification): HubConfigPreview {
    const createdAt = this.now()
    const p: HubConfigPreview = {
      id: this.genId(), before, after, classification,
      createdAt, expiresAt: createdAt + this.ttlMs,
    }
    this.pending.set(p.id, p)
    return p
  }

  get(id: string): HubConfigPreview | undefined {
    return this.pending.get(id)
  }

  /** Single-shot: deletes and returns the preview if present and not expired.
   *  A second consume, or one past expiresAt (even if sweepExpired hasn't run
   *  yet), returns null. */
  consume(id: string): HubConfigPreview | null {
    const p = this.pending.get(id)
    if (!p) return null
    this.pending.delete(id)
    if (p.expiresAt <= this.now()) return null
    return p
  }

  sweepExpired(): HubConfigPreview[] {
    const t = this.now()
    const out: HubConfigPreview[] = []
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= t) { this.pending.delete(id); out.push(p) }
    }
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/hubConfigPreview.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add hub/hubConfigPreview.ts hub/hubConfigPreview.test.ts
git commit -m "feat(hub-config): HubConfigPreviewRegistry — short-lived preview staging"
```

---

### Task 3: `hub/webServer.ts` — `/api/hub-config*` routes

**Files:**
- Modify: `hub/webServer.ts`
- Modify: `tests/webServer.test.ts`

**Interfaces:**
- Consumes: `type HubConfig` from `./types`; `type HubChangeClassification` from `./hubConfigDraft` (Task 1).
- Produces (additions to `WebDeps`, inserted immediately after the existing `confirmAgentChange` field):
  - `listHubConfig: () => Promise<Partial<HubConfig>>` (excluded keys — `botTokenEnv`/`socketPath`/`stateDir`/`guildIds` — always absent from the returned object)
  - `previewHubConfigChange: (config: HubConfig) => Promise<{ id: string; before: Partial<HubConfig>; after: Partial<HubConfig>; classification: HubChangeClassification } | { error: string }>`
  - `confirmHubConfigChange: (id: string, actor: string) => Promise<{ state: "applied" | "not_found" | "conflict"; fullRestart: string[] }>`
  - New routes: `GET /api/hub-config`, `POST /api/hub-config/preview`, `POST /api/hub-config/confirm`.
- Consumed by: Task 4 (`hub/index.ts` supplies the real implementations).

This task does NOT implement excluded-key rejection or the redaction logic itself — that's Task 4's job inside the real `previewHubConfigChange`/`listHubConfig` implementations. This task only wires the HTTP layer: routes, auth-gate membership, request/response shapes, and status-code mapping, exactly mirroring the existing `/api/agents*` routes' structure.

- [ ] **Step 1: Write the failing tests**

Add to `tests/webServer.test.ts`: extend `fakeDeps()`'s default-return object with the three new fields (mirroring the existing `previewAgentChange`/`confirmAgentChange` defaults), add 7 new tests for the three new routes.

```ts
// In fakeDeps()'s defaults object, add:
//   listHubConfig: async () => ({ routerModel: "claude-haiku-4-5" }),
//   previewHubConfigChange: async () => ({ id: "hubprev-1", before: {}, after: {}, classification: { tier: "safe", fullRestart: [] } }),
//   confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }),

test("GET /api/hub-config → 200 JSON config", async () => {
  const deps = fakeDeps({ listHubConfig: async () => ({ routerModel: "claude-sonnet-4-6" }) })
  const res = await handleWebRequest(get("/api/hub-config", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ routerModel: "claude-sonnet-4-6" })
})

test("GET /api/hub-config without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/hub-config"), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/hub-config/preview → 200, forwards config", async () => {
  let called: { v: unknown } | null = null
  const deps = fakeDeps({
    previewHubConfigChange: async (config) => {
      called = { v: config }
      return { id: "hubprev-1", before: {}, after: config, classification: { tier: "restart", fullRestart: ["defaultAgent"] } }
    },
  })
  const res = await handleWebRequest(post("/api/hub-config/preview", { config: { routerModel: "claude-sonnet-4-6" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual({ v: { routerModel: "claude-sonnet-4-6" } })
  expect(await res.json()).toEqual({ id: "hubprev-1", before: {}, after: { routerModel: "claude-sonnet-4-6" }, classification: { tier: "restart", fullRestart: ["defaultAgent"] } })
})

test("POST /api/hub-config/preview → 400 when config is missing", async () => {
  const res = await handleWebRequest(post("/api/hub-config/preview", {}, { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/hub-config/preview → 400 when previewHubConfigChange returns an error shape", async () => {
  const deps = fakeDeps({ previewHubConfigChange: async () => ({ error: "cannot edit excluded field: socketPath" }) })
  const res = await handleWebRequest(post("/api/hub-config/preview", { config: { socketPath: "/tmp/x" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "cannot edit excluded field: socketPath" })
})

test("POST /api/hub-config/confirm → 200 on applied, forwards id and the caller's email as actor", async () => {
  let called: { v: unknown } | null = null
  const deps = fakeDeps({
    confirmHubConfigChange: async (id, actor) => { called = { v: [id, actor] }; return { state: "applied", fullRestart: [] } },
  })
  const res = await handleWebRequest(post("/api/hub-config/confirm", { id: "hubprev-1" }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual({ v: ["hubprev-1", "a@b.com"] })
  expect(await res.json()).toEqual({ state: "applied", fullRestart: [] })
})

test("POST /api/hub-config/confirm → 409 on not_found or conflict", async () => {
  const notFound = fakeDeps({ confirmHubConfigChange: async () => ({ state: "not_found", fullRestart: [] }) })
  const res1 = await handleWebRequest(post("/api/hub-config/confirm", { id: "x" }, { "x-switchboard-user": "a@b.com" }), notFound)
  expect(res1.status).toBe(409)

  const conflict = fakeDeps({ confirmHubConfigChange: async () => ({ state: "conflict", fullRestart: [] }) })
  const res2 = await handleWebRequest(post("/api/hub-config/confirm", { id: "x" }, { "x-switchboard-user": "a@b.com" }), conflict)
  expect(res2.status).toBe(409)
})

test("DELETE /api/hub-config with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/hub-config", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/webServer.test.ts`
Expected: FAIL — `listHubConfig`/`previewHubConfigChange`/`confirmHubConfigChange` don't exist on `WebDeps`, the three routes 404.

- [ ] **Step 3: Implement**

In `hub/webServer.ts`:

1. Add `import type { HubConfig } from "./types"` and `import type { HubChangeClassification } from "./hubConfigDraft"` to the top imports (alongside the existing `AgentConfig`/`AgentChangeClassification` imports).
2. Add the three fields to `WebDeps`, immediately after `confirmAgentChange`:

```ts
  listHubConfig: () => Promise<Partial<HubConfig>>
  previewHubConfigChange: (config: HubConfig) => Promise<{
    id: string; before: Partial<HubConfig>; after: Partial<HubConfig>; classification: HubChangeClassification
  } | { error: string }>
  confirmHubConfigChange: (id: string, actor: string) => Promise<{
    state: "applied" | "not_found" | "conflict"; fullRestart: string[]
  }>
```

3. Add the new route matchers alongside the existing ones (near `agentConfirmMatch`):

```ts
  const hubConfigMatch = path === "/api/hub-config"
  const hubConfigPreviewMatch = path === "/api/hub-config/preview"
  const hubConfigConfirmMatch = path === "/api/hub-config/confirm"
```

4. Add them to `isGuardedRoute`:

```ts
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch ||
    agentsMatch || agentPreviewMatch || agentConfirmMatch ||
    hubConfigMatch || hubConfigPreviewMatch || hubConfigConfirmMatch
```

5. Add the three handlers, after the existing `agentConfirmMatch` block and before the final `return new Response("method", { status: 405 })`:

```ts
    if (method === "GET" && hubConfigMatch) {
      return json(await deps.listHubConfig())
    }

    if (method === "POST" && hubConfigPreviewMatch) {
      const body = (await req.json().catch(() => null)) as { config?: HubConfig } | null
      if (!body?.config) return json({ error: "missing_config" }, 400)
      const preview = await deps.previewHubConfigChange(body.config)
      return "error" in preview ? json(preview, 400) : json(preview)
    }

    if (method === "POST" && hubConfigConfirmMatch) {
      const body = (await req.json().catch(() => null)) as { id?: string } | null
      if (!body?.id) return json({ error: "missing_id" }, 400)
      const result = await deps.confirmHubConfigChange(body.id, email)
      return result.state === "applied" ? json(result) : json(result, 409)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/webServer.test.ts`
Expected: PASS (all tests, including the 7 new ones)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: errors remaining only in `hub/index.ts` (Task 4's job) — none in `hub/webServer.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add hub/webServer.ts tests/webServer.test.ts
git commit -m "feat(web): GET/POST /api/hub-config preview+confirm routes"
```

---

### Task 4: `hub/index.ts` — wire it all up

**Files:**
- Modify: `hub/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- No new exports (wiring layer, not unit-tested directly — verified via the full suite + typecheck + a manual smoke check).

- [ ] **Step 1: Add imports**

Near the existing `import { classifyAgentChange, ... } from "./agentConfigDraft"` and `import { AgentConfigPreviewRegistry } from "./agentConfigPreview"` lines, add:

```ts
import { classifyHubChange, type HubChangeClassification } from "./hubConfigDraft"
import { HubConfigPreviewRegistry } from "./hubConfigPreview"
```

- [ ] **Step 2: Add `HUB_CONFIG_PATH`**

Immediately after the existing `const AGENTS_JSON_PATH = join(CONFIG_DIR, "agents.json")` line, add:

```ts
const HUB_CONFIG_PATH = join(CONFIG_DIR, "hub.config.json")
```

- [ ] **Step 3: Add `readHubConfig`/`writeHubConfig`**

Immediately after the existing `writeAgentsJson` function, add:

```ts
/** Read config/hub.config.json fresh, in its raw on-disk shape — NOT loadConfigs
 *  (which also expands `~` in socketPath/stateDir/outboundAttachments.outboxDir/
 *  shareLinks.artifactsDir). This phase's classify/preview/confirm plumbing works
 *  with the raw shape end to end, exactly like Phase 3 does for agents.json, so an
 *  edit round-trips exactly: GET returns what's on disk, POST writes back what was
 *  typed, no expansion mismatch ever appears in a diff. Note none of those four
 *  expanded fields are in hubConfigDraft.ts's SAFE_KEYS, so this phase's live
 *  hot-swap path (applySafeHubFields) never consumes a raw, unexpanded value —
 *  the class of bug Phase 3's final review caught for agent cwd cannot recur here. */
function readHubConfig(): HubConfig {
  return JSON.parse(readFileSync(HUB_CONFIG_PATH, "utf8")) as HubConfig
}

/** Atomically write the full hub config back to config/hub.config.json
 *  (temp-file-then-rename, matching writeAgentsJson). */
function writeHubConfig(config: HubConfig): void {
  const tmp = `${HUB_CONFIG_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(config, null, 2))
  renameSync(tmp, HUB_CONFIG_PATH)
}
```

- [ ] **Step 4: Extract `applySafeHubFields` and refactor `!reload` to use it**

Immediately after the existing `applySafeAgentFields` function, add:

```ts
/** Hot-swap the exact 7 hub-level fields !reload's safe tier applies live —
 *  the same fields hub/hubConfigDraft.ts's SAFE_KEYS lists. Updates both the
 *  `hub` object's own fields AND the two bare `commands`/`directCommands` `let`
 *  variables the router/direct-command matcher actually reads at call time —
 *  `hub.commands`/`hub.directCommands` alone are NOT enough, matching exactly
 *  what the Discord !reload branch already did inline before this extraction.
 *  Shared by the Discord !reload branch and the web confirm endpoint. */
function applySafeHubFields(next: HubConfig): void {
  hub.routerModel = next.routerModel
  hub.librarianModel = next.librarianModel
  hub.distillerModel = next.distillerModel
  hub.overseerModel = next.overseerModel
  hub.contextWindows = next.contextWindows
  hub.commands = next.commands
  hub.directCommands = next.directCommands
  commands = next.commands ?? []
  directCommands = next.directCommands ?? []
}
```

Then find the `!reload` branch (search for `/^!reload\b/i.test(trimmed)`) and replace its 9 inline hot-swap lines:

```ts
    hub.routerModel = next.hub.routerModel
    hub.librarianModel = next.hub.librarianModel
    hub.distillerModel = next.hub.distillerModel
    hub.overseerModel = next.hub.overseerModel
    hub.contextWindows = next.hub.contextWindows
    hub.commands = next.hub.commands
    hub.directCommands = next.hub.directCommands
    commands = next.hub.commands ?? []
    directCommands = next.hub.directCommands ?? []
```

with a single call:

```ts
    applySafeHubFields(next.hub)
```

(Behavior-preserving — `applySafeHubFields` contains exactly the 9 lines that were inline before, in the same order, applied to the same `next.hub` argument.)

- [ ] **Step 5: Construct the hub-config preview registry and its sweep**

Near the existing `agentConfigPreviews` construction and its `setInterval` sweep, add:

```ts
let hubPreviewCounter = 0
const hubConfigPreviews = new HubConfigPreviewRegistry(
  () => Date.now(),
  () => `hubprev-${++hubPreviewCounter}`,
  5 * 60_000,   // 5 minute TTL, matching agentConfigPreviews
)
```

and, near the existing `agentConfigPreviews.sweepExpired()` interval:

```ts
setInterval(() => { hubConfigPreviews.sweepExpired() }, 60_000).unref()
```

- [ ] **Step 6: Add the excluded-keys helper**

Add this as a new top-level function, anywhere after `HUB_CONFIG_PATH` is declared:

```ts
const EXCLUDED_HUB_CONFIG_KEYS = ["botTokenEnv", "socketPath", "stateDir", "guildIds"] as const

/** Strip the four boot-critical fields from a hub config before it's ever shown
 *  to the operator — used for both the GET response and every preview response,
 *  so the editor never displays them regardless of entry point. */
function redactHubConfig(config: HubConfig): Partial<HubConfig> {
  const { botTokenEnv, socketPath, stateDir, guildIds, ...rest } = config
  return rest
}

/** Returns the name of the first excluded key present in a submitted config, or
 *  null if none are present. A submission should never contain these — GET never
 *  shows them — so this is a defense-in-depth rejection, not a normal-path check. */
function excludedHubConfigKeyPresent(config: object): string | null {
  for (const key of EXCLUDED_HUB_CONFIG_KEYS) if (key in config) return key
  return null
}
```

- [ ] **Step 7: Wire the three new `webDeps` fields**

Find the `webDeps` object construction and add three new fields, immediately after the existing `confirmAgentChange` field:

```ts
  listHubConfig: async (): Promise<Partial<HubConfig>> => {
    return redactHubConfig(readHubConfig())
  },

  previewHubConfigChange: async (config) => {
    const excluded = excludedHubConfigKeyPresent(config)
    if (excluded) return { error: `cannot edit excluded field: ${excluded}` }
    if (typeof config.defaultAgent !== "string" || !agents[config.defaultAgent]) {
      return { error: "defaultAgent must name an existing agent" }
    }
    const current = readHubConfig()
    // Re-attach the excluded keys' real current values onto the proposed config —
    // GET never showed them to the operator, so their submission genuinely can't
    // include them, but the write (and the drift check at confirm time) must still
    // persist their real values rather than losing them.
    const after: HubConfig = {
      ...config,
      botTokenEnv: current.botTokenEnv, socketPath: current.socketPath,
      stateDir: current.stateDir, guildIds: current.guildIds,
    }
    const classification = classifyHubChange(current, after)
    const preview = hubConfigPreviews.create(current, after, classification)
    return {
      id: preview.id, before: redactHubConfig(preview.before), after: redactHubConfig(preview.after),
      classification: preview.classification,
    }
  },

  confirmHubConfigChange: async (id, actor) => {
    const preview = hubConfigPreviews.consume(id)
    if (!preview) return { state: "not_found", fullRestart: [] }

    // Drift check: re-read disk fresh and compare against what the preview
    // captured as `before` — if the hub config changed since the preview was
    // generated (another operator, or !reload), refuse rather than silently
    // clobber it.
    const current = readHubConfig()
    if (JSON.stringify(current) !== JSON.stringify(preview.before)) {
      return { state: "conflict", fullRestart: [] }
    }

    writeHubConfig(preview.after)
    // Safe fields are always applied on a confirmed edit, regardless of tier —
    // mirrors applySafeAgentFields always running for agent edits.
    applySafeHubFields(preview.after)

    audit.record({
      kind: "event", actor: `web:${actor}`, action: "hub_config_change", outcome: "ok",
      detail: { before: preview.before, after: preview.after, classification: preview.classification },
    })

    return { state: "applied", fullRestart: preview.classification.fullRestart }
  },
```

- [ ] **Step 8: Run the full hub test suite**

Run: `bun test`
Expected: PASS — all tests from Tasks 1-3 plus every existing test, with exactly 1 pre-existing failure (`tests/config.test.ts:8` `expandHome` on Windows, unrelated).

- [ ] **Step 9: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 10: Manual smoke test**

If a real Discord token/config is available: `bun run hub`, confirm it boots, then `curl -H 'X-Switchboard-User: test@example.com' localhost:8080/api/hub-config` returns the real hub config JSON with `botTokenEnv`/`socketPath`/`stateDir`/`guildIds` absent. If no live token is available in this environment, confirm as much as possible statically (tsc + full suite) and note which verification level was achieved.

- [ ] **Step 11: Commit**

```bash
git add hub/index.ts
git commit -m "feat(hub-config): wire hub config preview/confirm into the running hub"
```

---

### Task 5: `hub/web.ts` — "Edit hub config" UI

**Files:**
- Modify: `hub/web.ts`
- Modify: `hub/web.test.ts`

**Interfaces:**
- Consumes: `GET /api/hub-config`, `POST /api/hub-config/preview`, `POST /api/hub-config/confirm` (Tasks 3-4).
- No new exports — this is the dashboard's static HTML/JS template string.

**Design note (do not deviate):** no shared/generic diff-render or confirm-button-builder helper exists in the current file — `renderAgentPreview` and `openAgentEditor` are single-purpose functions tightly coupled to agent-specific DOM ids and response shapes, with no seam to generalize from. This task is therefore a straight adapted copy of that same pattern under new DOM ids and a new fetch target — not an attempted shared abstraction. It's simpler than the agent version: no per-name lookup, no New/Remove variants, no `data-edit-agent`/`data-remove-agent` delegated-click pattern — just one button that always opens the singleton editor, and no "hard" confirm button (hub-level changes are only ever `"safe"` or `"restart"`, per Task 1).

- [ ] **Step 1: Write the failing test**

Append to `hub/web.test.ts`:

```ts
test("the dashboard HTML has hub-config edit affordances and a JSON editor panel", () => {
  expect(DASHBOARD_HTML).toContain('id="editHubConfigBtn"')
  expect(DASHBOARD_HTML).toContain('id="hubConfigEditor"')
  expect(DASHBOARD_HTML).toContain('id="hubConfigEditorText"')
  expect(DASHBOARD_HTML).toContain("api/hub-config")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/web.test.ts`
Expected: FAIL — none of these markers exist yet.

- [ ] **Step 3: Add the "Hub Config" section and its editor panel markup**

Find the closing `</section>` of the Agents table's section (immediately before the `agentEditor` section). Insert a new section immediately after it, and immediately before the existing `agentEditor` section:

```html
<section>
  <h2>Hub Config <button id="editHubConfigBtn" type="button">Edit</button></h2>
</section>
<section id="hubConfigEditor" style="display:none">
  <h2>Edit hub config</h2>
  <textarea id="hubConfigEditorText" rows="16" style="width:100%;background:#1a1d24;border:1px solid #232733;color:#e6e6e6;padding:8px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
  <div style="margin-top:8px">
    <button id="hubConfigPreviewBtn" type="button">Preview</button>
    <button id="hubConfigEditorCancel" type="button">Cancel</button>
  </div>
  <div id="hubConfigDiff" class="muted" style="margin-top:8px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px"></div>
  <div id="hubConfigConfirmRow" style="margin-top:8px"></div>
</section>
```

- [ ] **Step 4: Add the editor JS**

Add near the agent-editor JS block (after its click-handler section). This is a self-contained block — plain `function(){}`/`var` throughout, matching the file's established style:

```js
var lastHubConfigPreviewId = null;

document.getElementById('editHubConfigBtn').addEventListener('click', function(){
  fetch('api/hub-config').then(function(r){ return r.json(); }).then(function(config){
    lastHubConfigPreviewId = null;
    $('hubConfigEditorText').value = JSON.stringify(config, null, 2);
    $('hubConfigDiff').textContent = '';
    $('hubConfigConfirmRow').innerHTML = '';
    $('hubConfigEditor').style.display = 'block';
  });
});

document.getElementById('hubConfigEditorCancel').addEventListener('click', function(){
  $('hubConfigEditor').style.display = 'none';
});

document.getElementById('hubConfigPreviewBtn').addEventListener('click', function(){
  var parsed;
  try { parsed = JSON.parse($('hubConfigEditorText').value); }
  catch (e) { $('hubConfigDiff').textContent = 'invalid JSON: '+e.message; return; }
  fetch('api/hub-config/preview', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({config: parsed}),
  }).then(function(r){ return r.json(); }).then(renderHubConfigPreview);
});

function renderHubConfigPreview(p){
  if (p.error) { $('hubConfigDiff').textContent = 'error: '+p.error; $('hubConfigConfirmRow').innerHTML = ''; return; }
  lastHubConfigPreviewId = p.id;
  var beforeStr = JSON.stringify(p.before, null, 2);
  var afterStr = JSON.stringify(p.after, null, 2);
  $('hubConfigDiff').textContent = 'BEFORE:\n'+beforeStr+'\n\nAFTER:\n'+afterStr+'\n\nCLASSIFICATION: '+p.classification.tier+
    (p.classification.fullRestart.length ? ' ('+p.classification.fullRestart.join(', ')+')' : '');
  var row = $('hubConfigConfirmRow');
  row.innerHTML = '';
  var btn = document.createElement('button');
  btn.textContent = p.classification.tier === 'restart' ? 'Save to disk (needs a full restart)' : 'Apply';
  row.appendChild(btn);
}

document.addEventListener('click', function(ev){
  var btn = ev.target.closest('#hubConfigConfirmRow button');
  if (!btn || !lastHubConfigPreviewId) return;
  fetch('api/hub-config/confirm', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({id: lastHubConfigPreviewId}),
  }).then(function(r){ return r.json(); }).then(function(result){
    $('hubConfigDiff').textContent += '\n\nRESULT: '+JSON.stringify(result);
    $('hubConfigConfirmRow').innerHTML = '';
    lastHubConfigPreviewId = null;
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test hub/web.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite + typecheck**

Run: `bun test` — expect the 1 pre-existing failure only.
Run: `bunx tsc --noEmit` — expect 0 errors.

- [ ] **Step 7: Commit**

```bash
git add hub/web.ts hub/web.test.ts
git commit -m "feat(web): hub config edit UI (JSON editor + preview/confirm)"
```

---

### Task 6: End-to-end verification + deploy

**Files:** none (verification + deploy only)

- [ ] **Step 1: Full suite + typecheck on the merged branch**

```bash
bun test
bunx tsc --noEmit
```
Expected: all green (1 known pre-existing failure only).

- [ ] **Step 2: Deploy to the VPS**

```bash
ssh readyapp-newvps "cd /srv/switchboard && git pull --ff-only origin master && pm2 restart switchboard-hub"
```
Confirm clean boot: `ssh readyapp-newvps "tail -10 /home/ubuntu/.pm2/logs/switchboard-hub-error.log"` shows a clean `gateway connected` / `web dashboard on ...` with no crash, and `pm2 describe switchboard-hub` shows `status: online` with a fresh `uptime`.

- [ ] **Step 3: Manual verification against the live hub**

```bash
ssh readyapp-newvps "curl -s -H 'X-Switchboard-User: test@example.com' localhost:8080/api/hub-config"
```
Confirm the response is real hub config JSON with `botTokenEnv`, `socketPath`, `stateDir`, and `guildIds` all absent.

In the browser, as an allowlisted user: click "Edit" on Hub Config, confirm the textarea pre-fills with the real config (minus the 4 excluded fields); change `routerModel` only, click Preview, confirm the diff shows and classification reads `safe`; click "Apply" and confirm the response reports success with no restart required. Separately: edit an unrelated field like `statusRefreshMs`, Preview, confirm classification reads `restart` with that field named, click "Save to disk", confirm it writes without affecting the live hub. Attempt to hand-edit the textarea to add `"socketPath": "/tmp/evil"` before clicking Preview, confirm the API rejects it with the `cannot edit excluded field: socketPath` error.

- [ ] **Step 4: Note follow-ups for whoever picks this up next**

This closes the command-panel roadmap's originally-scoped four phases (auth/approvals/chat/audit-tools, observability, agent config management, hub config editing). The still-open, by-design gap both this phase and Phase 3 surface rather than fix — `!reload`'s own hot-swap logic doesn't cover every field either phase's classifier flags as `"restart"` — remains a legitimate future enhancement to `!reload` itself, not either phase's scope.
