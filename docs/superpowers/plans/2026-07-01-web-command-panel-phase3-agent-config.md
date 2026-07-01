# Web Command Panel Phase 3: Agent Config Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create, edit, or remove agent definitions from the web panel — full `AgentConfig` coverage via a JSON textarea — through a preview-then-confirm flow that shows an exact diff and an honest classification (safe / needs `!reload hard` / needs a full restart), reusing `!reload`'s existing apply logic rather than duplicating it.

**Architecture:** A pure classifier (`classifyAgentChange`, wraps `planReload` and adds a check for fields `!reload` never hot-swaps at all) + a short-lived preview registry (sibling of `ApprovalRegistry`) + three new `/api/agents*` routes + a JSON-textarea editing panel in the dashboard, all reading/writing `config/agents.json` directly (never through the boot-time `loadConfigs`, which also expands `~` paths and validates the whole registry — Phase 3 works with the raw on-disk shape end to end so no expansion round-trip bugs are possible).

**Tech Stack:** Bun + TypeScript (hub), `bun:test`, vanilla-JS dashboard (no build step).

## Global Constraints

- Hub tests use `bun:test`, run via `bun test` from the Switchboard repo root. No mocking library — small hand-rolled fakes.
- Dashboard JS uses plain `function(){}`/`var`/string concatenation — no arrow functions, no template literals, matching the existing script block's style exactly. Setting a textarea's content uses `.value = ...` (a DOM property), never `innerHTML` — `esc()` only escapes `&`/`<`/`>`, not quotes, so it is NOT safe for building attribute strings by concatenation.
- New/changed pure logic lives in small, dependency-injected modules; `hub/index.ts` is wiring-only and is not unit-tested directly.
- This phase never expands `~` in `cwd` and never touches `hub.config.json` — only `config/agents.json`, read and written in its raw on-disk shape.
- `!reload`'s own apply behavior is NOT modified by this phase — the "unapplied fields" gap (emoji/description/useMemory/injectContext/overseer/sessionGovernor/maxQueueDepth/coalesceBurst/pool/audit) is surfaced honestly (classified as needing a restart), not fixed.
- No auto-restart capability, ever, even for changes classified as needing one.
- Commit after each task.

---

### Task 1: `hub/agentConfigDraft.ts` — pure classifier

**Files:**
- Create: `hub/agentConfigDraft.ts`
- Test: `hub/agentConfigDraft.test.ts`

**Interfaces:**
- Consumes: `planReload`, `type ReloadPlan` from `./configReload` (already exists); `type AgentConfig, HubConfig, AgentRegistry` from `./types`.
- Produces:
  - `export type ChangeTier = "safe" | "hard" | "restart"`
  - `export interface AgentChangeClassification { tier: ChangeTier; fullRestart: string[] }`
  - `export function classifyAgentChange(name: string, before: AgentConfig | null, after: AgentConfig | null, hub: HubConfig): AgentChangeClassification`
- Consumed by: Task 3 (webServer route test fakes), Task 4 (`hub/index.ts`'s real preview/confirm implementation).

- [ ] **Step 1: Write the failing tests**

```ts
// hub/agentConfigDraft.test.ts
import { test, expect } from "bun:test"
import { classifyAgentChange } from "./agentConfigDraft"
import type { AgentConfig, HubConfig } from "./types"

const hub = { defaultAgent: "qa" } as HubConfig

const base: AgentConfig = {
  emoji: "🤖", description: "test agent", mode: "persistent",
  access: { roles: ["*"] },
  runtime: { cwd: "~", model: "claude-haiku-4-5" },
}

test("access-only change classifies as safe", () => {
  const after: AgentConfig = { ...base, access: { roles: ["dev"] } }
  expect(classifyAgentChange("a", base, after, hub)).toEqual({ tier: "safe", fullRestart: [] })
})

test("spawn-signature change on a persistent non-pooled agent classifies as hard", () => {
  const after: AgentConfig = { ...base, runtime: { ...base.runtime, model: "claude-sonnet-4-6" } }
  expect(classifyAgentChange("a", base, after, hub)).toEqual({ tier: "hard", fullRestart: [] })
})

test("adding a new agent classifies as restart, labeled +agent:<name>", () => {
  const result = classifyAgentChange("a", null, base, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["+agent:a"])
})

test("removing an agent classifies as restart, labeled -agent:<name>", () => {
  const result = classifyAgentChange("a", base, null, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["-agent:a"])
})

test("mode change classifies as restart", () => {
  const after: AgentConfig = { ...base, mode: "ephemeral" }
  const result = classifyAgentChange("a", base, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["agent-mode:a"])
})

test("pooled-agent spawn change classifies as restart, not hard", () => {
  const pooled: AgentConfig = { ...base, runtime: { ...base.runtime, pool: { min: 1, max: 3 } } }
  const after: AgentConfig = { ...pooled, runtime: { ...pooled.runtime, model: "claude-sonnet-4-6" } }
  const result = classifyAgentChange("a", pooled, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["agent-pool:a"])
})

test("an emoji-only change is NOT silently 'safe' — classifies as restart, labeled unapplied:emoji", () => {
  const after: AgentConfig = { ...base, emoji: "🎉" }
  const result = classifyAgentChange("a", base, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["unapplied:emoji"])
})

test("a runtime.pool value change on an otherwise-safe agent is flagged unapplied, not silently dropped", () => {
  const after: AgentConfig = { ...base, runtime: { ...base.runtime, pool: { min: 1, max: 2 } } }
  const result = classifyAgentChange("a", base, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["unapplied:runtime.pool"])
})

test("no change at all classifies as safe with an empty fullRestart", () => {
  expect(classifyAgentChange("a", base, { ...base }, hub)).toEqual({ tier: "safe", fullRestart: [] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/agentConfigDraft.test.ts`
Expected: FAIL — cannot find module `./agentConfigDraft`

- [ ] **Step 3: Implement `agentConfigDraft.ts`**

```ts
// hub/agentConfigDraft.ts
import { planReload } from "./configReload"
import type { AgentConfig, HubConfig, AgentRegistry } from "./types"

export type ChangeTier = "safe" | "hard" | "restart"

export interface AgentChangeClassification {
  tier: ChangeTier
  fullRestart: string[]   // reasons a restart is needed: planReload's own labels
                           // (+agent:/-agent:/agent-mode:/agent-pool:/hub-level keys)
                           // plus this module's own "unapplied:<field>" labels
}

const j = (v: unknown): string => JSON.stringify(v ?? null)

/** Fields !reload's existing apply logic never hot-swaps, and planReload never
 *  flags as needing a restart either — a change to any of these via a hand-edited
 *  file + !reload silently does nothing today. Surfaced here so this module's
 *  classification is honest rather than implying safe/hard/full-restart is
 *  exhaustive. Deliberately NOT a fix to !reload's own apply logic (out of scope
 *  for this phase — see the Phase 3 design spec §1/§8). */
function unappliedFieldDiffs(before: AgentConfig, after: AgentConfig): string[] {
  const out: string[] = []
  if (j(before.emoji) !== j(after.emoji)) out.push("unapplied:emoji")
  if (j(before.description) !== j(after.description)) out.push("unapplied:description")
  const br = before.runtime, ar = after.runtime
  if (j(br.useMemory) !== j(ar.useMemory)) out.push("unapplied:runtime.useMemory")
  if (j(br.injectContext) !== j(ar.injectContext)) out.push("unapplied:runtime.injectContext")
  if (j(br.overseer) !== j(ar.overseer)) out.push("unapplied:runtime.overseer")
  if (j(br.sessionGovernor) !== j(ar.sessionGovernor)) out.push("unapplied:runtime.sessionGovernor")
  if (j(br.maxQueueDepth) !== j(ar.maxQueueDepth)) out.push("unapplied:runtime.maxQueueDepth")
  if (j(br.coalesceBurst) !== j(ar.coalesceBurst)) out.push("unapplied:runtime.coalesceBurst")
  if (j(br.pool) !== j(ar.pool)) out.push("unapplied:runtime.pool")
  if (j(br.audit) !== j(ar.audit)) out.push("unapplied:runtime.audit")
  return out
}

/** Classify one agent's before→after transition. planReload is shaped for a
 *  whole-registry prev/next comparison, so this builds single-entry "registries"
 *  containing only `name` to scope it to just this agent — since `hub` is passed
 *  identically as both prev.hub and next.hub, planReload's hub-level-key diff is
 *  always empty here (Phase 3 never touches hub.config.json), and its add/remove
 *  loops only ever see the one name being diffed. */
export function classifyAgentChange(
  name: string, before: AgentConfig | null, after: AgentConfig | null, hub: HubConfig,
): AgentChangeClassification {
  const prevAgents: AgentRegistry = before ? { [name]: before } : {}
  const nextAgents: AgentRegistry = after ? { [name]: after } : {}
  const plan = planReload({ hub, agents: prevAgents }, { hub, agents: nextAgents })
  const fullRestart = [...plan.fullRestart]
  if (before && after) fullRestart.push(...unappliedFieldDiffs(before, after))
  if (fullRestart.length > 0) return { tier: "restart", fullRestart }
  if (plan.restartAgents.length > 0) return { tier: "hard", fullRestart: [] }
  return { tier: "safe", fullRestart: [] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/agentConfigDraft.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add hub/agentConfigDraft.ts hub/agentConfigDraft.test.ts
git commit -m "feat(agents): classifyAgentChange — honest safe/hard/restart classification"
```

---

### Task 2: `hub/agentConfigPreview.ts` — short-lived preview registry

**Files:**
- Create: `hub/agentConfigPreview.ts`
- Test: `hub/agentConfigPreview.test.ts`

**Interfaces:**
- Consumes: `type AgentConfig` from `./types`; `type AgentChangeClassification` from `./agentConfigDraft` (Task 1).
- Produces:
  - `export interface AgentConfigPreview { id: string; agentName: string; before: AgentConfig | null; after: AgentConfig | null; classification: AgentChangeClassification; createdAt: number; expiresAt: number }`
  - `export class AgentConfigPreviewRegistry { constructor(now: () => number, genId: () => string, ttlMs: number); create(agentName, before, after, classification): AgentConfigPreview; get(id): AgentConfigPreview | undefined; consume(id): AgentConfigPreview | null; sweepExpired(): AgentConfigPreview[] }`
- Consumed by: Task 4 (`hub/index.ts` constructs the real instance and wires it into the preview/confirm routes).

- [ ] **Step 1: Write the failing tests**

```ts
// hub/agentConfigPreview.test.ts
import { test, expect } from "bun:test"
import { AgentConfigPreviewRegistry } from "./agentConfigPreview"
import type { AgentConfig } from "./types"

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new AgentConfigPreviewRegistry(() => now, () => `prev-${++n}`, ttl)
  return { r, at: (v: number) => { now = v }, advance: (d: number) => { now += d } }
}

const cfg: AgentConfig = {
  emoji: "🤖", description: "d", mode: "persistent",
  access: { roles: ["*"] }, runtime: { cwd: "~" },
}
const classification = { tier: "safe" as const, fullRestart: [] }

test("create returns a preview with a generated id and computed expiry", () => {
  const h = harness()
  const p = h.r.create("qa", null, cfg, classification)
  expect(p.id).toBe("prev-1")
  expect(p.agentName).toBe("qa")
  expect(p.before).toBeNull()
  expect(p.after).toEqual(cfg)
  expect(p.expiresAt).toBe(p.createdAt + 1000)
})

test("get returns the stored preview by id, undefined for unknown", () => {
  const h = harness()
  const p = h.r.create("qa", null, cfg, classification)
  expect(h.r.get(p.id)).toBe(p)
  expect(h.r.get("nope")).toBeUndefined()
})

test("consume is single-shot: second consume returns null", () => {
  const h = harness()
  const p = h.r.create("qa", null, cfg, classification)
  expect(h.r.consume(p.id)).toBe(p)
  expect(h.r.consume(p.id)).toBeNull()
})

test("consume past expiresAt returns null even if never swept", () => {
  const h = harness(1000)
  const p = h.r.create("qa", null, cfg, classification)
  h.advance(1001)
  expect(h.r.consume(p.id)).toBeNull()
})

test("sweepExpired removes and returns only expired entries", () => {
  const h = harness(1000)
  const p1 = h.r.create("a", null, cfg, classification)
  h.advance(500)
  const p2 = h.r.create("b", null, cfg, classification)
  h.advance(600)   // p1 (expires at 1000) is now expired, p2 (expires at 1500) is not
  const swept = h.r.sweepExpired()
  expect(swept).toEqual([p1])
  expect(h.r.get(p1.id)).toBeUndefined()
  expect(h.r.get(p2.id)).toBe(p2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/agentConfigPreview.test.ts`
Expected: FAIL — cannot find module `./agentConfigPreview`

- [ ] **Step 3: Implement `agentConfigPreview.ts`**

```ts
// hub/agentConfigPreview.ts
import type { AgentConfig } from "./types"
import type { AgentChangeClassification } from "./agentConfigDraft"

export interface AgentConfigPreview {
  id: string
  agentName: string
  before: AgentConfig | null
  after: AgentConfig | null
  classification: AgentChangeClassification
  createdAt: number
  expiresAt: number
}

/** Short-lived staging area for an agent-config edit pending operator confirmation.
 *  A sibling of ApprovalRegistry, not a reuse of it — a preview is a self-serve
 *  "are you sure" for the SAME operator's own pending edit (no separate approver
 *  identity, no `fire` callback), different enough to blur both if forced together.
 *  Unlike ApprovalRegistry.resolve, `consume` checks expiry directly (not just
 *  presence) — a stale-but-unswept preview must never silently confirm. */
export class AgentConfigPreviewRegistry {
  private pending = new Map<string, AgentConfigPreview>()
  constructor(
    private now: () => number,
    private genId: () => string,
    private ttlMs: number,
  ) {}

  create(
    agentName: string, before: AgentConfig | null, after: AgentConfig | null,
    classification: AgentChangeClassification,
  ): AgentConfigPreview {
    const createdAt = this.now()
    const p: AgentConfigPreview = {
      id: this.genId(), agentName, before, after, classification,
      createdAt, expiresAt: createdAt + this.ttlMs,
    }
    this.pending.set(p.id, p)
    return p
  }

  get(id: string): AgentConfigPreview | undefined {
    return this.pending.get(id)
  }

  /** Single-shot: deletes and returns the preview if present and not expired.
   *  A second consume, or one past expiresAt (even if sweepExpired hasn't run
   *  yet), returns null. */
  consume(id: string): AgentConfigPreview | null {
    const p = this.pending.get(id)
    if (!p) return null
    this.pending.delete(id)
    if (p.expiresAt <= this.now()) return null
    return p
  }

  sweepExpired(): AgentConfigPreview[] {
    const t = this.now()
    const out: AgentConfigPreview[] = []
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= t) { this.pending.delete(id); out.push(p) }
    }
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/agentConfigPreview.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add hub/agentConfigPreview.ts hub/agentConfigPreview.test.ts
git commit -m "feat(agents): AgentConfigPreviewRegistry — short-lived preview staging"
```

---

### Task 3: `hub/webServer.ts` — `/api/agents*` routes

**Files:**
- Modify: `hub/webServer.ts`
- Modify: `tests/webServer.test.ts`

**Interfaces:**
- Consumes: `type AgentConfig` from `./types`; `type AgentChangeClassification` from `./agentConfigDraft` (Task 1).
- Produces (additions to `WebDeps`):
  - `listAgents: () => Promise<Record<string, AgentConfig>>`
  - `previewAgentChange: (name: string, config: AgentConfig | null) => Promise<{ id: string; before: AgentConfig | null; after: AgentConfig | null; classification: AgentChangeClassification }>`
  - `confirmAgentChange: (name: string, id: string, hard: boolean, actor: string) => Promise<{ state: "applied" | "not_found" | "conflict"; restarted: string[]; fullRestart: string[] }>` (`actor` is the operator's email, from `deps.requireUser(req)` — needed so the audit event Task 4 writes attributes the change to the operator, not the agent being edited)
  - New routes: `GET /api/agents`, `POST /api/agents/:name/preview`, `POST /api/agents/:name/confirm`.
- Consumed by: Task 4 (`hub/index.ts` supplies the real implementations).

- [ ] **Step 1: Write the failing tests**

Add to `tests/webServer.test.ts`: extend `fakeDeps()` with the three new fields, add tests for the three new routes.

```ts
// In fakeDeps(), add:
//   listAgents: async () => ({}),
//   previewAgentChange: async () => ({ id: "prev-1", before: null, after: null, classification: { tier: "safe", fullRestart: [] } }),
//   confirmAgentChange: async () => ({ state: "not_found", restarted: [], fullRestart: [] }),

test("GET /api/agents → 200 JSON registry", async () => {
  const agentCfg = { emoji: "🤖", description: "d", mode: "persistent", access: { roles: ["*"] }, runtime: { cwd: "~" } };
  const deps = fakeDeps({ listAgents: async () => ({ qa: agentCfg }) })
  const res = await handleWebRequest(get("/api/agents", { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ qa: agentCfg })
})

test("GET /api/agents without X-Switchboard-User → 400", async () => {
  const res = await handleWebRequest(get("/api/agents"), fakeDeps())
  expect(res.status).toBe(400)
})

test("POST /api/agents/:name/preview → 200, forwards name and config", async () => {
  let called: [string, unknown] | null = null
  const deps = fakeDeps({
    previewAgentChange: async (name, config) => {
      called = [name, config]
      return { id: "prev-1", before: null, after: config as any, classification: { tier: "restart", fullRestart: ["+agent:qa"] } }
    },
  })
  const res = await handleWebRequest(post("/api/agents/qa/preview", { config: { emoji: "🤖" } }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual(["qa", { emoji: "🤖" }])
  expect(await res.json()).toEqual({ id: "prev-1", before: null, after: { emoji: "🤖" }, classification: { tier: "restart", fullRestart: ["+agent:qa"] } })
})

test("POST /api/agents/:name/confirm → 200 on applied, forwards id, hard, and the caller's email as actor", async () => {
  let called: [string, string, boolean, string] | null = null
  const deps = fakeDeps({
    confirmAgentChange: async (name, id, hard, actor) => { called = [name, id, hard, actor]; return { state: "applied", restarted: [], fullRestart: [] } },
  })
  const res = await handleWebRequest(post("/api/agents/qa/confirm", { id: "prev-1", hard: true }, { "x-switchboard-user": "a@b.com" }), deps)
  expect(res.status).toBe(200)
  expect(called).toEqual(["qa", "prev-1", true, "a@b.com"])
  expect(await res.json()).toEqual({ state: "applied", restarted: [], fullRestart: [] })
})

test("POST /api/agents/:name/confirm → 409 on not_found or conflict", async () => {
  const notFound = fakeDeps({ confirmAgentChange: async () => ({ state: "not_found", restarted: [], fullRestart: [] }) })
  const res1 = await handleWebRequest(post("/api/agents/qa/confirm", { id: "x", hard: false }, { "x-switchboard-user": "a@b.com" }), notFound)
  expect(res1.status).toBe(409)

  const conflict = fakeDeps({ confirmAgentChange: async () => ({ state: "conflict", restarted: [], fullRestart: [] }) })
  const res2 = await handleWebRequest(post("/api/agents/qa/confirm", { id: "x", hard: false }, { "x-switchboard-user": "a@b.com" }), conflict)
  expect(res2.status).toBe(409)
})

test("DELETE /api/agents with valid identity header → 405 (known guarded path, wrong method)", async () => {
  const res = await handleWebRequest(del("/api/agents", { "x-switchboard-user": "a@b.com" }), fakeDeps())
  expect(res.status).toBe(405)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/webServer.test.ts`
Expected: FAIL — `listAgents`/`previewAgentChange`/`confirmAgentChange` don't exist on `WebDeps`, the three routes 404.

- [ ] **Step 3: Implement**

In `hub/webServer.ts`:

1. Add `import type { AgentConfig } from "./types"` and `import type { AgentChangeClassification } from "./agentConfigDraft"` to the top imports.
2. Add the three fields to `WebDeps`:

```ts
  listAgents: () => Promise<Record<string, AgentConfig>>
  previewAgentChange: (name: string, config: AgentConfig | null) => Promise<{
    id: string; before: AgentConfig | null; after: AgentConfig | null; classification: AgentChangeClassification
  }>
  confirmAgentChange: (name: string, id: string, hard: boolean, actor: string) => Promise<{
    state: "applied" | "not_found" | "conflict"; restarted: string[]; fullRestart: string[]
  }>
```

3. Add the new route regexes alongside the existing ones:

```ts
  const agentsMatch = path === "/api/agents"
  const agentPreviewMatch = /^\/api\/agents\/([^/]+)\/preview$/.exec(path)
  const agentConfirmMatch = /^\/api\/agents\/([^/]+)\/confirm$/.exec(path)
```

4. Add them to `isGuardedRoute`:

```ts
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch ||
    agentsMatch || agentPreviewMatch || agentConfirmMatch
```

5. Add the three handlers, after the existing `commandMatch` block and before the final `return new Response("method", { status: 405 })`:

```ts
    if (method === "GET" && agentsMatch) {
      return json(await deps.listAgents())
    }

    if (method === "POST" && agentPreviewMatch) {
      const body = (await req.json().catch(() => null)) as { config?: AgentConfig | null } | null
      if (body?.config === undefined) return json({ error: "missing_config" }, 400)
      return json(await deps.previewAgentChange(agentPreviewMatch[1], body.config))
    }

    if (method === "POST" && agentConfirmMatch) {
      const body = (await req.json().catch(() => null)) as { id?: string; hard?: boolean } | null
      if (!body?.id) return json({ error: "missing_id" }, 400)
      const result = await deps.confirmAgentChange(agentConfirmMatch[1], body.id, body.hard === true, email)
      return result.state === "applied" ? json(result) : json(result, 409)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/webServer.test.ts`
Expected: PASS (all tests, including the 6 new ones)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: errors remaining only in `hub/index.ts` (Task 4's job, since `startWebServer`'s `webDeps` object won't yet satisfy the extended `WebDeps` interface) — none in `hub/webServer.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add hub/webServer.ts tests/webServer.test.ts
git commit -m "feat(web): GET/POST /api/agents preview+confirm routes"
```

---

### Task 4: `hub/index.ts` — wire it all up

**Files:**
- Modify: `hub/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- No new exports (wiring layer, not unit-tested directly — verified via the full suite + typecheck + a manual smoke check, matching the precedent set by Phase 1's Task 7 and Phase 2's Task 4).

- [ ] **Step 1: Add imports**

Near the existing `import { planReload } from "./configReload"`-style imports (search for `from "./configReload"`), add:

```ts
import { classifyAgentChange, type AgentChangeClassification } from "./agentConfigDraft"
import { AgentConfigPreviewRegistry } from "./agentConfigPreview"
```

Near the top-of-file `CONFIG_DIR` constant (`hub/index.ts:82`), add a sibling path constant:

```ts
const AGENTS_JSON_PATH = join(CONFIG_DIR, "agents.json")
```

- [ ] **Step 2: Construct the preview registry**

Near the existing `const approvalRegistry = new ApprovalRegistry(...)` construction, add:

```ts
let agentPreviewCounter = 0
const agentConfigPreviews = new AgentConfigPreviewRegistry(
  () => Date.now(),
  () => `agentprev-${++agentPreviewCounter}`,
  5 * 60_000,   // 5 minute TTL — a stale preview must be re-generated, not silently confirmed
)
```

Add a periodic sweep, mirroring the existing approval-TTL sweep (search for `approvalRegistry.sweepExpired` to find that exact pattern and place this near it):

```ts
setInterval(() => { agentConfigPreviews.sweepExpired() }, 60_000).unref()
```

- [ ] **Step 3: Add a small helper to read the raw on-disk agent registry**

Add this as a new top-level function, anywhere after `AGENTS_JSON_PATH` is declared:

```ts
/** Read config/agents.json fresh, in its raw on-disk shape — NOT loadConfigs
 *  (which also reads hub.config.json, validates the whole registry, and expands
 *  `~` in every cwd). Phase 3 works with the raw shape end to end so an edit
 *  round-trips exactly: GET returns what's on disk, POST writes back what was
 *  typed, no expansion mismatch ever appears in a diff. */
function readAgentsJson(): AgentRegistry {
  return JSON.parse(readFileSync(AGENTS_JSON_PATH, "utf8")) as AgentRegistry
}

/** Atomically write the full agent registry back to config/agents.json
 *  (temp-file-then-rename, matching the pattern already used for trace.jsonl's
 *  sweep rewrite). */
function writeAgentsJson(registry: AgentRegistry): void {
  const tmp = `${AGENTS_JSON_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(registry, null, 2))
  renameSync(tmp, AGENTS_JSON_PATH)
}
```

- [ ] **Step 4: Extract the safe-field hot-swap helper**

Find the `!reload` branch's line `for (const [name, cfg] of Object.entries(next.agents)) if (agents[name]) agents[name]!.access = cfg.access` (inside `if (/^!reload\b/i.test(trimmed))`, `hub/index.ts:1749` per current line numbers — verify against the actual file). Add a new top-level function near `respawnAgent`:

```ts
/** Hot-swap the one field !reload's safe tier ever applies live: per-agent
 *  access. Shared by the Discord !reload loop (called once per agent) and the
 *  web confirm endpoint (called once for the single agent being edited) so
 *  there's exactly one place this hot-swap logic lives. */
function applySafeAgentFields(name: string, next: AgentConfig): void {
  if (agents[name]) agents[name]!.access = next.access
}
```

Replace the `!reload` branch's inline loop body to call it instead of inlining the assignment:

```ts
    for (const [name, cfg] of Object.entries(next.agents)) applySafeAgentFields(name, cfg)
```

(Behavior-preserving — `applySafeAgentFields` contains exactly the logic that was inline before.)

- [ ] **Step 5: Wire the three new `webDeps` fields**

Find the `webDeps` object construction (search for `runCommand: async` to locate it — it's the last field in the object per Phase 2's wiring). Add three new fields:

```ts
  listAgents: async (): Promise<Record<string, AgentConfig>> => {
    return readAgentsJson()
  },

  previewAgentChange: async (name, config) => {
    const current = readAgentsJson()
    const before = current[name] ?? null
    const classification = classifyAgentChange(name, before, config, hub)
    const preview = agentConfigPreviews.create(name, before, config, classification)
    return { id: preview.id, before: preview.before, after: preview.after, classification: preview.classification }
  },

  confirmAgentChange: async (name, id, hard, actor) => {
    const preview = agentConfigPreviews.consume(id)
    if (!preview || preview.agentName !== name) return { state: "not_found", restarted: [], fullRestart: [] }

    // Drift check: re-read disk fresh and compare against what the preview
    // captured as `before` — if someone else already changed this agent since
    // the preview was generated, refuse rather than silently clobber it.
    const current = readAgentsJson()
    const liveBefore = current[name] ?? null
    if (JSON.stringify(liveBefore) !== JSON.stringify(preview.before)) {
      return { state: "conflict", restarted: [], fullRestart: [] }
    }

    // Write to disk: add/replace/remove this one agent's entry.
    const next = { ...current }
    if (preview.after) next[name] = preview.after
    else delete next[name]
    writeAgentsJson(next)

    const restarted: string[] = []
    if (preview.after) {
      // access is always safe to hot-swap regardless of this edit's overall tier.
      applySafeAgentFields(name, preview.after)
      if (hard && preview.classification.tier === "hard") {
        agents[name] = preview.after
        try { await respawnAgent(name) ; restarted.push(name) }
        catch (e) { process.stderr.write(`agent config confirm: respawn ${name} failed: ${e}\n`) }
      }
    }

    audit.record({
      kind: "event", actor: `web:${actor}`, action: "agent_config_change", target: name, outcome: "ok",
      detail: { before: preview.before, after: preview.after, classification: preview.classification },
    })

    return { state: "applied", restarted, fullRestart: preview.classification.fullRestart }
  },
```

(`actor` here is the operator's email, threaded through from `hub/webServer.ts`'s route handler — which resolved it via `deps.requireUser(req)` — through `WebDeps.confirmAgentChange`'s fourth parameter per Task 3. This matches the `web:<email>` actor convention every other web-originated audit event in this codebase already uses, e.g. `resolveApproval`'s `web:${actor}` from Phase 1.)

- [ ] **Step 6: Switch `startWebServer`'s call to include the new deps**

The `webDeps` object from Step 5 is part of the same object literal already passed to `startWebServer(hub.webPort ?? 0, webDeps, hub.webHost)` — no separate change needed here beyond Step 5 actually landing inside that object literal.

- [ ] **Step 7: Run the full hub test suite**

Run: `bun test`
Expected: PASS — all tests from Tasks 1-3 plus every existing test, with exactly 1 pre-existing failure (`tests/config.test.ts:8` `expandHome` on Windows, unrelated).

- [ ] **Step 8: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 9: Manual smoke test**

If a real Discord token/config is available: `bun run hub`, confirm it boots, then `curl -H 'X-Switchboard-User: test@example.com' localhost:8080/api/agents` returns the real agent registry JSON. If no live token is available in this environment, confirm as much as possible statically (tsc + full suite) and note which verification level was achieved, matching the fallback already established in Phase 1/2's equivalent wiring tasks.

- [ ] **Step 10: Commit**

```bash
git add hub/index.ts
git commit -m "feat(agents): wire agent config preview/confirm into the running hub"
```

---

### Task 5: `hub/web.ts` — Edit/Remove/+New Agent UI

**Files:**
- Modify: `hub/web.ts`
- Modify: `hub/web.test.ts`

**Interfaces:**
- Consumes: `GET /api/agents`, `POST /api/agents/:name/preview`, `POST /api/agents/:name/confirm` (Tasks 3-4).
- No new exports — this is the dashboard's static HTML/JS template string.

- [ ] **Step 1: Write the failing test**

Append to `hub/web.test.ts`:

```ts
test("the dashboard HTML has agent-config edit affordances and a JSON editor panel", () => {
  expect(DASHBOARD_HTML).toContain('id="newAgentBtn"')
  expect(DASHBOARD_HTML).toContain('id="agentEditor"')
  expect(DASHBOARD_HTML).toContain('id="agentEditorText"')
  expect(DASHBOARD_HTML).toContain("api/agents")
  expect(DASHBOARD_HTML).toContain("/preview")
  expect(DASHBOARD_HTML).toContain("/confirm")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/web.test.ts`
Expected: FAIL — none of these markers exist yet.

- [ ] **Step 3: Add the "+ New Agent" button and Edit/Remove links to the Agents table**

Find the Agents `<section>` (search for `<h2>Agents</h2>`). Add a button right after the `<h2>`:

```html
<h2>Agents <button id="newAgentBtn" type="button">+ New Agent</button></h2>
```

Find the Agents-table row-rendering code (search for `$('agents').innerHTML=d.agents.map`). Add an Edit and Remove link/button to each row, inside the closing `</td>` cells — extend the returned row string to add one more `<td>`:

```js
  $('agents').innerHTML=d.agents.map(function(a){
    var pct=Math.round(a.contextFill*100);
    return '<tr><td><span class="dot '+(a.alive?'alive':'dead')+'"></span></td>'+
      '<td>'+esc(a.name)+'</td><td class="muted">'+(a.busy?'busy':'idle')+'</td>'+
      '<td><div class="bar"><i style="width:'+pct+'%"></i></div> '+pct+'%</td>'+
      '<td>'+a.queueDepth+'</td><td>$'+a.costUsd.toFixed(4)+'</td><td>'+a.replicas+'</td>'+
      '<td><button data-edit-agent="'+esc(a.name)+'">Edit</button> <button data-remove-agent="'+esc(a.name)+'">Remove</button></td></tr>';
  }).join('') || '<tr><td colspan="8" class="muted">no agents</td></tr>';
```

(Note the `colspan` on the empty-state row goes from 7 to 8, matching the one new column. Also update the table's `<thead>` — find `<tr><th></th><th>agent</th>...<th>replicas</th></tr>` and add `<th></th>` at the end for the new column.)

- [ ] **Step 4: Add the editor panel markup**

Add a new `<section>` after the Agents table's closing `</section>` (before the "Approvals" section):

```html
<section id="agentEditor" style="display:none">
  <h2 id="agentEditorTitle">Edit agent</h2>
  <textarea id="agentEditorText" rows="16" style="width:100%;background:#1a1d24;border:1px solid #232733;color:#e6e6e6;padding:8px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
  <div style="margin-top:8px">
    <button id="agentPreviewBtn" type="button">Preview</button>
    <button id="agentEditorCancel" type="button">Cancel</button>
  </div>
  <div id="agentDiff" class="muted" style="margin-top:8px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px"></div>
  <div id="agentConfirmRow" style="margin-top:8px"></div>
</section>
```

- [ ] **Step 5: Add the editor JS**

Add near the other section-specific JS (after the command-button/mode-toggle logic). This is a self-contained block — plain `function(){}`/`var` throughout, matching the file's established style:

```js
var editingAgentName = null;
var lastPreviewId = null;

function openAgentEditor(name, template){
  editingAgentName = name;
  lastPreviewId = null;
  $('agentEditorTitle').textContent = name ? ('Edit agent: '+name) : 'New agent';
  $('agentEditorText').value = template;
  $('agentDiff').textContent = '';
  $('agentConfirmRow').innerHTML = '';
  $('agentEditor').style.display = 'block';
}

document.getElementById('newAgentBtn').addEventListener('click', function(){
  var name = prompt('New agent name:');
  if (!name) return;
  var template = JSON.stringify({
    emoji: "🤖", description: "", mode: "ephemeral",
    access: { roles: [] }, runtime: { cwd: "~" },
  }, null, 2);
  openAgentEditor(name, template);
});

document.addEventListener('click', function(ev){
  var editBtn = ev.target.closest('[data-edit-agent]');
  if (editBtn) {
    var name = editBtn.getAttribute('data-edit-agent');
    fetch('api/agents').then(function(r){ return r.json(); }).then(function(all){
      openAgentEditor(name, JSON.stringify(all[name], null, 2));
    });
    return;
  }
  var removeBtn = ev.target.closest('[data-remove-agent]');
  if (removeBtn) {
    var rname = removeBtn.getAttribute('data-remove-agent');
    editingAgentName = rname;
    lastPreviewId = null;
    $('agentEditorTitle').textContent = 'Remove agent: '+rname;
    $('agentEditorText').value = '';
    $('agentEditorText').style.display = 'none';
    $('agentDiff').textContent = '';
    $('agentConfirmRow').innerHTML = '';
    $('agentEditor').style.display = 'block';
    fetch('api/agents/'+rname+'/preview', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({config: null}),
    }).then(function(r){ return r.json(); }).then(renderAgentPreview);
    return;
  }
});

document.getElementById('agentEditorCancel').addEventListener('click', function(){
  $('agentEditor').style.display = 'none';
  $('agentEditorText').style.display = 'block';
});

document.getElementById('agentPreviewBtn').addEventListener('click', function(){
  var parsed;
  try { parsed = JSON.parse($('agentEditorText').value); }
  catch (e) { $('agentDiff').textContent = 'invalid JSON: '+e.message; return; }
  fetch('api/agents/'+editingAgentName+'/preview', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({config: parsed}),
  }).then(function(r){ return r.json(); }).then(renderAgentPreview);
});

function renderAgentPreview(p){
  lastPreviewId = p.id;
  var beforeStr = p.before ? JSON.stringify(p.before, null, 2) : '(new agent)';
  var afterStr = p.after ? JSON.stringify(p.after, null, 2) : '(removed)';
  $('agentDiff').textContent = 'BEFORE:\n'+beforeStr+'\n\nAFTER:\n'+afterStr+'\n\nCLASSIFICATION: '+p.classification.tier+
    (p.classification.fullRestart.length ? ' ('+p.classification.fullRestart.join(', ')+')' : '');
  var row = $('agentConfirmRow');
  row.innerHTML = '';
  if (p.classification.tier === 'restart') {
    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save to disk (needs a full restart to take effect)';
    saveBtn.setAttribute('data-confirm-hard', 'false');
    row.appendChild(saveBtn);
  } else {
    var applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.setAttribute('data-confirm-hard', 'false');
    row.appendChild(applyBtn);
    if (p.classification.tier === 'hard') {
      var hardBtn = document.createElement('button');
      hardBtn.textContent = 'Apply + restart this agent';
      hardBtn.setAttribute('data-confirm-hard', 'true');
      row.appendChild(hardBtn);
    }
  }
}

document.addEventListener('click', function(ev){
  var btn = ev.target.closest('#agentConfirmRow [data-confirm-hard]');
  if (!btn || !lastPreviewId) return;
  var hard = btn.getAttribute('data-confirm-hard') === 'true';
  fetch('api/agents/'+editingAgentName+'/confirm', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({id: lastPreviewId, hard: hard}),
  }).then(function(r){ return r.json(); }).then(function(result){
    $('agentDiff').textContent += '\n\nRESULT: '+JSON.stringify(result);
    $('agentConfirmRow').innerHTML = '';
    lastPreviewId = null;
    loadAgentsAfterConfirm();
  });
});

function loadAgentsAfterConfirm(){
  // The next poll() cycle (every 3s) refreshes the Agents table from
  // /api/status automatically — nothing more to do here.
}
```

(The `openAgentEditor` helper resets `$('agentEditorText').style.display` back to `'block'` implicitly via `openAgentEditor` not touching it — but the Remove flow explicitly hides it. Verify `agentEditorCancel`'s handler restores it for the next Edit/New open, as written above.)

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test hub/web.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite + typecheck**

Run: `bun test` — expect the 1 pre-existing failure only.
Run: `bunx tsc --noEmit` — expect 0 errors.

- [ ] **Step 8: Commit**

```bash
git add hub/web.ts hub/web.test.ts
git commit -m "feat(web): agent config edit/remove/create UI (JSON editor + preview/confirm)"
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
Confirm clean boot: `ssh readyapp-newvps "tail -10 /home/ubuntu/.pm2/logs/switchboard-hub-error.log"` shows `gateway connected` / `web dashboard on 127.0.0.1:8080` with no crash, and `pm2 describe switchboard-hub` shows `status: online` with a fresh `uptime`.

- [ ] **Step 3: Manual verification against the live hub**

```bash
ssh readyapp-newvps "curl -s -H 'X-Switchboard-User: test@example.com' localhost:8080/api/agents | head -c 500"
```
Confirm it returns the real agent registry JSON (not an error).

In the browser, as an allowlisted user: click "Edit" on an existing agent, confirm the textarea pre-fills with its current config; change something cosmetic (e.g. `description`), click Preview, confirm the diff shows and classification reads `restart` with `unapplied:description`; click "Save to disk" and confirm the response reports success with no live process restart. Separately: edit an agent's `access.roles` only, Preview, confirm classification reads `safe`, click Apply, confirm it applies without any respawn. **Do not test add/remove or a `hard`-tier respawn against a real production agent during this verification** — those are real operational actions (a full restart requirement, or killing/respawning a live persistent agent process) and should be tested against a throwaway/non-critical agent name first, or deferred to a maintenance window, at Aurora's discretion.

- [ ] **Step 4: Note follow-ups for whoever picks this up next**

Phase 4 (hub-level config editing, e.g. `routerModel`/`contextWindows`/`commands`/`directCommands`) reuses this phase's preview/confirm plumbing (`classifyAgentChange`'s sibling would be a `classifyHubChange` following the same pattern, and the same `AgentConfigPreviewRegistry` shape generalizes). The "unapplied fields" gap in `!reload` itself (§1 of the design spec) remains unfixed by design — a legitimate future enhancement to `!reload`'s own safe-apply logic, not this phase's scope.
