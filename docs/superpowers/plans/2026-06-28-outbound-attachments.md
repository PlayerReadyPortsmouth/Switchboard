# Outbound Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Switchboard agents an `attach_file` MCP tool that delivers a file they produced (e.g. a `.md`/`.pdf` report) to a Discord channel as its own message.

**Architecture:** The shim (`shim/server.ts`) is an MCP server; a new `attach_file` tool maps via `toolCallToWire` to a `{ t: "attach" }` shim-socket frame. The hub validates the path against a per-agent outbox (realpath containment + size/extension caps), then posts the file through a new `gateway.sendFiles`. Fire-and-forget, immediate own-message delivery — mirroring `post_card`.

**Tech Stack:** TypeScript, Bun (runtime + `bun:test`), discord.js v14, MCP SDK.

## Global Constraints

- **Runtime flag, default off.** Behaviour must be byte-identical when `hub.outboundAttachments.enabled` is falsy (per project feature-flag rule). Double-gated: the tool is not listed to agents AND a stray `attach` frame is ignored by the hub.
- **Containment is the security core.** Agents run with `--dangerously-skip-permissions`; an attach path MUST be canonicalised (`realpathSync`) and proven to sit inside `<outboxBase>/<agent>/`, defeating both `..` and symlink escapes. Agent identity comes from the transport (the `makeTransport` closure's `name`), never from tool arguments.
- **Test convention (match the codebase):** pure helpers get `bun:test` unit tests; thin Discord-client wrappers (`sendReply`/`sendPlain`) are not unit-tested. Follow this split — extract pure logic, test that.
- **Per task:** run `bunx tsc --noEmit` (typecheck) AND `bun test` — both must show no new failures vs baseline. Typecheck per task, not just tests.
- Discord limits: max **10 files** per message; **8 MB** default size ceiling (unboosted).
- No `Math.random()` / `Date.now()` churn introduced in pure modules.

---

### Task 1: Outbox path validator (`hub/outboxAttach.ts`)

The security core. A pure module (deterministic given the filesystem) that resolves an agent-supplied relative path to a contained absolute path or a typed rejection.

**Files:**
- Create: `hub/outboxAttach.ts`
- Test: `hub/outboxAttach.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type OutboxResult = { ok: true; absPath: string; filename: string; size: number } | { ok: false; reason: "escape" | "missing" | "notfile" | "oversize" | "extension" }`
  - `interface OutboxOpts { outboxBase: string; agent: string; maxBytes: number; allowedExtensions: string[] }`
  - `function resolveOutboxFile(relPath: string, opts: OutboxOpts): OutboxResult`

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/outboxAttach.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { resolveOutboxFile, type OutboxOpts } from "./outboxAttach"

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "outbox-"))
  const agent = "ada"
  mkdirSync(join(base, agent), { recursive: true })
  const opts: OutboxOpts = { outboxBase: base, agent, maxBytes: 1024, allowedExtensions: [] }
  return { base, agent, opts }
}

// Windows without Developer Mode / admin cannot create symlinks (EPERM). Probe
// once so the symlink-escape test runs on Linux/macOS/CI and skips elsewhere —
// the realpath containment still defends against symlinks regardless.
const SYMLINKS_OK = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "slk-"))
    symlinkSync(join(d, "x"), join(d, "y"))
    return true
  } catch { return false }
})()

test("happy path: a file written into the outbox resolves", () => {
  const { base, agent, opts } = fixture()
  writeFileSync(join(base, agent, "report.pdf"), "hello")
  const r = resolveOutboxFile("report.pdf", opts)
  expect(r.ok).toBe(true)
  if (r.ok) { expect(r.filename).toBe("report.pdf"); expect(r.size).toBe(5) }
})

test("rejects parent-traversal escaping the outbox", () => {
  const { base, opts } = fixture()
  writeFileSync(join(base, "secret.txt"), "x")        // sibling of the agent dir
  expect(resolveOutboxFile("../secret.txt", opts)).toEqual({ ok: false, reason: "escape" })
})

test.skipIf(!SYMLINKS_OK)("rejects a symlink whose target escapes the outbox", () => {
  const { base, agent, opts } = fixture()
  const secret = join(base, "secret.txt"); writeFileSync(secret, "x")
  symlinkSync(secret, join(base, agent, "link.txt"))
  expect(resolveOutboxFile("link.txt", opts)).toEqual({ ok: false, reason: "escape" })
})

test("a sibling agent dir with a shared prefix is not a false match", () => {
  const { base, agent, opts } = fixture()
  mkdirSync(join(base, agent + "-evil"), { recursive: true })
  writeFileSync(join(base, agent + "-evil", "x.txt"), "x")
  expect(resolveOutboxFile("../" + agent + "-evil/x.txt", opts)).toEqual({ ok: false, reason: "escape" })
})

test("rejects a missing file", () => {
  const { opts } = fixture()
  expect(resolveOutboxFile("nope.pdf", opts)).toEqual({ ok: false, reason: "missing" })
})

test("rejects a directory (not a regular file)", () => {
  const { base, agent, opts } = fixture()
  mkdirSync(join(base, agent, "sub"))
  expect(resolveOutboxFile("sub", opts)).toEqual({ ok: false, reason: "notfile" })
})

test("rejects an oversize file", () => {
  const { base, agent, opts } = fixture()
  writeFileSync(join(base, agent, "big.bin"), "x".repeat(2048))
  expect(resolveOutboxFile("big.bin", opts)).toEqual({ ok: false, reason: "oversize" })
})

test("enforces a non-empty extension allowlist", () => {
  const { base, agent, opts } = fixture()
  writeFileSync(join(base, agent, "a.exe"), "x")
  expect(resolveOutboxFile("a.exe", { ...opts, allowedExtensions: ["md", "pdf"] }))
    .toEqual({ ok: false, reason: "extension" })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test hub/outboxAttach.test.ts`
Expected: FAIL — `Cannot find module './outboxAttach'`.

- [ ] **Step 3: Write the implementation**

```typescript
// hub/outboxAttach.ts
import { realpathSync, statSync, mkdirSync } from "fs"
import { join, sep, extname, basename } from "path"

export type OutboxResult =
  | { ok: true; absPath: string; filename: string; size: number }
  | { ok: false; reason: "escape" | "missing" | "notfile" | "oversize" | "extension" }

export interface OutboxOpts {
  outboxBase: string          // e.g. <stateDir>/outbox
  agent: string               // taken from the transport, never from tool args
  maxBytes: number
  allowedExtensions: string[] // empty = allow any; lowercase, no leading dot
}

/** Resolve an agent-supplied relative `relPath` to a contained absolute path.
 *  Canonicalises with realpath so both `..` traversal and symlink targets that
 *  escape `<outboxBase>/<agent>/` are rejected. Pure given the filesystem. */
export function resolveOutboxFile(relPath: string, opts: OutboxOpts): OutboxResult {
  const agentRoot = join(opts.outboxBase, opts.agent)
  try { mkdirSync(agentRoot, { recursive: true }) } catch {}
  let root: string
  try { root = realpathSync(agentRoot) } catch { return { ok: false, reason: "missing" } }

  let real: string
  try { real = realpathSync(join(root, relPath)) } catch { return { ok: false, reason: "missing" } }
  // Containment: the canonical target must be the root itself or sit beneath it.
  // The `+ sep` guard stops `/outbox/ada` matching `/outbox/ada-evil`.
  if (real !== root && !real.startsWith(root + sep)) return { ok: false, reason: "escape" }

  let st
  try { st = statSync(real) } catch { return { ok: false, reason: "missing" } }
  if (!st.isFile()) return { ok: false, reason: "notfile" }
  if (st.size > opts.maxBytes) return { ok: false, reason: "oversize" }

  const ext = extname(real).replace(/^\./, "").toLowerCase()
  if (opts.allowedExtensions.length && !opts.allowedExtensions.includes(ext))
    return { ok: false, reason: "extension" }

  return { ok: true, absPath: real, filename: basename(real), size: st.size }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test hub/outboxAttach.test.ts`
Expected: PASS — 8 tests (the symlink-escape test is skipped where symlinks cannot be created, e.g. Windows without Developer Mode; it runs on Linux/macOS/CI).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors vs baseline.

- [ ] **Step 6: Commit**

```bash
git add hub/outboxAttach.ts hub/outboxAttach.test.ts
git commit -m "feat(attachments): outbox path validator with realpath containment"
```

---

### Task 2: Gateway file sender (`hub/gateway.ts`)

A pure helper that builds the discord.js `files` payload (tested), plus a thin `sendFiles` wrapper that posts it (not unit-tested, matching `sendReply`/`sendPlain`).

**Files:**
- Modify: `hub/gateway.ts` (add import; add `buildAttachmentFiles` near the other exported helpers; add `sendFiles` method to the gateway class after `sendPlain` at `hub/gateway.ts:268-271`)
- Test: `hub/gateway.test.ts` (add a test)

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `function buildAttachmentFiles(paths: string[], filename?: string): (string | AttachmentBuilder)[]`
  - method `sendFiles(chatId: string, paths: string[], caption?: string, filename?: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// add to hub/gateway.test.ts
import { buildAttachmentFiles } from "./gateway"
import { AttachmentBuilder } from "discord.js"

test("buildAttachmentFiles clamps to 10 files and overrides the display name", () => {
  // no filename → raw path strings (discord.js uses the basename)
  const plain = buildAttachmentFiles(["/out/a.pdf", "/out/b.pdf"])
  expect(plain).toEqual(["/out/a.pdf", "/out/b.pdf"])

  // filename override → an AttachmentBuilder carrying that name
  const named = buildAttachmentFiles(["/out/report.pdf"], "Weekly Report.pdf")
  expect(named.length).toBe(1)
  expect(named[0]).toBeInstanceOf(AttachmentBuilder)
  expect((named[0] as AttachmentBuilder).name).toBe("Weekly Report.pdf")

  // Discord allows at most 10 attachments per message
  const many = buildAttachmentFiles(Array.from({ length: 15 }, (_, i) => `/out/${i}.txt`))
  expect(many.length).toBe(10)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test hub/gateway.test.ts`
Expected: FAIL — `buildAttachmentFiles` is not exported.

- [ ] **Step 3: Implement the helper and method**

Add `AttachmentBuilder` to the discord.js import at the top of `hub/gateway.ts`:

```typescript
import {
  Client, GatewayIntentBits, Partials, ChannelType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, AttachmentBuilder,
  type Message, type Interaction,
} from "discord.js"
```

Add the exported pure helper (place it beside `buildCardComponents`, outside the class):

```typescript
/** Build the discord.js `files` payload from absolute paths. Clamps to Discord's
 *  10-attachment limit; a `filename` override wraps each path in an
 *  AttachmentBuilder so the display name differs from the on-disk basename. */
export function buildAttachmentFiles(paths: string[], filename?: string): (string | AttachmentBuilder)[] {
  return paths.slice(0, 10).map((p) =>
    filename ? new AttachmentBuilder(p, { name: filename }) : p)
}
```

Add the method to the gateway class, immediately after `sendPlain` (`hub/gateway.ts:271`):

```typescript
  /** Post a message carrying file attachments. Fire-and-forget: a fetch/send
   *  failure is logged, never thrown (the agent's turn already moved on). */
  async sendFiles(chatId: string, paths: string[], caption?: string, filename?: string): Promise<void> {
    try {
      const ch = await this.client.channels.fetch(chatId)
      if (!ch || !("send" in ch)) return
      const files = buildAttachmentFiles(paths, filename)
      if (!files.length) return
      await (ch as any).send({ ...(caption ? { content: caption } : {}), files })
    } catch (e) {
      process.stderr.write(`gateway: sendFiles to ${chatId} failed: ${e}\n`)
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test hub/gateway.test.ts`
Expected: PASS (existing gateway tests + the new one).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add hub/gateway.ts hub/gateway.test.ts
git commit -m "feat(attachments): gateway.sendFiles + buildAttachmentFiles helper"
```

---

### Task 3: Shim-socket `attach` frame (`hub/transports/shimSocket.ts`)

Route an inbound `{ t: "attach" }` wire frame to a registered callback, mirroring the existing `edit`/`notify` handlers.

**Files:**
- Modify: `hub/transports/shimSocket.ts` (add `attachCb` field + `onAttach` setter + a `case "attach"` in `dispatch`)
- Test: `hub/transports/shimSocket.test.ts` (create — there is no existing test for this file)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `onAttach(cb: (a: { chatId: string; path: string; caption?: string; filename?: string }) => void): void` on `ShimSocketServer`.

- [ ] **Step 1: Write the failing test**

The socket I/O needs a real Unix socket, but the routing logic in `dispatch` is private. Test it through the public surface by reaching the private method (the codebase already uses `as any` casts in tests). Keep it to the routing contract:

```typescript
// hub/transports/shimSocket.test.ts
import { test, expect } from "bun:test"
import { ShimSocketServer } from "./shimSocket"

test("an attach frame is routed to the onAttach callback", () => {
  const srv = new ShimSocketServer("/tmp/unused-attach.sock")
  let got: any = null
  srv.onAttach((a) => { got = a })
  // dispatch is private; exercise it directly (no socket needed for a fire-and-forget frame).
  ;(srv as any).dispatch(
    { t: "attach", chatId: "C1", path: "report.pdf", caption: "done", filename: "Report.pdf" },
    { write() {} },
  )
  expect(got).toEqual({ chatId: "C1", path: "report.pdf", caption: "done", filename: "Report.pdf" })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test hub/transports/shimSocket.test.ts`
Expected: FAIL — `srv.onAttach is not a function`.

- [ ] **Step 3: Implement**

In `hub/transports/shimSocket.ts`, add the field beside the other callbacks (after `askAgentCb`, ~line 27):

```typescript
  private attachCb: (a: { chatId: string; path: string; caption?: string; filename?: string }) => void = () => {}
```

Add the setter beside the other `on*` setters (after `onAskAgent`, ~line 40):

```typescript
  onAttach(cb: typeof this.attachCb) { this.attachCb = cb }
```

Add the dispatch case inside the `switch (m.t)` block (after the `edit` case, ~line 63):

```typescript
      case "attach":
        this.attachCb({ chatId: m.chatId, path: m.path, caption: m.caption, filename: m.filename }); break
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test hub/transports/shimSocket.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add hub/transports/shimSocket.ts hub/transports/shimSocket.test.ts
git commit -m "feat(attachments): route attach frame to onAttach callback"
```

---

### Task 4: `attach_file` MCP tool (`shim/server.ts`)

Expose the tool to the agent (gated by an env flag the hub sets) and map the call to the wire frame.

**Files:**
- Modify: `shim/server.ts` (add a `case "attach_file"` in `toolCallToWire` ~line 24; add the tool to the `ListToolsRequestSchema` array, gated like `ask_agent`)
- Test: `shim/server.test.ts` (add a mapping test)

**Interfaces:**
- Consumes: the `{ t: "attach" }` frame shape understood by Task 3.
- Produces: `attach_file(chat_id, path, caption?, filename?)` → `{ t: "attach", chatId, path, caption, filename }`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to shim/server.test.ts
test("attach_file maps to an attach wire message", () => {
  expect(toolCallToWire("attach_file", {
    chat_id: "C1", path: "report.pdf", caption: "here you go", filename: "Report.pdf",
  })).toEqual({
    t: "attach", chatId: "C1", path: "report.pdf", caption: "here you go", filename: "Report.pdf",
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test shim/server.test.ts`
Expected: FAIL — `toolCallToWire("attach_file", …)` returns `null` (default case), not the expected object.

- [ ] **Step 3: Implement the wire mapping**

In `shim/server.ts`, add a case to `toolCallToWire` (beside `post_webhook`, ~line 24):

```typescript
    case "attach_file":
      return { t: "attach", chatId: args.chat_id, path: args.path, caption: args.caption, filename: args.filename }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test shim/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the tool listing (env-gated)**

In the `ListToolsRequestSchema` handler's `tools` array, append the tool inside a spread guarded by the env flag — directly after the `ask_agent` consult spread (~line 159), still inside the array literal:

```typescript
      ...(process.env.ATTACH_FILES === "1" ? [{
        name: "attach_file",
        description: "Attach a file you have produced (e.g. a .md or .pdf report) to a Discord message. First WRITE the file into your outbox directory, then call this with its path RELATIVE to that outbox (e.g. \"report.pdf\"). Absolute paths or paths escaping your outbox are rejected. Optional `caption` is posted with the file; optional `filename` sets the display name (defaults to the file's basename).",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string", description: "The Discord channel id to post the file to." },
          path: { type: "string", description: "Path relative to your outbox directory." },
          caption: { type: "string", description: "Optional message text to post with the file." },
          filename: { type: "string", description: "Optional display name for the attachment." } },
          required: ["chat_id", "path"] },
      }] : []),
```

- [ ] **Step 6: Re-run tests + typecheck**

Run: `bun test shim/server.test.ts && bunx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add shim/server.ts shim/server.test.ts
git commit -m "feat(attachments): attach_file MCP tool + wire mapping (env-gated)"
```

---

### Task 5: Attach handler (`hub/attachHandler.ts`)

The decision logic that ties validator → gateway → audit, plus the double-gate. A pure factory (injected deps) so it is unit-testable without booting the hub.

**Files:**
- Create: `hub/attachHandler.ts`
- Test: `hub/attachHandler.test.ts`

**Interfaces:**
- Consumes: `OutboxResult` from Task 1 (`hub/outboxAttach.ts`).
- Produces:
  - `interface AttachFrame { chatId: string; path: string; caption?: string; filename?: string }`
  - `interface AttachDeps { enabled: boolean; resolve: (relPath: string) => OutboxResult; sendFiles: (chatId: string, paths: string[], caption?: string, filename?: string) => void; note: (chatId: string, text: string) => void; audit: (ok: boolean, chatId: string, detail: Record<string, unknown>) => void }`
  - `function makeAttachHandler(deps: AttachDeps): (f: AttachFrame) => void`

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/attachHandler.test.ts
import { test, expect } from "bun:test"
import { makeAttachHandler, type AttachDeps } from "./attachHandler"

function spyDeps(over: Partial<AttachDeps> = {}) {
  const sent: any[] = [], notes: any[] = [], audits: any[] = []
  const deps: AttachDeps = {
    enabled: true,
    resolve: () => ({ ok: true, absPath: "/out/ada/report.pdf", filename: "report.pdf", size: 5 }),
    sendFiles: (chatId, paths, caption, filename) => sent.push({ chatId, paths, caption, filename }),
    note: (chatId, text) => notes.push({ chatId, text }),
    audit: (ok, chatId, detail) => audits.push({ ok, chatId, detail }),
    ...over,
  }
  return { deps, sent, notes, audits }
}

test("disabled handler ignores the frame entirely (double-gate)", () => {
  const { deps, sent, audits } = spyDeps({ enabled: false })
  makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf" })
  expect(sent).toEqual([]); expect(audits).toEqual([])
})

test("a valid file is sent and audited ok", () => {
  const { deps, sent, notes, audits } = spyDeps()
  makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf", caption: "done" })
  expect(sent).toEqual([{ chatId: "C1", paths: ["/out/ada/report.pdf"], caption: "done", filename: "report.pdf" }])
  expect(notes).toEqual([])
  expect(audits[0].ok).toBe(true)
})

test("an explicit filename overrides the validator's basename", () => {
  const { deps, sent } = spyDeps()
  makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf", filename: "Weekly.pdf" })
  expect(sent[0].filename).toBe("Weekly.pdf")
})

test("a rejection posts a channel note, audits deny, and sends nothing", () => {
  const { deps, sent, notes, audits } = spyDeps({ resolve: () => ({ ok: false, reason: "escape" }) })
  makeAttachHandler(deps)({ chatId: "C1", path: "../secret" })
  expect(sent).toEqual([])
  expect(notes[0].text).toContain("outside your outbox")
  expect(audits[0]).toMatchObject({ ok: false, chatId: "C1", detail: { reason: "escape" } })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test hub/attachHandler.test.ts`
Expected: FAIL — `Cannot find module './attachHandler'`.

- [ ] **Step 3: Implement**

```typescript
// hub/attachHandler.ts
import type { OutboxResult } from "./outboxAttach"

export interface AttachFrame { chatId: string; path: string; caption?: string; filename?: string }

export interface AttachDeps {
  enabled: boolean
  resolve: (relPath: string) => OutboxResult            // bound to agent + opts by the caller
  sendFiles: (chatId: string, paths: string[], caption?: string, filename?: string) => void
  note: (chatId: string, text: string) => void          // channel-visible failure note
  audit: (ok: boolean, chatId: string, detail: Record<string, unknown>) => void
}

const REASON_TEXT: Record<string, string> = {
  escape: "path is outside your outbox",
  missing: "file not found",
  notfile: "not a regular file",
  oversize: "file is too large",
  extension: "file type not allowed",
}

/** Build the attach-frame handler. Disabled → ignore (double-gate). Otherwise
 *  validate the path, then either send the file or post a brief failure note;
 *  both outcomes are audited. */
export function makeAttachHandler(deps: AttachDeps): (f: AttachFrame) => void {
  return (f: AttachFrame): void => {
    if (!deps.enabled) return
    const r = deps.resolve(f.path)
    if (!r.ok) {
      deps.note(f.chatId, `⚠️ attach failed: ${REASON_TEXT[r.reason] ?? r.reason}`)
      deps.audit(false, f.chatId, { path: f.path, reason: r.reason })
      return
    }
    deps.sendFiles(f.chatId, [r.absPath], f.caption, f.filename ?? r.filename)
    deps.audit(true, f.chatId, { file: r.filename, size: r.size })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test hub/attachHandler.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add hub/attachHandler.ts hub/attachHandler.test.ts
git commit -m "feat(attachments): attach handler (validate -> send/note -> audit)"
```

---

### Task 6: Config type + hub wiring (`hub/types.ts`, `hub/config.ts`, `hub/index.ts`)

Add the config shape, normalise the outbox path, expose the tool via the env flag, and wire `onAttach` in `makeTransport`. This is integration of already-tested units — verified by typecheck, the full suite, and a manual smoke test (no new unit test).

**Files:**
- Modify: `hub/types.ts` (add `OutboundAttachmentConfig` + the `outboundAttachments?` field on `HubConfig`)
- Modify: `hub/config.ts` (expandHome the outbox dir in the normaliser)
- Modify: `hub/index.ts` (set the env flag at boot; wire `socket.onAttach` in `makeTransport`)

**Interfaces:**
- Consumes: `resolveOutboxFile`/`OutboxOpts` (Task 1), `gateway.sendFiles` (Task 2), `socket.onAttach` (Task 3), `makeAttachHandler` (Task 5), `expandHome` (`hub/config.ts`), `audit.record` + `auditOptedOut` (existing in `hub/index.ts`).
- Produces: a live `attach` capability when `hub.outboundAttachments.enabled`.

- [ ] **Step 1: Add the config type**

In `hub/types.ts`, add the field to `HubConfig` (after the `attachments?` line, ~line 290):

```typescript
  outboundAttachments?: OutboundAttachmentConfig // agents attach produced files to Discord (default off)
```

And add the interface (after `AttachmentConfig`, ~line 300):

```typescript
/** Agent-initiated outbound file attachments. Absent/disabled ⇒ the attach_file
 *  tool is not offered and any stray attach frame is ignored (byte-identical to
 *  before). When enabled, an agent may attach a file it wrote into its per-agent
 *  outbox (`<outboxDir>/<agent>/`); the hub validates containment + size before
 *  posting it to Discord. */
export interface OutboundAttachmentConfig {
  enabled?: boolean              // master switch (default off)
  outboxDir?: string             // base outbox dir (default <stateDir>/outbox)
  maxBytes?: number              // reject larger files (default 8388608 = 8 MB)
  allowedExtensions?: string[]   // empty/absent = allow any; e.g. ["md","pdf","png","csv"]
}
```

- [ ] **Step 2: Normalise the outbox path**

In `hub/config.ts`, after the existing `hub.stateDir = expandHome(hub.stateDir)` line (~line 30):

```typescript
  if (hub.outboundAttachments?.outboxDir)
    hub.outboundAttachments.outboxDir = expandHome(hub.outboundAttachments.outboxDir)
```

- [ ] **Step 3: Set the env flag at boot**

In `hub/index.ts`, after the `hub` config is loaded (near the top, e.g. just after `const token = process.env[hub.botTokenEnv]` at ~line 64), add:

```typescript
// Expose the attach_file tool to spawned shims (they inherit process.env).
if (hub.outboundAttachments?.enabled) process.env.ATTACH_FILES = "1"
```

- [ ] **Step 4: Wire onAttach in makeTransport**

First add the imports at the top of `hub/index.ts` (beside the other hub imports):

```typescript
import { resolveOutboxFile } from "./outboxAttach"
import { makeAttachHandler } from "./attachHandler"
```

Then, inside `makeTransport` (`hub/index.ts:273`), after the `socket.onAskAgent(...)` block (~line 353) and before `const t = new StreamJsonTransport(...)`:

```typescript
  // Agent-initiated outbound file attachment. Disabled ⇒ handler ignores the
  // frame (double-gate alongside the tool not being listed). The agent identity
  // is this transport's `name`, never taken from the frame.
  const oa = hub.outboundAttachments
  socket.onAttach(makeAttachHandler({
    enabled: !!oa?.enabled,
    resolve: (relPath) => resolveOutboxFile(relPath, {
      outboxBase: oa?.outboxDir ?? join(hub.stateDir, "outbox"),
      agent: name,
      maxBytes: oa?.maxBytes ?? 8_388_608,
      allowedExtensions: (oa?.allowedExtensions ?? []).map((e) => e.toLowerCase()),
    }),
    sendFiles: (chatId, paths, caption, filename) => void gateway.sendFiles(chatId, paths, caption, filename),
    note: (chatId, text) => void gateway.sendPlain(chatId, text),
    audit: (ok, chatId, detail) => {
      if (!auditOptedOut(name)) audit.record({
        kind: "event", actor: `agent:${name}`, action: "attach",
        chat: chatId, outcome: ok ? "ok" : "deny", detail,
      })
    },
  }))
```

Note: `join` is already imported in `hub/index.ts`; confirm and add it to the existing `path` import only if missing. `gateway`, `audit`, and `auditOptedOut` are already in scope at this point in the file.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors. (If `audit.record`'s `kind` rejects nothing — `"event"` is already an accepted kind, used by `emitHubEvent` at `hub/index.ts:624`.)

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: no new failures vs baseline (record the baseline failure count before starting; the inbound-attachments work already has a known-green suite).

- [ ] **Step 7: Manual smoke test**

Add a test config block and verify end-to-end on a dev hub:

```jsonc
// in the hub config used for the smoke test
"outboundAttachments": { "enabled": true, "maxBytes": 8388608 }
```

1. Boot the hub; confirm an agent lists `attach_file` (it should, because `ATTACH_FILES=1`).
2. Ask an agent to write `report.md` into its outbox (`<stateDir>/outbox/<agent>/report.md`) and call `attach_file(chat_id, "report.md", "here's the report")`.
3. Confirm the file arrives in the channel with the caption.
4. Ask the agent to attempt `attach_file(chat_id, "../../etc/hosts")`; confirm it does NOT post and a `⚠️ attach failed: path is outside your outbox` note appears.
5. Confirm the audit ledger has one `ok` and one `deny` `attach` event.

- [ ] **Step 8: Commit**

```bash
git add hub/types.ts hub/config.ts hub/index.ts
git commit -m "feat(attachments): wire outbound attach_file behind outboundAttachments flag"
```

---

## Self-Review

**Spec coverage:**
- Agent-facing `attach_file` tool → Task 4. ✓
- Immediate own-message delivery → Task 2 (`sendFiles`) + Task 5 handler. ✓
- Per-agent outbox + realpath containment + size + extension → Task 1. ✓
- Shim-socket `attach` frame → Task 3. ✓
- Config + flag, default off, double-gate → Task 6 (config + env exposure) and Task 5 (handler `enabled` gate). ✓
- Audit record → Task 6 wiring via `kind: "event"`, action `attach`. ✓
- Failure → channel note + log + audit deny → Task 5. ✓
- Tests mirroring inbound side (validator-focused) → Task 1. ✓
- Discord 10-file / 8 MB limits → Task 2 (clamp) + Task 1 (`maxBytes`). ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code. ✓

**Type consistency:** `OutboxResult`/`OutboxOpts`/`resolveOutboxFile` (Task 1) are consumed unchanged by Task 5's `AttachDeps.resolve` and Task 6's wiring. `{ t: "attach", chatId, path, caption, filename }` is produced identically in Task 4 (`toolCallToWire`) and consumed in Task 3 (`dispatch` case) and Task 3's callback shape matches Task 5's `AttachFrame`. `sendFiles(chatId, paths, caption?, filename?)` signature matches across Tasks 2, 5, 6. `ATTACH_FILES` env var name matches across Tasks 4 and 6. ✓

**Build order:** Tasks 1–5 are independent leaf/unit pieces; Task 6 integrates them last. Each task ships an independently testable deliverable.
