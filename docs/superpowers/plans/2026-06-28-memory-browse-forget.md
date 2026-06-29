# Memory Browse & Forget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator-only, card-driven way to browse, search, view, and forget memory-vault notes from Discord — reversible (archive) by default, with a deliberate permanent delete, all audited.

**Architecture:** A pure card layer (`memoryCard.ts`) renders list/detail/confirm cards and encodes/parses `mem:` button customIds; a bounded session store (`memoryBrowseSessions.ts`) maps a short correlation id → the page of notes a card is showing (so button clicks resolve a note without exceeding Discord's 100-char customId limit); an orchestration layer (`memoryBrowse.ts`, injected deps) lists/searches and performs forget(archive)/remove over the existing `MemoryStore` + vector index + audit. `hub/index.ts` registers the operator-gated `!memory` command and routes `mem:` button clicks through the existing `onNotifyButton` path.

**Tech Stack:** TypeScript, Bun (`bun:test`), discord.js v14.

## Global Constraints

- **Feature flag, default off:** `hub.memoryBrowse.enabled`. When off, the `!memory` command is not registered and `mem:` buttons are ignored — behaviour unchanged.
- **Operator-gated:** the `!memory` command AND every `mem:` button handler check the operator allowlist `operatorIds` (falls back to `[deployApproverUserId]` when empty). Non-operators get a denial. (Note: the gateway already gates ALL button clicks to `baseGate.listAllowed`; the operator re-check is the stricter, spec-required gate.)
- **Forget is reversible:** Forget = `store.archive(path)` + de-index. Delete permanently = `store.remove(path)` + de-index. Both are **audited** (`kind:"event"`, action `memory_forget`/`memory_delete`, actor = the operator, detail = `{title, scope}`).
- **De-index on both:** archiving/removing MUST also call the vector index `remove(path)`, or `recall` returns ghosts. (Archived notes also fall out of `recall` because `list()`/`allNotes()` skip the `archive/` dir — but the vector entry must still be dropped.)
- Discord limits: a card has ≤25 components; customId ≤100 chars → the list is paginated (≤5 notes/page) and buttons carry a short `mem:<action>:<corrId>[:<idx>]` id, never a file path.
- **Per task:** `bun test <file>` + `bunx tsc --noEmit`. Known-green baseline: `bun test` = 1 pre-existing failure (`tests/config.test.ts:8`); `bunx tsc --noEmit` = 2 pre-existing errors (`hub/index.ts`). No new beyond those.

**Shared types** (defined in Task 1, consumed throughout):
```typescript
// A vault note reduced for listing (body fetched on demand for the detail card).
export interface NoteSummary { path: string; scope: string; title: string; tags: string[]; source: string; updated: string }
```
(Derived from the existing `Note` = `{ path, scope, title, tags, body, source, created, updated }` in `hub/memory/store.ts`.)

---

### Task 1: Memory card layer (`hub/memoryCard.ts`)

Pure: the `mem:` customId codec + the three card renderers.

**Files:**
- Create: `hub/memoryCard.ts`
- Test: `hub/memoryCard.test.ts`

**Interfaces:**
- Consumes: `CardSpec` (`hub/types.ts`).
- Produces:
  - `interface NoteSummary { path: string; scope: string; title: string; tags: string[]; source: string; updated: string }`
  - `type MemAction = "view" | "forget" | "del" | "confirm" | "confirmdel" | "cancel" | "prev" | "next"`
  - `encodeMemId(action: MemAction, corrId: string, idx?: number): string`
  - `parseMemArg(arg: string): { corrId: string; idx?: number }` (arg = the `(.+)` capture from `parseNotifyCustomId`, i.e. `corrId` or `corrId:idx`)
  - `renderListCard(notes: NoteSummary[], corrId: string, page: number, pageCount: number, label: string): CardSpec`
  - `renderDetailCard(note: { title: string; scope: string; tags: string[]; source: string; updated: string; body: string }, corrId: string, idx: number): CardSpec`
  - `renderConfirmCard(kind: "forget" | "del", title: string, corrId: string, idx: number): CardSpec`

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/memoryCard.test.ts
import { test, expect } from "bun:test"
import { encodeMemId, parseMemArg, renderListCard, renderDetailCard, renderConfirmCard, type NoteSummary } from "./memoryCard"

test("encodeMemId / parseMemArg round-trip (with and without idx)", () => {
  expect(encodeMemId("view", "m3f", 4)).toBe("mem:view:m3f:4")
  expect(encodeMemId("next", "m3f")).toBe("mem:next:m3f")
  expect(parseMemArg("m3f:4")).toEqual({ corrId: "m3f", idx: 4 })
  expect(parseMemArg("m3f")).toEqual({ corrId: "m3f" })
})

const note = (t: string): NoteSummary => ({ path: `/v/global/${t}.md`, scope: "global", title: t, tags: ["a"], source: "agent:ada", updated: "2026-06-20T00:00:00Z" })

test("renderListCard: a View + Forget button per note, gated by Discord's 25-component cap", () => {
  const notes = [note("one"), note("two")]
  const card = renderListCard(notes, "m1", 0, 3, "global")
  expect(card.title).toContain("global")
  // one field per note
  expect(card.fields!.length).toBe(2)
  // buttons: 2 per note (view+forget) + prev/next on a multi-page set
  const ids = card.buttons.map(b => b.customId)
  expect(ids).toContain("mem:view:m1:0")
  expect(ids).toContain("mem:forget:m1:1")
  expect(ids).toContain("mem:prev:m1")
  expect(ids).toContain("mem:next:m1")
  // never exceed Discord's 25-component limit
  expect(card.buttons.length).toBeLessThanOrEqual(25)
})

test("renderListCard: empty notes → a placeholder, no per-note buttons", () => {
  const card = renderListCard([], "m1", 0, 1, "global")
  expect(card.fields!.length).toBe(1)
  expect(card.fields![0].value).toContain("no notes")
  expect(card.buttons.every(b => !b.customId.startsWith("mem:view"))).toBe(true)
})

test("renderDetailCard shows the body + Forget and Delete-permanently buttons", () => {
  const card = renderDetailCard({ title: "one", scope: "global", tags: ["a"], source: "agent:ada", updated: "x", body: "the body" }, "m1", 0)
  expect(card.body).toContain("the body")
  const ids = card.buttons.map(b => b.customId)
  expect(ids).toContain("mem:forget:m1:0")
  expect(ids).toContain("mem:del:m1:0")
})

test("renderConfirmCard wording + action differ for archive vs permanent delete", () => {
  const f = renderConfirmCard("forget", "one", "m1", 0)
  expect(f.body.toLowerCase()).toContain("archive")
  expect(f.buttons.map(b => b.customId)).toContain("mem:confirm:m1:0")     // archive → confirm
  expect(f.buttons.map(b => b.customId)).toContain("mem:cancel:m1:0")
  const d = renderConfirmCard("del", "one", "m1", 0)
  expect(d.body.toLowerCase()).toContain("permanently")
  expect(d.buttons.map(b => b.customId)).toContain("mem:confirmdel:m1:0")  // delete → confirmdel (kind explicit)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/memoryCard.test.ts`
Expected: FAIL — `Cannot find module './memoryCard'`.

- [ ] **Step 3: Implement**

```typescript
// hub/memoryCard.ts
import type { CardSpec } from "./types"

export interface NoteSummary { path: string; scope: string; title: string; tags: string[]; source: string; updated: string }
export type MemAction = "view" | "forget" | "del" | "confirm" | "confirmdel" | "cancel" | "prev" | "next"

/** `mem:<action>:<corrId>[:<idx>]`. The hub's parseNotifyCustomId yields
 *  ns="mem", action=<action>, arg=<corrId>[:<idx>] (its arg capture is greedy). */
export function encodeMemId(action: MemAction, corrId: string, idx?: number): string {
  return idx === undefined ? `mem:${action}:${corrId}` : `mem:${action}:${corrId}:${idx}`
}
export function parseMemArg(arg: string): { corrId: string; idx?: number } {
  const i = arg.indexOf(":")
  if (i < 0) return { corrId: arg }
  const idx = Number(arg.slice(i + 1))
  return { corrId: arg.slice(0, i), idx: Number.isFinite(idx) ? idx : undefined }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

export function renderListCard(notes: NoteSummary[], corrId: string, page: number, pageCount: number, label: string): CardSpec {
  const fields = notes.map((n, i) => ({
    name: `${i}. ${clip(n.title, 80)}`,
    value: `\`${n.scope}\` · ${n.source}${n.tags.length ? " · " + n.tags.map(t => `#${t}`).join(" ") : ""}`,
  }))
  if (!fields.length) fields.push({ name: "—", value: "_no notes in this view_" })
  const buttons: CardSpec["buttons"] = []
  notes.forEach((_, i) => {
    buttons.push({ customId: encodeMemId("view", corrId, i), label: `View ${i}`, style: "secondary" })
    buttons.push({ customId: encodeMemId("forget", corrId, i), label: `Forget ${i}`, style: "danger" })
  })
  if (pageCount > 1) {
    buttons.push({ customId: encodeMemId("prev", corrId), label: "◀ Prev", style: "primary" })
    buttons.push({ customId: encodeMemId("next", corrId), label: "Next ▶", style: "primary" })
  }
  return {
    title: `🧠 Vault — ${label}` + (pageCount > 1 ? ` (page ${page + 1}/${pageCount})` : ""),
    body: "Browse notes. **View** to read, **Forget** to archive (reversible).",
    fields,
    buttons: buttons.slice(0, 25),
  }
}

export function renderDetailCard(note: { title: string; scope: string; tags: string[]; source: string; updated: string; body: string }, corrId: string, idx: number): CardSpec {
  return {
    title: `🧠 ${clip(note.title, 240)}`,
    body: clip(note.body || "_(empty)_", 4000),
    fields: [{ name: "scope", value: `\`${note.scope}\``, inline: true }, { name: "source", value: note.source, inline: true },
             { name: "updated", value: note.updated, inline: true }, { name: "tags", value: note.tags.length ? note.tags.map(t => `#${t}`).join(" ") : "—", inline: true }],
    buttons: [
      { customId: encodeMemId("forget", corrId, idx), label: "Forget (archive)", style: "danger" },
      { customId: encodeMemId("del", corrId, idx), label: "Delete permanently", style: "danger" },
    ],
  }
}

export function renderConfirmCard(kind: "forget" | "del", title: string, corrId: string, idx: number): CardSpec {
  const body = kind === "forget"
    ? `Archive **${clip(title, 200)}**? It leaves recall but can be restored.`
    : `Permanently delete **${clip(title, 200)}**? This cannot be undone.`
  return {
    title: kind === "forget" ? "Archive note?" : "Delete note permanently?",
    body,
    buttons: [
      { customId: encodeMemId(kind === "del" ? "confirmdel" : "confirm", corrId, idx), label: "Confirm", style: kind === "del" ? "danger" : "primary" },
      { customId: encodeMemId("cancel", corrId, idx), label: "Cancel", style: "secondary" },
    ],
  }
}
```

(Confirm the `CardButton` shape in `hub/types.ts` — fields `customId`, `label`, `style`. Match it; the `style` values must be from its allowed enum, e.g. `"primary" | "secondary" | "success" | "danger"`.)

- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/memoryCard.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors). Then:
```bash
git add hub/memoryCard.ts hub/memoryCard.test.ts
git commit -m "feat(memory-browse): mem: customId codec + list/detail/confirm card renderers"
```

---

### Task 2: Browse session store (`hub/memoryBrowseSessions.ts`)

Pure. Maps a short corrId → the page of notes a posted card is showing, so a later button click resolves a note. Bounded (cards are ephemeral; evict oldest).

**Files:**
- Create: `hub/memoryBrowseSessions.ts`
- Test: `hub/memoryBrowseSessions.test.ts`

**Interfaces:**
- Consumes: `NoteSummary` (Task 1).
- Produces:
  - `interface BrowseSession { chatId: string; scopes: string[]; query?: string; label: string; notes: NoteSummary[]; page: number; pageSize: number }`
  - `class BrowseSessions` with `create(s: Omit<BrowseSession,"page"> & {page?: number}): string` (returns a new corrId), `get(corrId): BrowseSession | undefined`, `setPage(corrId, page): void`.

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/memoryBrowseSessions.test.ts
import { test, expect } from "bun:test"
import { BrowseSessions } from "./memoryBrowseSessions"
import type { NoteSummary } from "./memoryCard"

const note = (t: string): NoteSummary => ({ path: `/v/${t}.md`, scope: "global", title: t, tags: [], source: "x", updated: "y" })

test("create returns a usable corrId and stores the session", () => {
  const s = new BrowseSessions()
  const id = s.create({ chatId: "C1", scopes: ["global"], label: "global", notes: [note("a")], pageSize: 5 })
  expect(typeof id).toBe("string")
  expect(s.get(id)!.notes[0].title).toBe("a")
  expect(s.get(id)!.page).toBe(0)
})

test("corrIds are unique and contain no ':' (so they don't break the customId codec)", () => {
  const s = new BrowseSessions()
  const a = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  const b = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  expect(a).not.toBe(b)
  expect(a.includes(":")).toBe(false)
})

test("setPage updates the page; get on unknown id → undefined", () => {
  const s = new BrowseSessions()
  const id = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  s.setPage(id, 2)
  expect(s.get(id)!.page).toBe(2)
  expect(s.get("nope")).toBeUndefined()
})

test("bounded: oldest sessions evicted past the cap", () => {
  const s = new BrowseSessions(2)
  const a = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  const b = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  const c = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  expect(s.get(a)).toBeUndefined()   // evicted
  expect(s.get(b)).toBeDefined()
  expect(s.get(c)).toBeDefined()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/memoryBrowseSessions.test.ts`
Expected: FAIL — `Cannot find module './memoryBrowseSessions'`.

- [ ] **Step 3: Implement**

```typescript
// hub/memoryBrowseSessions.ts
import type { NoteSummary } from "./memoryCard"

export interface BrowseSession { chatId: string; scopes: string[]; query?: string; label: string; notes: NoteSummary[]; page: number; pageSize: number }

/** Short-lived map of corrId → the notes a posted browse card is showing.
 *  corrIds are base36 counters (no ':' — safe inside the mem: customId). */
export class BrowseSessions {
  private map = new Map<string, BrowseSession>()
  private counter = 0
  constructor(private cap = 200) {}

  create(s: Omit<BrowseSession, "page"> & { page?: number }): string {
    const id = "s" + (this.counter++).toString(36)
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(id, { ...s, page: s.page ?? 0 })
    return id
  }
  get(corrId: string): BrowseSession | undefined { return this.map.get(corrId) }
  setPage(corrId: string, page: number): void { const v = this.map.get(corrId); if (v) v.page = page }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/memoryBrowseSessions.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors). Then:
```bash
git add hub/memoryBrowseSessions.ts hub/memoryBrowseSessions.test.ts
git commit -m "feat(memory-browse): bounded browse-session store (corrId -> page of notes)"
```

---

### Task 3: Browse orchestration (`hub/memoryBrowse.ts`)

The seam between the command/buttons and the store + index + audit. Injectable deps → unit-testable without real I/O.

**Files:**
- Create: `hub/memoryBrowse.ts`
- Test: `hub/memoryBrowse.test.ts`

**Interfaces:**
- Consumes: `NoteSummary` (Task 1).
- Produces:
  - `interface MemoryBrowseDeps { list: (scopes: string[]) => NoteSummary[]; readBody: (path: string) => string; archive: (path: string) => void; remove: (path: string) => void; deindex: (path: string) => void; audit: (action: "memory_forget" | "memory_delete", actor: string, detail: Record<string, unknown>) => void; exists: (path: string) => boolean }`
  - `class MemoryBrowse(deps)` with `list(scopes)`, `body(path)`, `forget(note, actor)`, `remove(note, actor)` where `note: { path, title, scope }`. `forget`/`remove` return `{ ok: boolean; reason?: "missing" }`. (Search is done inline in the command via `memoryRetriever.relevant`, which is async — not a dep here.)

- [ ] **Step 1: Write the failing tests**

```typescript
// hub/memoryBrowse.test.ts
import { test, expect } from "bun:test"
import { MemoryBrowse, type MemoryBrowseDeps } from "./memoryBrowse"
import type { NoteSummary } from "./memoryCard"

const note = (t: string): NoteSummary => ({ path: `/v/${t}.md`, scope: "global", title: t, tags: [], source: "x", updated: "y" })

function deps(over: Partial<MemoryBrowseDeps> = {}) {
  const calls: any = { archive: [], remove: [], deindex: [], audit: [] }
  const d: MemoryBrowseDeps = {
    list: () => [note("a"), note("b")],
    readBody: () => "body",
    exists: () => true,
    archive: (p) => calls.archive.push(p),
    remove: (p) => calls.remove.push(p),
    deindex: (p) => calls.deindex.push(p),
    audit: (action, actor, detail) => calls.audit.push({ action, actor, detail }),
    ...over,
  }
  return { d, calls }
}

test("forget archives + de-indexes + audits memory_forget", () => {
  const { d, calls } = deps()
  const r = new MemoryBrowse(d).forget({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r.ok).toBe(true)
  expect(calls.archive).toEqual(["/v/a.md"])
  expect(calls.deindex).toEqual(["/v/a.md"])
  expect(calls.remove).toEqual([])
  expect(calls.audit[0]).toMatchObject({ action: "memory_forget", actor: "u1", detail: { title: "a", scope: "global" } })
})

test("remove hard-deletes + de-indexes + audits memory_delete", () => {
  const { d, calls } = deps()
  const r = new MemoryBrowse(d).remove({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r.ok).toBe(true)
  expect(calls.remove).toEqual(["/v/a.md"])
  expect(calls.deindex).toEqual(["/v/a.md"])
  expect(calls.audit[0]).toMatchObject({ action: "memory_delete", actor: "u1" })
})

test("forget on a missing note → {ok:false} and does nothing", () => {
  const { d, calls } = deps({ exists: () => false })
  const r = new MemoryBrowse(d).forget({ path: "/v/gone.md", title: "g", scope: "global" }, "u1")
  expect(r).toEqual({ ok: false, reason: "missing" })
  expect(calls.archive).toEqual([])
  expect(calls.audit).toEqual([])
})

test("a de-index failure still archives + audits (de-index is best-effort)", () => {
  const { d, calls } = deps({ deindex: () => { throw new Error("qdrant down") } })
  const r = new MemoryBrowse(d).forget({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r.ok).toBe(true)
  expect(calls.archive).toEqual(["/v/a.md"])
  expect(calls.audit.length).toBe(1)
})

test("list passes through the deps", () => {
  const { d } = deps()
  expect(new MemoryBrowse(d).list(["global"]).map(n => n.title)).toEqual(["a", "b"])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test hub/memoryBrowse.test.ts`
Expected: FAIL — `Cannot find module './memoryBrowse'`.

- [ ] **Step 3: Implement**

```typescript
// hub/memoryBrowse.ts
import type { NoteSummary } from "./memoryCard"

export interface MemoryBrowseDeps {
  list: (scopes: string[]) => NoteSummary[]
  readBody: (path: string) => string
  exists: (path: string) => boolean
  archive: (path: string) => void
  remove: (path: string) => void
  deindex: (path: string) => void
  audit: (action: "memory_forget" | "memory_delete", actor: string, detail: Record<string, unknown>) => void
}

export class MemoryBrowse {
  constructor(private d: MemoryBrowseDeps) {}

  list(scopes: string[]): NoteSummary[] { return this.d.list(scopes) }
  body(path: string): string { return this.d.readBody(path) }

  forget(note: { path: string; title: string; scope: string }, actor: string): { ok: boolean; reason?: "missing" } {
    if (!this.d.exists(note.path)) return { ok: false, reason: "missing" }
    this.d.archive(note.path)
    this.safeDeindex(note.path)
    this.d.audit("memory_forget", actor, { title: note.title, scope: note.scope })
    return { ok: true }
  }

  remove(note: { path: string; title: string; scope: string }, actor: string): { ok: boolean; reason?: "missing" } {
    if (!this.d.exists(note.path)) return { ok: false, reason: "missing" }
    this.d.remove(note.path)
    this.safeDeindex(note.path)
    this.d.audit("memory_delete", actor, { title: note.title, scope: note.scope })
    return { ok: true }
  }

  private safeDeindex(path: string): void {
    try { this.d.deindex(path) } catch (e) { process.stderr.write(`memory-browse: de-index ${path} failed: ${e}\n`) }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test hub/memoryBrowse.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors). Then:
```bash
git add hub/memoryBrowse.ts hub/memoryBrowse.test.ts
git commit -m "feat(memory-browse): orchestration — list/search/forget(archive)/remove + de-index + audit"
```

---

### Task 4: Config + flag (`hub/types.ts`)

**Files:**
- Modify: `hub/types.ts` (`HubConfig` + new interface)

- [ ] **Step 1: Add the type**

In `hub/types.ts`, add to `HubConfig` (next to `toolObservability?`):
```typescript
  memoryBrowse?: MemoryBrowseConfig  // operator memory browse & forget UI (default off)
```
And the interface (next to `ToolObservabilityConfig`):
```typescript
/** Operator-only card UI to browse/search the vault and forget (archive) or
 *  delete notes. Absent/disabled ⇒ the !memory command is unregistered and
 *  mem: buttons are ignored (byte-identical). */
export interface MemoryBrowseConfig {
  enabled?: boolean         // master switch (default off)
  operatorIds?: string[]    // user ids allowed to use it; empty ⇒ [deployApproverUserId]
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsc --noEmit` (no new errors). Then:
```bash
git add hub/types.ts
git commit -m "feat(memory-browse): memoryBrowse config type + flag"
```

---

### Task 5: Wire it into the hub (`hub/index.ts`)

Construct the orchestration + sessions; register the operator-gated `!memory` command; route `mem:` button clicks. Integration of tested units — verified by typecheck + full suite + manual smoke.

**Files:**
- Modify: `hub/index.ts`

**Interfaces:**
- Consumes: `MemoryBrowse`/`MemoryBrowseDeps` (Task 3), `BrowseSessions` (Task 2), `renderListCard`/`renderDetailCard`/`renderConfirmCard`/`parseMemArg`/`NoteSummary` (Task 1), `memoryBrowse` config (Task 4); plus existing `memoryStore`, `vectorIndex` (has `remove(path)`), `memoryRetriever` (`relevant(query, scopes)`), `audit`, `gateway.sendCard`/`editCard`, `gateway.onNotifyButton`, `parseNotifyCustomId`, `baseGate`, `hub.deployApproverUserId`.

- [ ] **Step 1: Imports + construction**

Add imports near the other hub imports:
```typescript
import { MemoryBrowse } from "./memoryBrowse"
import { BrowseSessions } from "./memoryBrowseSessions"
import { renderListCard, renderDetailCard, renderConfirmCard, parseMemArg, type NoteSummary } from "./memoryCard"
```

Near where `memoryRetriever` / `vectorIndex` are constructed (after line ~124), add:
```typescript
const memBrowseOn = hub.memoryBrowse?.enabled === true
const memOperators = (hub.memoryBrowse?.operatorIds?.length ? hub.memoryBrowse.operatorIds
  : (hub.deployApproverUserId ? [hub.deployApproverUserId] : []))
const isMemOperator = (uid: string) => memOperators.includes(uid)
const toSummary = (n: { path: string; scope: string; title: string; tags: string[]; source: string; updated: string }): NoteSummary =>
  ({ path: n.path, scope: n.scope, title: n.title, tags: n.tags, source: n.source, updated: n.updated })
const memSessions = new BrowseSessions()
const PAGE = 5
const memBrowse = new MemoryBrowse({
  list: (scopes) => memoryStore.list(scopes as any).map(toSummary),
  readBody: (path) => { try { return memoryStore.read(path).body } catch { return "" } },
  exists: (path) => { try { memoryStore.read(path); return true } catch { return false } },
  archive: (path) => { try { memoryStore.archive(path) } catch (e) { process.stderr.write(`memory-browse archive: ${e}\n`) } },
  remove: (path) => memoryStore.remove(path),
  deindex: (path) => { void Promise.resolve(vectorIndex.remove(path)).catch(() => {}) },
  audit: (action, actor, detail) => audit.record({ kind: "event", actor: `user:${actor}`, action, outcome: "ok", detail }),
})
```

`memBrowse` has no `search` dep — search is async (`memoryRetriever.relevant`) and is done inline in the `!memory` command (Step 2), passing already-resolved summaries into the session.

- [ ] **Step 2: The `!memory` command**

In the `!`-command chain (`gateway.handleInbound((m) => { const trimmed = m.content.trim() … })`, alongside `!tools`/`!replay`), add — gated on the flag AND operator:
```typescript
  if (memBrowseOn && /^!memory\b/i.test(trimmed)) {
    if (!isMemOperator(m.userId)) { void gateway.sendPlain(m.chatId, "🔒 `!memory` is operator-only."); return }
    const rest = trimmed.replace(/^!memory\b/i, "").trim()
    void (async () => {
      let notes: NoteSummary[]; let label: string
      const searchM = /^search\s+(.+)$/i.exec(rest)
      if (searchM) {
        label = `search "${searchM[1]}"`
        const scopes = ["global", "agents", "users", "channels"] as any  // all top-level scopes
        try { notes = (await memoryRetriever.relevant(searchM[1]!, scopes)).notes.map(toSummary) } catch { notes = [] }
      } else {
        const scope = (rest || "global")
        label = scope
        notes = memBrowse.list([scope])
      }
      const corrId = memSessions.create({ chatId: m.chatId, scopes: [label], label, notes, pageSize: PAGE })
      const pageCount = Math.max(1, Math.ceil(notes.length / PAGE))
      await gateway.sendCard(m.chatId, renderListCard(notes.slice(0, PAGE), corrId, 0, pageCount, label))
    })()
    return
  }
```

- [ ] **Step 3: Route `mem:` button clicks**

In `gateway.onNotifyButton((customId, userId) => { … })` (line ~1000), add a `mem:` branch BEFORE the agent-interaction fallback (`notifyRouter.agentFor`):
```typescript
  const mem = parseNotifyCustomId(customId)
  if (memBrowseOn && mem?.ns === "mem") {
    if (!isMemOperator(userId)) return
    void handleMemButton(mem.action, parseMemArg(mem.arg), userId)
    return
  }
```

- [ ] **Step 4: The `handleMemButton` handler**

Add this function near the other hub handlers (it uses `memSessions`, `memBrowse`, `gateway`, the renderers). `onNotifyButton` does not pass the clicked message id, so rather than editing the card in place, each step posts a NEW card via `gateway.sendCard` to the channel recorded on the session (`BrowseSession.chatId`, from Task 2). The gateway already `deferUpdate()`s the click, so the original card stays put and the follow-up card appears below it.

```typescript
async function handleMemButton(action: string, arg: { corrId: string; idx?: number }, userId: string): Promise<void> {
  const s = memSessions.get(arg.corrId)
  if (!s) return
  const chatId = s.chatId
  const pageCount = Math.max(1, Math.ceil(s.notes.length / PAGE))
  const pageNotes = () => s.notes.slice(s.page * PAGE, s.page * PAGE + PAGE)
  const noteAt = (i?: number) => (i === undefined ? undefined : pageNotes()[i])
  if (action === "next" || action === "prev") {
    memSessions.setPage(arg.corrId, Math.max(0, Math.min(pageCount - 1, s.page + (action === "next" ? 1 : -1))))
    await gateway.sendCard(chatId, renderListCard(pageNotes(), arg.corrId, s.page, pageCount, s.label)); return
  }
  if (action === "view") {
    const n = noteAt(arg.idx); if (!n) return
    await gateway.sendCard(chatId, renderDetailCard({ ...n, body: memBrowse.body(n.path) }, arg.corrId, arg.idx!)); return
  }
  if (action === "forget" || action === "del") {
    const n = noteAt(arg.idx); if (!n) return
    await gateway.sendCard(chatId, renderConfirmCard(action === "del" ? "del" : "forget", n.title, arg.corrId, arg.idx!)); return
  }
  if (action === "cancel") { await gateway.sendPlain(chatId, "Cancelled."); return }
  if (action === "confirm" || action === "confirmdel") {
    const n = noteAt(arg.idx); if (!n) return
    // The kind is explicit in the customId: confirm → archive, confirmdel → permanent delete.
    const r = action === "confirmdel"
      ? memBrowse.remove({ path: n.path, title: n.title, scope: n.scope }, userId)
      : memBrowse.forget({ path: n.path, title: n.title, scope: n.scope }, userId)
    const verb = action === "confirmdel" ? "🗑 Deleted" : "🗄 Archived"
    await gateway.sendPlain(chatId, r.ok ? `${verb} **${n.title}**.` : `⚠️ "${n.title}" no longer exists.`)
    return
  }
}
```

- [ ] **Step 5: Typecheck + full suite**

Run: `bunx tsc --noEmit` → exactly the 2 pre-existing errors, no new.
Run: `bun test` → no new failures (the 1 pre-existing).

- [ ] **Step 6: Manual smoke test**

Add `"memoryBrowse": { "enabled": true, "operatorIds": ["<your-id>"] }` to a dev hub config. Boot, then in Discord:
1. `!memory global` → a list card with View/Forget buttons (and Prev/Next if >5 notes).
2. View → detail card with body + Forget / Delete permanently.
3. Forget → confirm card → Confirm → "Archived"; verify the note leaves `recall` and the vault `archive/` dir holds it.
4. Delete permanently → confirm → Confirm → note gone from disk.
5. A non-operator running `!memory` → the operator-only denial.
6. Confirm an audit `memory_forget` / `memory_delete` row exists.

- [ ] **Step 7: Commit**

```bash
git add hub/index.ts
git commit -m "feat(memory-browse): wire !memory command + mem: button flow behind the flag"
```

---

## Self-Review

**Spec coverage:**
- Interactive card surface (`!memory [scope]` / `search`) → Tasks 1 (render) + 5 (command). ✓
- Paginated list (≤5/page, Prev/Next) → Task 1 + 5. ✓
- View → detail card → Tasks 1 + 5. ✓
- Forget → confirm → archive + de-index; Delete permanently → remove + de-index → Tasks 1, 3, 5. ✓
- De-index on both → Task 3 (`deindex` dep) + 5 (`vectorIndex.remove`). ✓
- Operator-gated (command + buttons), flag default off → Tasks 4, 5. ✓
- Audited forget/delete → Task 3 (`audit` dep, `memory_forget`/`memory_delete`) + 5 (`kind:"event"`). ✓
- Missing-note handling → Task 3 (`{ok:false}`) + 5 (message). ✓
- Bounded session map → Task 2. ✓

**Placeholder scan:** No TBD/TODO. The earlier draft's cross-task amendments are now folded into the tasks themselves: `BrowseSession.chatId` lives in Task 2 (interface + tests), and the `confirm`/`confirmdel` split lives in Task 1 (`MemAction` + `renderConfirmCard` + test). Each task is self-consistent.

**Type consistency:** `NoteSummary` is defined in Task 1 and consumed in 2, 3, 5. `MemoryBrowseDeps`/`MemoryBrowse` signatures match across Task 3 and the Task 5 construction (no `search` dep on either side). `parseMemArg` return `{corrId, idx?}` matches its use in Task 5. `encodeMemId`/`MemAction` include `confirmdel`, matched by `renderConfirmCard` (Task 1) and `handleMemButton` (Task 5). `BrowseSession.chatId` (Task 2) is set in `memSessions.create` and read in `handleMemButton` (Task 5).
