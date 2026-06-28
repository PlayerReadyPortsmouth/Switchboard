# publish_link Producer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flag-gated Switchboard agent tool `publish_link` that writes a contract-conforming artifact (`<ARTIFACTS_DIR>/<token>/{file, meta.sbmd}`) from the agent's outbox and returns the staff-only Entra URL `https://<RA_HOST>/share/<token>`, plus a cleanup sweep for expired artifacts.

**Architecture:** Mirrors the shipped `attach_file` feature (outbox containment via `resolveOutboxFile`, `PUBLISH_LINK=1` injected through `buildShimMcpConfig`), but is **request/response** (like `recall`) so the agent gets the URL back. A pure `publishLink.ts` core (injected fs + token/now) builds the `.sbmd` and writes atomically; a pure `selectExpired` drives a periodic sweep.

**Tech Stack:** TypeScript, Bun (`bun:test`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-28-publish-link-producer-design.md` and the contract `ReadyApp/.../2026-06-28-entra-share-links-contract-design.md`.
- **`.sbmd` shape** (contract, exact): `{ v:1, mode:"download"|"page"|"view", contentType, filename(basename), title, scope("staff"|<perm>), createdAt(ISO), expiresAt(ISO), producer:"agent:<name>" }`.
- **Flag, default off:** `hub.shareLinks.enabled`. Off ⇒ tool not listed AND a stray `publish` frame ignored (double-gate). Behaviour byte-identical when off.
- **Containment:** reuse `resolveOutboxFile` — an agent publishes only a file in its own outbox; agent identity from the transport, never the frame.
- **Atomic write:** write to `<token>.tmp/` then rename to `<token>/` (a reader never sees a half-written artifact).
- **Token:** `crypto.randomBytes(16)` → base62 (`[0-9A-Za-z]`); injected for tests. No `Math.random`.
- **TDZ lesson:** `publishEnabled`/`shareLinks`-derived consts referenced inside `makeTransport` MUST be declared BEFORE the top-level persistent-agent spawn loop (`hub/index.ts:808` area).
- **Per task:** `bun test <file>` + `bunx tsc --noEmit`. Known-green baseline: `bun test` = 1 pre-existing fail (`tests/config.test.ts:8`); `bunx tsc --noEmit` = 2 pre-existing errors (`hub/index.ts`). No new beyond those.

---

### Task 1: Publish core (`hub/publishLink.ts`)

**Files:**
- Create: `hub/publishLink.ts`
- Test: `hub/publishLink.test.ts`

**Interfaces:**
- Consumes: `resolveOutboxFile` (`./outboxAttach` — returns `{ ok, absPath, filename, size, bytes }` / `{ ok:false, reason }`).
- Produces:
  - `interface Sbmd { v: number; mode: "download"|"page"|"view"; contentType: string; filename: string; title: string; scope: string; createdAt: string; expiresAt: string; producer: string }`
  - `function inferModeAndType(filename: string): { mode: "download"|"page"|"view"; contentType: string }`
  - `interface PublishArgs { path: string; mode?: string; title?: string; scope?: string; ttlDays?: number }`
  - `interface PublishOpts { artifactsDir: string; raHost: string; agent: string; outboxBase: string; maxBytes: number; defaultTtlDays: number; now: Date; randomToken: () => string }`
  - `interface PublishIO { mkdir: (dir: string) => void; writeFile: (p: string, data: Buffer|string) => void; rename: (from: string, to: string) => void }`
  - `type PublishResult = { ok: true; url: string; token: string } | { ok: false; reason: string }`
  - `function publishArtifact(args: PublishArgs, opts: PublishOpts, io: PublishIO): PublishResult`

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/publishLink.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { inferModeAndType, publishArtifact, type PublishOpts, type PublishIO } from "./publishLink"

test("inferModeAndType maps extensions to mode + contentType", () => {
  expect(inferModeAndType("a.pdf")).toEqual({ mode: "view", contentType: "application/pdf" })
  expect(inferModeAndType("a.html")).toEqual({ mode: "page", contentType: "text/html" })
  expect(inferModeAndType("a.md")).toEqual({ mode: "view", contentType: "text/markdown" })
  expect(inferModeAndType("a.csv")).toEqual({ mode: "view", contentType: "text/csv" })
  expect(inferModeAndType("a.bin")).toEqual({ mode: "download", contentType: "application/octet-stream" })
})

function outbox(agent: string, file: string, content = "DATA") {
  const base = mkdtempSync(join(tmpdir(), "pub-outbox-"))
  mkdirSync(join(base, agent), { recursive: true })
  writeFileSync(join(base, agent, file), content)
  return base
}
function spyIo() {
  const calls: { mkdir: string[]; writeFile: { p: string; data: string }[]; rename: [string, string][] } = { mkdir: [], writeFile: [], rename: [] }
  const io: PublishIO = {
    mkdir: (d) => calls.mkdir.push(d),
    writeFile: (p, data) => calls.writeFile.push({ p, data: data.toString() }),
    rename: (f, t) => calls.rename.push([f, t]),
  }
  return { io, calls }
}
const opts = (over: Partial<PublishOpts> = {}): PublishOpts => ({
  artifactsDir: "/art", raHost: "ra.example", agent: "ada", outboxBase: "/x",
  maxBytes: 1_000_000, defaultTtlDays: 30, now: new Date("2026-06-28T00:00:00Z"),
  randomToken: () => "TOKEN123456789012345", ...over,
})

test("publishArtifact: writes file + .sbmd to a tmp dir, renames atomically, returns the URL", () => {
  const base = outbox("ada", "report.pdf")
  const { io, calls } = spyIo()
  const r = publishArtifact({ path: "report.pdf" }, opts({ outboxBase: base }), io)
  expect(r).toEqual({ ok: true, url: "https://ra.example/share/TOKEN123456789012345", token: "TOKEN123456789012345" })
  // atomic: mkdir <token>.tmp, write both files into it, then rename .tmp → <token>
  expect(calls.mkdir).toEqual([join("/art", "TOKEN123456789012345.tmp")])
  expect(calls.writeFile.map((w) => w.p)).toEqual([join("/art", "TOKEN123456789012345.tmp", "report.pdf"), join("/art", "TOKEN123456789012345.tmp", "meta.sbmd")])
  expect(calls.rename).toEqual([[join("/art", "TOKEN123456789012345.tmp"), join("/art", "TOKEN123456789012345")]])
  // .sbmd content
  const sbmd = JSON.parse(calls.writeFile[1].data)
  expect(sbmd).toMatchObject({ v: 1, mode: "view", contentType: "application/pdf", filename: "report.pdf", title: "report.pdf", scope: "staff", producer: "agent:ada", createdAt: "2026-06-28T00:00:00.000Z", expiresAt: "2026-07-28T00:00:00.000Z" })
})

test("publishArtifact: explicit mode/title/scope/ttl override the defaults", () => {
  const base = outbox("ada", "data.csv")
  const { io, calls } = spyIo()
  const r = publishArtifact({ path: "data.csv", mode: "download", title: "Q2 export", scope: "finance.read", ttlDays: 7 }, opts({ outboxBase: base }), io)
  expect(r.ok).toBe(true)
  const sbmd = JSON.parse(calls.writeFile[1].data)
  expect(sbmd).toMatchObject({ mode: "download", title: "Q2 export", scope: "finance.read", contentType: "text/csv", expiresAt: "2026-07-05T00:00:00.000Z" })
})

test("publishArtifact: an outbox escape is rejected with the reason, nothing written", () => {
  const base = outbox("ada", "report.pdf")
  const { io, calls } = spyIo()
  const r = publishArtifact({ path: "../secret" }, opts({ outboxBase: base }), io)
  expect(r).toEqual({ ok: false, reason: "escape" })
  expect(calls.writeFile).toEqual([])
  expect(calls.rename).toEqual([])
})

test("publishArtifact: an invalid explicit mode falls back to the inferred mode", () => {
  const base = outbox("ada", "report.pdf")
  const { io, calls } = spyIo()
  publishArtifact({ path: "report.pdf", mode: "bogus" }, opts({ outboxBase: base }), io)
  expect(JSON.parse(calls.writeFile[1].data).mode).toBe("view")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/publishLink.test.ts`
Expected: FAIL — `Cannot find module './publishLink'`.

- [ ] **Step 3: Implement**

```typescript
// hub/publishLink.ts
import { resolveOutboxFile } from "./outboxAttach"
import { join, extname } from "path"

export interface Sbmd {
  v: number; mode: "download" | "page" | "view"; contentType: string; filename: string;
  title: string; scope: string; createdAt: string; expiresAt: string; producer: string
}

const MIME: Record<string, { type: string; mode: "download" | "page" | "view" }> = {
  pdf: { type: "application/pdf", mode: "view" },
  html: { type: "text/html", mode: "page" }, htm: { type: "text/html", mode: "page" },
  md: { type: "text/markdown", mode: "view" }, csv: { type: "text/csv", mode: "view" },
  txt: { type: "text/plain", mode: "view" },
  png: { type: "image/png", mode: "view" }, jpg: { type: "image/jpeg", mode: "view" },
  jpeg: { type: "image/jpeg", mode: "view" }, gif: { type: "image/gif", mode: "view" },
  webp: { type: "image/webp", mode: "view" },
}

export function inferModeAndType(filename: string): { mode: "download" | "page" | "view"; contentType: string } {
  const ext = extname(filename).replace(/^\./, "").toLowerCase()
  const m = MIME[ext]
  return m ? { mode: m.mode, contentType: m.type } : { mode: "download", contentType: "application/octet-stream" }
}

export interface PublishArgs { path: string; mode?: string; title?: string; scope?: string; ttlDays?: number }
export interface PublishOpts {
  artifactsDir: string; raHost: string; agent: string; outboxBase: string;
  maxBytes: number; defaultTtlDays: number; now: Date; randomToken: () => string
}
export interface PublishIO {
  mkdir: (dir: string) => void
  writeFile: (p: string, data: Buffer | string) => void
  rename: (from: string, to: string) => void
}
export type PublishResult = { ok: true; url: string; token: string } | { ok: false; reason: string }

const MODES = new Set(["download", "page", "view"])
const DAY_MS = 86_400_000

export function publishArtifact(args: PublishArgs, opts: PublishOpts, io: PublishIO): PublishResult {
  const r = resolveOutboxFile(args.path, {
    outboxBase: opts.outboxBase, agent: opts.agent, maxBytes: opts.maxBytes, allowedExtensions: [],
  })
  if (!r.ok) return { ok: false, reason: r.reason }

  const inferred = inferModeAndType(r.filename)
  const mode = (args.mode && MODES.has(args.mode) ? args.mode : inferred.mode) as Sbmd["mode"]
  const ttlDays = typeof args.ttlDays === "number" && args.ttlDays > 0 ? args.ttlDays : opts.defaultTtlDays
  const token = opts.randomToken()
  const sbmd: Sbmd = {
    v: 1, mode, contentType: inferred.contentType, filename: r.filename,
    title: args.title || r.filename, scope: args.scope || "staff",
    createdAt: opts.now.toISOString(),
    expiresAt: new Date(opts.now.getTime() + ttlDays * DAY_MS).toISOString(),
    producer: `agent:${opts.agent}`,
  }
  const tmp = join(opts.artifactsDir, `${token}.tmp`)
  const finalDir = join(opts.artifactsDir, token)
  try {
    io.mkdir(tmp)
    io.writeFile(join(tmp, r.filename), r.bytes)
    io.writeFile(join(tmp, "meta.sbmd"), JSON.stringify(sbmd))
    io.rename(tmp, finalDir)
  } catch { return { ok: false, reason: "write_failed" } }
  return { ok: true, url: `https://${opts.raHost}/share/${token}`, token }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/publishLink.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors). Then:
```bash
git add hub/publishLink.ts hub/publishLink.test.ts
git commit -m "feat(publish-link): publishArtifact core (outbox containment + atomic .sbmd write)"
```

---

### Task 2: Cleanup selection (`hub/publishCleanup.ts`)

**Files:**
- Create: `hub/publishCleanup.ts`
- Test: `hub/publishCleanup.test.ts`

**Interfaces:**
- Produces: `function selectExpired(entries: { token: string; expiresAt?: string; ageMs?: number }[], now: Date, graceMs: number): string[]`

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/publishCleanup.test.ts
import { test, expect } from "bun:test"
import { selectExpired } from "./publishCleanup"

const NOW = new Date("2026-06-28T00:00:00Z")

test("selects tokens whose expiresAt is past", () => {
  expect(selectExpired([
    { token: "a", expiresAt: "2026-06-01T00:00:00Z" },   // past
    { token: "b", expiresAt: "2026-12-01T00:00:00Z" },   // future
  ], NOW, 3_600_000)).toEqual(["a"])
})

test("reaps an unreadable .sbmd dir only past the grace period", () => {
  expect(selectExpired([
    { token: "old", ageMs: 7_200_000 },   // 2h old, grace 1h → reap
    { token: "new", ageMs: 60_000 },      // 1m old → keep
  ], NOW, 3_600_000)).toEqual(["old"])
})

test("ignores a malformed expiresAt (keeps it)", () => {
  expect(selectExpired([{ token: "x", expiresAt: "not-a-date" }], NOW, 3_600_000)).toEqual([])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/publishCleanup.test.ts`
Expected: FAIL — `Cannot find module './publishCleanup'`.

- [ ] **Step 3: Implement**

```typescript
// hub/publishCleanup.ts
/** Tokens to remove: those whose `.sbmd` expiresAt is past, plus dirs whose
 *  `.sbmd` was unreadable (no expiresAt) and that are older than `graceMs`
 *  (abandoned mid-write or corrupt). Pure. */
export function selectExpired(
  entries: { token: string; expiresAt?: string; ageMs?: number }[],
  now: Date,
  graceMs: number,
): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.expiresAt) {
      const t = Date.parse(e.expiresAt)
      if (Number.isFinite(t) && now.getTime() > t) out.push(e.token)
    } else if (typeof e.ageMs === "number" && e.ageMs > graceMs) {
      out.push(e.token)
    }
  }
  return out
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/publishCleanup.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors). Then:
```bash
git add hub/publishCleanup.ts hub/publishCleanup.test.ts
git commit -m "feat(publish-link): selectExpired — cleanup-sweep selection"
```

---

### Task 3: Agent tool (`shim/server.ts`)

Add the `publish_link` tool (env-gated), its `toolCallToWire` mapping, and the request/response handling (it awaits the hub's `publish_result`).

**Files:**
- Modify: `shim/server.ts`
- Test: `shim/server.test.ts`

**Interfaces:**
- Produces: `publish_link(path, mode?, title?, scope?, ttl_days?)` → wire `{ t:"publish", id, path, mode, title, scope, ttlDays }`; returns the URL text.

- [ ] **Step 1: Write the failing test** (add to `shim/server.test.ts`)

```typescript
test("publish_link maps to a publish wire message", () => {
  expect(toolCallToWire("publish_link", { path: "r.pdf", mode: "view", title: "R", scope: "staff", ttl_days: 7 }))
    .toEqual({ t: "publish", path: "r.pdf", mode: "view", title: "R", scope: "staff", ttlDays: 7 })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test shim/server.test.ts`
Expected: FAIL — `toolCallToWire("publish_link", …)` returns `null` (default), not the object.

- [ ] **Step 3: Add the wire mapping**

In `shim/server.ts` `toolCallToWire` (beside `attach_file`):
```typescript
    case "publish_link":
      return { t: "publish", path: args.path, mode: args.mode, title: args.title, scope: args.scope, ttlDays: args.ttl_days }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test shim/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the request/response handling + tool listing**

In the `CallToolRequestSchema` handler (beside the `recall` request/response block), add — BEFORE the generic `toolCallToWire` fire-and-forget path:
```typescript
    if (req.params.name === "publish_link") {
      const id = `p${++reqCounter}`
      const result = await new Promise<{ url?: string; error?: string }>((resolve) => {
        pendingPublish.set(id, resolve)
        sock.write(encode({ t: "publish", id, path: args.path, mode: args.mode, title: args.title, scope: args.scope, ttlDays: args.ttl_days }))
        const timer = setTimeout(() => { if (pendingPublish.delete(id)) resolve({ error: "timed out" }) }, 30000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      const text = result.url ? `Published: ${result.url}` : `publish failed: ${result.error ?? "unknown"}`
      return { content: [{ type: "text", text }] }
    }
```
Add the `pendingPublish` map beside the existing `pending`/`pendingAsk` maps:
```typescript
const pendingPublish = new Map<string, (r: { url?: string; error?: string }) => void>()
```
And in the socket `data` handler (beside `recall_result`/`ask_agent_result`):
```typescript
          } else if (m.t === "publish_result" && m.id && pendingPublish.has(m.id)) {
            pendingPublish.get(m.id)!({ url: m.url, error: m.error }); pendingPublish.delete(m.id)
```
Append the tool to the `ListToolsRequestSchema` tools array, gated like `attach_file`:
```typescript
      ...(process.env.PUBLISH_LINK === "1" ? [{
        name: "publish_link",
        description: "Publish a file you produced (write it into your outbox first) to a staff-only Entra-gated URL and get the link back. Use for artifacts too big or unviewable as Discord attachments (PDF statements, rendered HTML dashboards, large CSVs, markdown reports). `mode`: download | page (live HTML) | view (pretty pdf/markdown/csv); inferred from the file type if omitted. `scope`: \"staff\" (default) or an RA permission string for sensitive data. `ttl_days`: link lifetime (default 30).",
        inputSchema: { type: "object", properties: {
          path: { type: "string", description: "Path relative to your outbox." },
          mode: { type: "string", enum: ["download", "page", "view"] },
          title: { type: "string" },
          scope: { type: "string", description: "\"staff\" or an RA permission string." },
          ttl_days: { type: "number" } },
          required: ["path"] },
      }] : []),
```

- [ ] **Step 6: Re-run tests + typecheck**

Run: `bun test shim/server.test.ts && bunx tsc --noEmit`
Expected: PASS; no new tsc errors.

- [ ] **Step 7: Commit**

```bash
git add shim/server.ts shim/server.test.ts
git commit -m "feat(publish-link): publish_link MCP tool (request/response) + wire mapping"
```

---

### Task 4: Shim-socket frame + env gating (`hub/transports/shimSocket.ts`, `hub/transports/streamJsonFraming.ts`, `hub/transports/streamJson.ts`)

**Files:**
- Modify: `hub/transports/shimSocket.ts` (`onPublish` request/response callback + `publish` dispatch)
- Modify: `hub/transports/streamJsonFraming.ts` (`buildShimMcpConfig` gains `publishEnabled` → `PUBLISH_LINK=1`)
- Modify: `hub/transports/streamJson.ts` (`publishEnabled?` opt + pass to `buildShimMcpConfig`)
- Test: `hub/transports/streamJsonFraming.test.ts` (the env injection)

**Interfaces:**
- Produces: `onPublish(cb: (a: { path: string; mode?: string; title?: string; scope?: string; ttlDays?: number }) => Promise<{ url?: string; error?: string }>)` on `ShimSocketServer`; `buildShimMcpConfig(..., publishEnabled)`.

- [ ] **Step 1: Write the failing test** (add to `hub/transports/streamJsonFraming.test.ts`)

```typescript
test("publishEnabled injects PUBLISH_LINK=1 into the shim MCP env", () => {
  const env = buildShimMcpConfig("/shim.ts", "/sock", "ada", false, false, true)
    .mcpServers["switchboard-shim"].env as Record<string, string>
  expect(env.PUBLISH_LINK).toBe("1")
})
```
(The current `buildShimMcpConfig` signature is `(shimPath, socketPath, agentName, consultEnabled=false, attachEnabled=false)`. Add `publishEnabled=false` as the 6th param.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test hub/transports/streamJsonFraming.test.ts`
Expected: FAIL — `PUBLISH_LINK` undefined (6th param not handled).

- [ ] **Step 3: Implement the env injection**

In `hub/transports/streamJsonFraming.ts` `buildShimMcpConfig`, add the param + env spread (beside the `attachEnabled` one):
```typescript
export function buildShimMcpConfig(shimPath: string, socketPath: string, agentName: string, consultEnabled = false, attachEnabled = false, publishEnabled = false) {
  return {
    mcpServers: {
      "switchboard-shim": {
        command: "bun", args: ["run", shimPath],
        env: {
          HUB_SOCKET: socketPath, AGENT_NAME: agentName,
          ...(consultEnabled ? { CONSULT: "1" } : {}),
          ...(attachEnabled ? { ATTACH_FILES: "1" } : {}),
          ...(publishEnabled ? { PUBLISH_LINK: "1" } : {}),
        },
      },
    },
  }
}
```

- [ ] **Step 4: Add the `onPublish` callback + dispatch** (`hub/transports/shimSocket.ts`)

Add the field beside `recallCb` (~line 25):
```typescript
  private publishCb: (a: { path: string; mode?: string; title?: string; scope?: string; ttlDays?: number }) => Promise<{ url?: string; error?: string }> = async () => ({})
```
Add the setter beside `onRecall` (~line 39):
```typescript
  onPublish(cb: typeof this.publishCb) { this.publishCb = cb }
```
Add the dispatch case beside `recall` (in the `switch (m.t)` block):
```typescript
      case "publish":
        void this.publishCb({ path: m.path, mode: m.mode, title: m.title, scope: m.scope, ttlDays: m.ttlDays }).then((res) => {
          try { socket.write(encode({ t: "publish_result", id: m.id, url: res.url, error: res.error })) } catch {}
        })
        break
```

- [ ] **Step 5: Thread `publishEnabled` through the transport** (`hub/transports/streamJson.ts`)

Add the opt beside `attachEnabled?`:
```typescript
  /** Expose the publish_link share-links tool to this agent (PUBLISH_LINK=1). */
  publishEnabled?: boolean
```
Pass it to `buildShimMcpConfig` (where `consultEnabled, attachEnabled` are passed):
```typescript
    write(mcpConfigPath, JSON.stringify(buildShimMcpConfig(shimPath, socketPath, this.name, this.opts.consultEnabled, this.opts.attachEnabled, this.opts.publishEnabled)))
```

- [ ] **Step 6: Typecheck + tests**

Run: `bunx tsc --noEmit` (no new errors) and `bun test hub/transports/streamJsonFraming.test.ts` (green).

- [ ] **Step 7: Commit**

```bash
git add hub/transports/shimSocket.ts hub/transports/streamJsonFraming.ts hub/transports/streamJsonFraming.test.ts hub/transports/streamJson.ts
git commit -m "feat(publish-link): shim-socket onPublish frame + PUBLISH_LINK env gating"
```

---

### Task 5: Config + hub wiring (`hub/types.ts`, `hub/config.ts`, `hub/index.ts`)

Construct the publish deps, wire `onPublish`, the cleanup sweep, and the transport opt — all gated, declared before the spawn loop.

**Files:**
- Modify: `hub/types.ts` (`ShareLinksConfig` + `HubConfig.shareLinks?`)
- Modify: `hub/config.ts` (expandHome `artifactsDir`)
- Modify: `hub/index.ts` (imports, gate const, transport opt, `onPublish` wiring, cleanup sweep)

**Interfaces:**
- Consumes: `publishArtifact`/`PublishIO` (Task 1), `selectExpired` (Task 2), `onPublish` (Task 4), `resolveOutboxFile`'s `outboxBase` (= the same `<stateDir>/outbox` the attach feature uses), `expandHome`.

- [ ] **Step 1: Config type** (`hub/types.ts`)

Add to `HubConfig` (next to `outboundAttachments?`):
```typescript
  shareLinks?: ShareLinksConfig  // publish_link: agents publish staff-only Entra-gated artifact URLs (default off)
```
And the interface (next to `OutboundAttachmentConfig`):
```typescript
/** publish_link producer. Absent/disabled ⇒ the tool is not offered and a stray
 *  publish frame is ignored (byte-identical). Writes <artifactsDir>/<token>/ for
 *  the RA /share renderer; agents publish from their own outbox. */
export interface ShareLinksConfig {
  enabled?: boolean
  artifactsDir?: string          // shared with the RA renderer (default <stateDir>/share-artifacts)
  raHost?: string                // default "readyapp.player-ready.co.uk"
  defaultTtlDays?: number        // default 30
  maxBytes?: number              // default 26214400 (25 MB)
  cleanupIntervalMs?: number     // default 86400000 (daily)
}
```

- [ ] **Step 2: Normalise the artifacts dir** (`hub/config.ts`)

After the existing `expandHome` lines (where `outboundAttachments.outboxDir` is expanded):
```typescript
  if (hub.shareLinks?.artifactsDir) hub.shareLinks.artifactsDir = expandHome(hub.shareLinks.artifactsDir)
```

- [ ] **Step 3: Imports + gate const (BEFORE the spawn loop)** (`hub/index.ts`)

Add imports near the other hub imports:
```typescript
import { publishArtifact } from "./publishLink"
import { selectExpired } from "./publishCleanup"
import { randomBytes } from "crypto"
```
Immediately after `const pools = new Map<...>()` (just BEFORE the persistent-agent `for` loop ~line 808 — the TDZ-safe spot used for `toolObs`/`toolUsage`):
```typescript
const shareLinksOn = hub.shareLinks?.enabled === true
const shareArtifactsDir = hub.shareLinks?.artifactsDir ?? join(hub.stateDir, "share-artifacts")
const shareOutboxBase = hub.outboundAttachments?.outboxDir ?? join(hub.stateDir, "outbox")
const base62 = (b: Buffer) => { const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"; let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ""; while (n > 0n) { s = A[Number(n % 62n)] + s; n /= 62n } return s.padStart(22, "0") }
```

- [ ] **Step 4: Transport opt** (`hub/index.ts`)

In the transport opts (beside `attachEnabled`):
```typescript
    publishEnabled: shareLinksOn,
```

- [ ] **Step 5: Wire `onPublish` in `makeTransport`** (`hub/index.ts`)

Beside the `socket.onAttach(...)` wiring inside `makeTransport`:
```typescript
  if (shareLinksOn) {
    socket.onPublish(async (a) => {
      const io = {
        mkdir: (d: string) => mkdirSync(d, { recursive: true }),
        writeFile: (p: string, data: Buffer | string) => writeFileSync(p, data),
        rename: (f: string, t: string) => renameSync(f, t),
      }
      const r = publishArtifact(a, {
        artifactsDir: shareArtifactsDir, raHost: hub.shareLinks?.raHost ?? "readyapp.player-ready.co.uk",
        agent: name, outboxBase: shareOutboxBase, maxBytes: hub.shareLinks?.maxBytes ?? 26_214_400,
        defaultTtlDays: hub.shareLinks?.defaultTtlDays ?? 30, now: new Date(), randomToken: () => base62(randomBytes(16)),
      }, io)
      if (!auditOptedOut(name)) audit.record({ kind: "event", actor: `agent:${name}`, action: "publish_link", outcome: r.ok ? "ok" : "deny", detail: r.ok ? { token: r.token } : { reason: r.reason } })
      return r.ok ? { url: r.url } : { error: r.reason }
    })
  }
```
(`mkdirSync`/`writeFileSync`/`renameSync` are imported in `hub/index.ts` — confirm and add to the `fs` import if missing.)

- [ ] **Step 6: Cleanup sweep** (`hub/index.ts`)

After the status-board/tool-board interval blocks, add a gated sweep:
```typescript
if (shareLinksOn) {
  const sweep = () => {
    let names: string[] = []
    try { names = readdirSync(shareArtifactsDir) } catch { return }
    const now = new Date()
    const entries = names.filter((n) => !n.endsWith(".tmp")).map((token) => {
      try { const m = JSON.parse(readFileSync(join(shareArtifactsDir, token, "meta.sbmd"), "utf8")); return { token, expiresAt: m.expiresAt as string } }
      catch { let ageMs = 0; try { ageMs = now.getTime() - statSync(join(shareArtifactsDir, token)).mtimeMs } catch {}; return { token, ageMs } }
    })
    // also reap abandoned *.tmp dirs older than the grace period
    for (const n of names.filter((x) => x.endsWith(".tmp"))) {
      try { if (now.getTime() - statSync(join(shareArtifactsDir, n)).mtimeMs > 3_600_000) rmSync(join(shareArtifactsDir, n), { recursive: true, force: true }) } catch {}
    }
    for (const token of selectExpired(entries, now, 3_600_000)) {
      try { rmSync(join(shareArtifactsDir, token), { recursive: true, force: true }) } catch {}
    }
  }
  setInterval(sweep, hub.shareLinks?.cleanupIntervalMs ?? 86_400_000).unref()
  setTimeout(sweep, 30_000).unref()
}
```
(`readdirSync`/`statSync` are ALREADY imported in `hub/index.ts`; **`rmSync` is NOT — add it** to the existing `import { … } from "fs"` line. `mkdirSync`/`writeFileSync`/`renameSync`/`readFileSync` from Step 5 are also already imported.)

- [ ] **Step 7: Typecheck + full suite**

Run: `bunx tsc --noEmit` → exactly the 2 pre-existing errors, no new.
Run: `bun test` → no new failures (the 1 pre-existing).

- [ ] **Step 8: Manual smoke** (no live RA needed for the producer half)

`"shareLinks": { "enabled": true, "artifactsDir": "/tmp/share-artifacts", "raHost": "ra.test" }` on a dev hub. Have an agent write `report.md` into its outbox and call `publish_link("report.md")`. Confirm: it returns `https://ra.test/share/<token>`; `/tmp/share-artifacts/<token>/` has `report.md` + `meta.sbmd` (valid JSON, `mode:"view"`, `expiresAt` ~30 days out); no `.tmp` left. Set a past `expiresAt` by hand and confirm the sweep removes it.

- [ ] **Step 9: Commit**

```bash
git add hub/types.ts hub/config.ts hub/index.ts
git commit -m "feat(publish-link): wire publish_link + cleanup sweep behind hub.shareLinks flag"
```

---

## Self-Review

**Spec coverage:**
- `publish_link` request/response tool returning the URL → Task 3. ✓
- Outbox containment (reuse `resolveOutboxFile`) → Task 1. ✓
- mode/contentType inference + explicit override → Task 1. ✓
- `.sbmd` per contract + atomic temp-then-rename → Task 1. ✓
- token base62(randomBytes16), injected for tests → Task 1 (inject) + Task 5 (real). ✓
- Env gating via `buildShimMcpConfig` PUBLISH_LINK + double-gate → Tasks 3/4/5. ✓
- shim-socket `publish` frame → Task 4. ✓
- cleanup sweep (expired + abandoned `.tmp`) → Task 2 (select) + Task 5 (wire). ✓
- config `hub.shareLinks` → Task 5. ✓
- TDZ-safe declaration before the spawn loop → Task 5 Step 3. ✓
- audit of publishes → Task 5 Step 5. ✓

**Placeholder scan:** No TBD/TODO; complete code in every step.

**Type consistency:** `PublishArgs`/`PublishOpts`/`PublishIO`/`PublishResult` (Task 1) consumed in Task 5. `{ path, mode?, title?, scope?, ttlDays? }` is the shape across the shim wire (Task 3), `onPublish` (Task 4), and the Task 5 handler. `{ url?, error? }` is the publish_result shape across Tasks 3/4/5. `buildShimMcpConfig(..., publishEnabled)` matches Tasks 4 and 5's transport opt. `selectExpired` signature matches Tasks 2 and 5.

**Known coordination:** producer + RA renderer share `artifactsDir` and `raHost` only. Renderer ships dark until its `ARTIFACTS_DIR` points at the same dir.
