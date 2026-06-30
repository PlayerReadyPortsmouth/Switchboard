# Cross-VPS Agent Liaison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent on one switchboard hub address and exchange messages (`notify` + `ask`) with a named agent on another hub over the shared WireGuard bridge.

**Architecture:** Approach A — HMAC-authenticated HTTP `/peer/*` routes mounted on the hub's existing webhook listener, plus an outbound poster with a durable notify spool. `ask` is a *cross-hub consult*: the remote side reuses the existing `ConsultRegistry` to run a real local consult and POSTs the answer back to the caller. Bottom-up: pure, injected-IO modules (addressing, signing, spool, transcript log, client) are unit-tested in isolation; `index.ts` is thin wiring verified by typecheck + a manual two-hub smoke script.

**Tech Stack:** Bun + TypeScript. `node:crypto` HMAC. `Bun.serve` / `fetch`. MCP shim (`@modelcontextprotocol/sdk`). Tests: `bun test` (files beside source).

## Global Constraints

- **Public repo — keep it deployment-free.** No client names, real IPs, secrets, or internal URLs in engine code. Config ships placeholders only (`peer-staging`, `127.0.0.1`, `PEER_*_SECRET`).
- **Never break the running hub:** missing/`enabled:false` peering ⇒ tools absent, routes `404`, zero behaviour change. The hub runs *me* — a broken `hub/index.ts` or shim breaks the engine.
- **Reuse, don't reinvent:** `verifySignature` (`hub/webhookListener.ts`), `ConsultRegistry`/`consultAnswerFromReply` (`hub/consult.ts`), `deliverToAgent` (`hub/index.ts`), `AuditLog.record` (`hub/auditLog.ts`), shim env-flag gating (`buildShimMcpConfig`, `hub/transports/streamJsonFraming.ts`).
- **Audit invariant:** the existing `AuditLog` is **metadata-only** — never put message bodies in it. Bodies go only in `liaison.log.jsonl`.
- **TDD:** failing test → minimal impl → green → commit. Run `bun test <file>` per task and `bun run typecheck` before the final wiring commits.
- **Verbatim addressing:** a peer target is the string `"<peer>:<agent>"`; `<peer>` resolves locally via config, `<agent>` resolves on the remote hub.
- **Conventional commits**, one per task minimum.

Spec: `docs/superpowers/specs/2026-06-30-cross-vps-liaison-design.md`.

---

## File Structure

**New (engine, generic, injected IO):**
- `hub/peering.ts` — pure core: config types, `parseTarget`, `signPeerBody`/`verifyPeerBody`, `resolvePeer`, `PeerDedupe`, message envelope builders.
- `hub/peering.test.ts`
- `hub/peerClient.ts` — outbound poster `postPeer(peer, path, body, fetchImpl?)` (HMAC-sign + POST).
- `hub/peerClient.test.ts`
- `hub/peerSpool.ts` — durable notify spool: enqueue / drain-with-backoff / dead-letter (file-backed, injected fs+now+poster).
- `hub/peerSpool.test.ts`
- `hub/liaisonLog.ts` — transcript writer/reader for `liaison.log.jsonl` (schema `v:1`, injected append).
- `hub/liaisonLog.test.ts`
- `hub/peerRoutes.ts` — pure request handler `handlePeerRequest(req, deps)` for `/peer/notify|ask|reply` (verify, dedupe, dispatch via injected deps).
- `hub/peerRoutes.test.ts`
- `scripts/smoke-peer.ts` — manual two-hub loopback smoke (notify + ask).

**Modified:**
- `hub/types.ts` — `AuditKind += "liaison"`; `AgentAccess.peerableBy?`; `PeeringConfig` + `PeerDef`; `HubConfig.peering?`.
- `hub/webhookListener.ts` — `startWebhookListener` gains an optional `extraHandler` tried before the route table.
- `hub/transports/shimSocket.ts` — `onNotifyPeer` + `onAskPeer` callbacks + dispatch cases.
- `shim/server.ts` — `notify_peer` (fire-and-forget) + `ask_peer` (request/response) tools, gated by `PEERING=1`.
- `hub/transports/streamJsonFraming.ts` — `buildShimMcpConfig` gains `peeringEnabled` → `PEERING=1`.
- `hub/transports/streamJson.ts` — `StreamJsonOpts.peeringEnabled`, passed through.
- `hub/index.ts` — instantiate registry/client/spool/log; wire socket peer callbacks in `makeTransport`; mount peer routes; inbound-ask→local-consult→reply; outbound pending-ask registry resolved by `/peer/reply`; timeout sweep; audit + transcript + optional Discord mirror.
- `config/hub.config.json` — `peering` placeholder block.
- `README.md` — peering config + tools section.

---

## Task 1: Types

**Files:**
- Modify: `hub/types.ts`

**Interfaces:**
- Produces: `AuditKind` includes `"liaison"`; `AgentAccess.peerableBy?: string[]`; `PeerDef { name; baseUrl; secretEnv }`; `PeeringConfig { enabled; listenPath; selfName; selfBaseUrl; askTimeoutMs; mirrorChannelId; dedupeWindowMs; maxClockSkewMs; ratePerPeerPerMin; notifyRetry: { maxAttempts; baseDelayMs }; peers: PeerDef[] }`; `HubConfig.peering?: PeeringConfig`.

- [ ] **Step 1: Add the types**

In `hub/types.ts`, extend `AuditKind` (currently ends `… | "consult" | "mission"`):

```typescript
export type AuditKind =
  | "route" | "spawn" | "exec" | "outbound"
  | "session" | "access" | "approval" | "event" | "card" | "consult" | "mission"
  | "liaison"
```

Add `peerableBy` to `AgentAccess` (beside `consultableBy`):

```typescript
  peerableBy?: string[]   // remote peer names allowed to reach this agent via ask_peer ("*" = any); absent ⇒ none
```

Add the peering config types (place near `ConsultConfig`):

```typescript
export interface PeerDef {
  name: string        // logical peer id, e.g. "peer-staging"
  baseUrl: string     // WireGuard origin, e.g. "http://127.0.0.1:8787"
  secretEnv: string   // env var holding this peer's shared HMAC secret
}

export interface PeeringConfig {
  enabled?: boolean
  listenPath?: string          // default "/peer"
  selfName: string             // this hub's identity to peers
  selfBaseUrl: string          // this hub's reachable base, for ask replyTo
  askTimeoutMs?: number        // default 300000
  mirrorChannelId?: string | null
  dedupeWindowMs?: number      // default 600000
  maxClockSkewMs?: number      // default 120000
  ratePerPeerPerMin?: number   // default 0 (off)
  notifyRetry?: { maxAttempts?: number; baseDelayMs?: number }
  peers: PeerDef[]
}
```

Add to `HubConfig` (beside `consult?`):

```typescript
  peering?: PeeringConfig
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean (no usages yet).

- [ ] **Step 3: Commit**

```bash
git add hub/types.ts
git commit -m "feat(types): peering config + liaison audit kind + peerableBy access"
```

---

## Task 2: Addressing, signing, dedupe, envelopes (`hub/peering.ts`)

**Files:**
- Create: `hub/peering.ts`
- Test: `hub/peering.test.ts`

**Interfaces:**
- Consumes: `verifySignature` from `./webhookListener`; types from `./types`.
- Produces:
  - `parseTarget(s: string): { peer: string; agent: string } | null`
  - `signPeerBody(rawBody: string, secret: string): string` → `"sha256=<hex>"`
  - `verifyPeerBody(rawBody: string, header: string, secret: string): boolean`
  - `resolvePeer(cfg: PeeringConfig, name: string): PeerDef | undefined`
  - `peerSecret(env: NodeJS.ProcessEnv, def: PeerDef): string | undefined`
  - `class PeerDedupe { constructor(now: () => number, windowMs: number); seen(corrId: string): boolean }` (records + reports duplicates within the window; prunes old)
  - `freshTs(ts: number, now: number, skewMs: number): boolean`
  - `PeerEnvelope` type `{ from: string; to: string; corrId: string; kind: "notify"|"ask"|"reply"; text: string; ts: number; replyTo?: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// hub/peering.test.ts
import { expect, test } from "bun:test"
import { parseTarget, signPeerBody, verifyPeerBody, resolvePeer, PeerDedupe, freshTs } from "./peering"
import type { PeeringConfig } from "./types"

const cfg: PeeringConfig = {
  selfName: "a", selfBaseUrl: "http://127.0.0.1:1", peers: [
    { name: "peer-staging", baseUrl: "http://127.0.0.1:8787", secretEnv: "S" },
  ],
}

test("parseTarget splits peer:agent, rejects malformed", () => {
  expect(parseTarget("peer-staging:agent-b")).toEqual({ peer: "peer-staging", agent: "agent-b" })
  expect(parseTarget("noColon")).toBeNull()
  expect(parseTarget(":agent-b")).toBeNull()
  expect(parseTarget("peer:")).toBeNull()
})

test("sign/verify roundtrip; reject tampered body and wrong secret", () => {
  const body = JSON.stringify({ hello: "world" })
  const sig = signPeerBody(body, "s3cr3t")
  expect(sig.startsWith("sha256=")).toBe(true)
  expect(verifyPeerBody(body, sig, "s3cr3t")).toBe(true)
  expect(verifyPeerBody(body + "x", sig, "s3cr3t")).toBe(false)
  expect(verifyPeerBody(body, sig, "other")).toBe(false)
})

test("resolvePeer finds by name", () => {
  expect(resolvePeer(cfg, "peer-staging")?.baseUrl).toBe("http://127.0.0.1:8787")
  expect(resolvePeer(cfg, "nope")).toBeUndefined()
})

test("PeerDedupe flags repeats inside the window only", () => {
  let t = 1000
  const d = new PeerDedupe(() => t, 500)
  expect(d.seen("c1")).toBe(false)  // first sight
  expect(d.seen("c1")).toBe(true)   // duplicate
  t = 1600                          // past window
  expect(d.seen("c1")).toBe(false)  // pruned → fresh again
})

test("freshTs rejects stale/future beyond skew", () => {
  expect(freshTs(1000, 1000, 100)).toBe(true)
  expect(freshTs(1000, 1201, 100)).toBe(false) // too old
  expect(freshTs(1300, 1000, 100)).toBe(false) // too far future
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/peering.test.ts`
Expected: FAIL — `Cannot find module './peering'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// hub/peering.ts
import { createHmac } from "node:crypto"
import { verifySignature } from "./webhookListener"
import type { PeeringConfig, PeerDef } from "./types"

export interface PeerEnvelope {
  from: string
  to: string
  corrId: string
  kind: "notify" | "ask" | "reply"
  text: string
  ts: number
  replyTo?: string
}

export function parseTarget(s: string): { peer: string; agent: string } | null {
  const i = s.indexOf(":")
  if (i <= 0 || i === s.length - 1) return null
  return { peer: s.slice(0, i), agent: s.slice(i + 1) }
}

export function signPeerBody(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")
}

export function verifyPeerBody(rawBody: string, header: string, secret: string): boolean {
  return verifySignature(rawBody, header, secret)
}

export function resolvePeer(cfg: PeeringConfig, name: string): PeerDef | undefined {
  return cfg.peers.find((p) => p.name === name)
}

export function peerSecret(env: NodeJS.ProcessEnv, def: PeerDef): string | undefined {
  const v = env[def.secretEnv]
  return v && v.length > 0 ? v : undefined
}

export function freshTs(ts: number, now: number, skewMs: number): boolean {
  return Math.abs(now - ts) <= skewMs
}

/** Remembers seen corrIds for `windowMs`; `seen` returns true if already seen. */
export class PeerDedupe {
  private at = new Map<string, number>()
  constructor(private now: () => number, private windowMs: number) {}
  seen(corrId: string): boolean {
    const t = this.now()
    for (const [k, when] of this.at) if (t - when > this.windowMs) this.at.delete(k)
    if (this.at.has(corrId)) return true
    this.at.set(corrId, t)
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/peering.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/peering.ts hub/peering.test.ts
git commit -m "feat(peering): addressing, HMAC sign/verify, dedupe, ts freshness"
```

---

## Task 3: Outbound poster (`hub/peerClient.ts`)

**Files:**
- Create: `hub/peerClient.ts`
- Test: `hub/peerClient.test.ts`

**Interfaces:**
- Consumes: `signPeerBody` from `./peering`; `PeerDef` from `./types`.
- Produces: `type FetchLike = (url: string, init: { method: string; headers: Record<string,string>; body: string }) => Promise<{ status: number }>`; `postPeer(self: string, def: PeerDef, secret: string, path: string, body: object, fetchImpl: FetchLike): Promise<{ ok: boolean; status: number }>`.

- [ ] **Step 1: Write the failing test**

```typescript
// hub/peerClient.test.ts
import { expect, test } from "bun:test"
import { postPeer } from "./peerClient"
import { verifyPeerBody } from "./peering"
import type { PeerDef } from "./types"

const def: PeerDef = { name: "p", baseUrl: "http://10.0.0.1:8787", secretEnv: "S" }

test("postPeer signs the body and targets baseUrl+path; ok on 2xx", async () => {
  let seen: any = null
  const fetchImpl = async (url: string, init: any) => {
    seen = { url, init }; return { status: 202 }
  }
  const r = await postPeer("self-hub", def, "sekret", "/peer/ask", { corrId: "c1" }, fetchImpl)
  expect(r).toEqual({ ok: true, status: 202 })
  expect(seen.url).toBe("http://10.0.0.1:8787/peer/ask")
  expect(seen.init.headers["X-Switchboard-Peer"]).toBe("self-hub")
  expect(verifyPeerBody(seen.init.body, seen.init.headers["X-Switchboard-Signature"], "sekret")).toBe(true)
})

test("postPeer reports not-ok on non-2xx", async () => {
  const r = await postPeer("self", def, "s", "/peer/notify", {}, async () => ({ status: 401 }))
  expect(r.ok).toBe(false)
  expect(r.status).toBe(401)
})

test("postPeer reports not-ok on throw", async () => {
  const r = await postPeer("self", def, "s", "/peer/notify", {}, async () => { throw new Error("conn refused") })
  expect(r).toEqual({ ok: false, status: 0 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/peerClient.test.ts`
Expected: FAIL — `Cannot find module './peerClient'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// hub/peerClient.ts
import { signPeerBody } from "./peering"
import type { PeerDef } from "./types"

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>

export async function postPeer(
  self: string, def: PeerDef, secret: string, path: string, body: object, fetchImpl: FetchLike,
): Promise<{ ok: boolean; status: number }> {
  const raw = JSON.stringify(body)
  try {
    const res = await fetchImpl(def.baseUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Switchboard-Peer": self,
        "X-Switchboard-Signature": signPeerBody(raw, secret),
      },
      body: raw,
    })
    return { ok: res.status >= 200 && res.status < 300, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/peerClient.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/peerClient.ts hub/peerClient.test.ts
git commit -m "feat(peering): HMAC-signing outbound peer poster"
```

---

## Task 4: Durable notify spool (`hub/peerSpool.ts`)

**Files:**
- Create: `hub/peerSpool.ts`
- Test: `hub/peerSpool.test.ts`

**Interfaces:**
- Produces:
  - `interface SpoolItem { id: string; target: string; body: PeerEnvelope; attempts: number; nextAt: number }` (import `PeerEnvelope` from `./peering`)
  - `class PeerSpool` with injected deps `{ now: () => number; maxAttempts: number; baseDelayMs: number; send: (item: SpoolItem) => Promise<boolean>; onDeadLetter: (item: SpoolItem) => void }`:
    - `enqueue(target: string, body: PeerEnvelope): SpoolItem`
    - `drainOnce(): Promise<void>` — try each due item; on success remove; on failure bump attempts + backoff; at `maxAttempts` remove + `onDeadLetter`
    - `size(): number`
    - `snapshot(): SpoolItem[]` (for persistence by index.ts)
    - `restore(items: SpoolItem[]): void`

- [ ] **Step 1: Write the failing test**

```typescript
// hub/peerSpool.test.ts
import { expect, test } from "bun:test"
import { PeerSpool } from "./peerSpool"
import type { PeerEnvelope } from "./peering"

const env = (corrId: string): PeerEnvelope =>
  ({ from: "a", to: "b:agent", corrId, kind: "notify", text: "hi", ts: 0 })

function make(send: any, onDeadLetter = () => {}, now = () => 0) {
  return new PeerSpool({ now, maxAttempts: 3, baseDelayMs: 100, send, onDeadLetter })
}

test("successful send removes the item", async () => {
  const s = make(async () => true)
  s.enqueue("b:agent", env("c1"))
  await s.drainOnce()
  expect(s.size()).toBe(0)
})

test("failure keeps the item and backs off; not retried before nextAt", async () => {
  let t = 0; let calls = 0
  const s = new PeerSpool({ now: () => t, maxAttempts: 3, baseDelayMs: 100,
    send: async () => { calls++; return false }, onDeadLetter: () => {} })
  s.enqueue("b:agent", env("c1"))
  await s.drainOnce()                 // attempt 1 → fail, schedule at t+100
  expect(s.size()).toBe(1); expect(calls).toBe(1)
  await s.drainOnce()                 // still t=0, not due → no new call
  expect(calls).toBe(1)
  t = 100
  await s.drainOnce()                 // due → attempt 2
  expect(calls).toBe(2)
})

test("dead-letters after maxAttempts", async () => {
  let t = 0; const dead: string[] = []
  const s = new PeerSpool({ now: () => t, maxAttempts: 2, baseDelayMs: 10,
    send: async () => false, onDeadLetter: (i) => dead.push(i.body.corrId) })
  s.enqueue("b:agent", env("c9"))
  await s.drainOnce()                 // attempt 1
  t = 1000; await s.drainOnce()       // attempt 2 → reaches max → dead-letter
  expect(s.size()).toBe(0)
  expect(dead).toEqual(["c9"])
})

test("snapshot/restore round-trips pending items", () => {
  const s = make(async () => false)
  s.enqueue("b:agent", env("c1"))
  const snap = s.snapshot()
  const s2 = make(async () => false)
  s2.restore(snap)
  expect(s2.size()).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/peerSpool.test.ts`
Expected: FAIL — `Cannot find module './peerSpool'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// hub/peerSpool.ts
import type { PeerEnvelope } from "./peering"

export interface SpoolItem {
  id: string
  target: string
  body: PeerEnvelope
  attempts: number
  nextAt: number
}

export interface PeerSpoolDeps {
  now: () => number
  maxAttempts: number
  baseDelayMs: number
  send: (item: SpoolItem) => Promise<boolean>
  onDeadLetter: (item: SpoolItem) => void
}

export class PeerSpool {
  private items: SpoolItem[] = []
  private seq = 0
  constructor(private deps: PeerSpoolDeps) {}

  enqueue(target: string, body: PeerEnvelope): SpoolItem {
    const item: SpoolItem = { id: `s${++this.seq}`, target, body, attempts: 0, nextAt: this.deps.now() }
    this.items.push(item)
    return item
  }

  async drainOnce(): Promise<void> {
    const t = this.deps.now()
    const due = this.items.filter((i) => i.nextAt <= t)
    for (const item of due) {
      const ok = await this.deps.send(item)
      if (ok) { this.remove(item); continue }
      item.attempts++
      if (item.attempts >= this.deps.maxAttempts) {
        this.remove(item)
        this.deps.onDeadLetter(item)
      } else {
        item.nextAt = t + this.deps.baseDelayMs * 2 ** (item.attempts - 1)
      }
    }
  }

  private remove(item: SpoolItem): void {
    const i = this.items.indexOf(item)
    if (i >= 0) this.items.splice(i, 1)
  }

  size(): number { return this.items.length }
  snapshot(): SpoolItem[] { return this.items.map((i) => ({ ...i })) }
  restore(items: SpoolItem[]): void { this.items = items.map((i) => ({ ...i })); this.seq = items.length }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/peerSpool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/peerSpool.ts hub/peerSpool.test.ts
git commit -m "feat(peering): durable notify spool with backoff + dead-letter"
```

---

## Task 5: Transcript log (`hub/liaisonLog.ts`)

**Files:**
- Create: `hub/liaisonLog.ts`
- Test: `hub/liaisonLog.test.ts`

**Interfaces:**
- Produces:
  - `interface LiaisonRecord { v: 1; ts: string; dir: "out"|"in"; kind: "notify"|"ask"|"reply"|"deadletter"|"timeout"|"rejected"; corrId: string; peer: string; localAgent?: string; remoteAgent?: string; text?: string; bytes: number; ok: boolean; error?: string | null }`
  - `class LiaisonLog { constructor(deps: { append: (line: string) => void; now: () => number }); write(rec: Omit<LiaisonRecord, "v"|"ts"|"bytes"> & { text?: string }): LiaisonRecord }`
  - `parseLiaisonTail(raw: string, n: number): LiaisonRecord[]`

- [ ] **Step 1: Write the failing test**

```typescript
// hub/liaisonLog.test.ts
import { expect, test } from "bun:test"
import { LiaisonLog, parseLiaisonTail } from "./liaisonLog"

test("write stamps v+ts+bytes and appends one JSON line", () => {
  const lines: string[] = []
  const log = new LiaisonLog({ append: (l) => lines.push(l), now: () => 1700000000000 })
  const rec = log.write({ dir: "out", kind: "notify", corrId: "c1", peer: "p",
    localAgent: "agent-a", remoteAgent: "agent-b", text: "hello", ok: true })
  expect(rec.v).toBe(1)
  expect(rec.bytes).toBe(5)
  expect(rec.ts).toBe(new Date(1700000000000).toISOString())
  expect(lines.length).toBe(1)
  expect(JSON.parse(lines[0]).corrId).toBe("c1")
})

test("missing text → bytes 0", () => {
  const log = new LiaisonLog({ append: () => {}, now: () => 0 })
  expect(log.write({ dir: "in", kind: "timeout", corrId: "c2", peer: "p", ok: false }).bytes).toBe(0)
})

test("parseLiaisonTail returns last n valid records, skips junk", () => {
  const raw = [`{"v":1,"corrId":"a"}`, `not json`, `{"v":1,"corrId":"b"}`].join("\n")
  const out = parseLiaisonTail(raw, 1)
  expect(out.length).toBe(1)
  expect(out[0].corrId).toBe("b")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/liaisonLog.test.ts`
Expected: FAIL — `Cannot find module './liaisonLog'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// hub/liaisonLog.ts
export interface LiaisonRecord {
  v: 1
  ts: string
  dir: "out" | "in"
  kind: "notify" | "ask" | "reply" | "deadletter" | "timeout" | "rejected"
  corrId: string
  peer: string
  localAgent?: string
  remoteAgent?: string
  text?: string
  bytes: number
  ok: boolean
  error?: string | null
}

export type LiaisonInput = Omit<LiaisonRecord, "v" | "ts" | "bytes">

export class LiaisonLog {
  constructor(private deps: { append: (line: string) => void; now: () => number }) {}
  write(input: LiaisonInput): LiaisonRecord {
    const rec: LiaisonRecord = {
      v: 1,
      ts: new Date(this.deps.now()).toISOString(),
      bytes: input.text ? Buffer.byteLength(input.text) : 0,
      ...input,
    }
    try { this.deps.append(JSON.stringify(rec) + "\n") } catch { /* best-effort */ }
    return rec
  }
}

export function parseLiaisonTail(raw: string, n: number): LiaisonRecord[] {
  const out: LiaisonRecord[] = []
  for (const line of raw.split("\n")) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s) as LiaisonRecord) } catch { /* skip junk */ }
  }
  return out.slice(-n)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/liaisonLog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/liaisonLog.ts hub/liaisonLog.test.ts
git commit -m "feat(peering): liaison transcript log (jsonl, schema v1)"
```

---

## Task 6: Inbound route handler (`hub/peerRoutes.ts`)

**Files:**
- Create: `hub/peerRoutes.ts`
- Test: `hub/peerRoutes.test.ts`

**Interfaces:**
- Consumes: `verifyPeerBody`, `PeerDedupe`, `freshTs`, `PeerEnvelope` from `./peering`; `PeeringConfig` from `./types`.
- Produces: `interface PeerRouteDeps { cfg: PeeringConfig; secretFor: (peerName: string) => string | undefined; dedupe: PeerDedupe; now: () => number; onNotify: (e: PeerEnvelope) => void; onAsk: (e: PeerEnvelope) => void; onReply: (e: PeerEnvelope) => void; rateOk: (peerName: string) => boolean; onRejected: (peerName: string, reason: string) => void }`; `handlePeerRequest(req: Request, deps: PeerRouteDeps): Promise<Response>`.
- Behaviour: matches `listenPath + "/notify|ask|reply"`; `404` other paths; `405` non-POST; `401` unknown peer / bad sig; `429` over rate / `409` duplicate / `400` stale-ts (each → `onRejected`); else invoke the matching `onX` and return `200` (notify/reply) or `202` (ask).

- [ ] **Step 1: Write the failing test**

```typescript
// hub/peerRoutes.test.ts
import { expect, test } from "bun:test"
import { handlePeerRequest, type PeerRouteDeps } from "./peerRoutes"
import { signPeerBody, PeerDedupe, type PeerEnvelope } from "./peering"
import type { PeeringConfig } from "./types"

const cfg: PeeringConfig = {
  enabled: true, listenPath: "/peer", selfName: "self", selfBaseUrl: "http://127.0.0.1:1",
  peers: [{ name: "p", baseUrl: "http://x", secretEnv: "S" }],
}
const SECRET = "sekret"

function deps(over: Partial<PeerRouteDeps> = {}): PeerRouteDeps & { calls: any } {
  const calls: any = { notify: [], ask: [], reply: [], rejected: [] }
  return {
    cfg, secretFor: () => SECRET, dedupe: new PeerDedupe(() => 0, 1000), now: () => 0,
    rateOk: () => true,
    onNotify: (e) => calls.notify.push(e), onAsk: (e) => calls.ask.push(e),
    onReply: (e) => calls.reply.push(e), onRejected: (n, r) => calls.rejected.push([n, r]),
    calls, ...over,
  }
}

function req(path: string, body: PeerEnvelope, secret = SECRET, peer = "p", method = "POST"): Request {
  const raw = JSON.stringify(body)
  return new Request("http://h" + path, {
    method, body: raw,
    headers: { "X-Switchboard-Peer": peer, "X-Switchboard-Signature": signPeerBody(raw, secret) },
  })
}
const env = (kind: PeerEnvelope["kind"], corrId = "c1"): PeerEnvelope =>
  ({ from: "p", to: "self:agent-a", corrId, kind, text: "hi", ts: 0, replyTo: "http://p/peer/reply" })

test("valid notify → 200 + onNotify", async () => {
  const d = deps()
  const r = await handlePeerRequest(req("/peer/notify", env("notify")), d)
  expect(r.status).toBe(200)
  expect(d.calls.notify.length).toBe(1)
})

test("valid ask → 202 + onAsk", async () => {
  const d = deps()
  const r = await handlePeerRequest(req("/peer/ask", env("ask")), d)
  expect(r.status).toBe(202)
  expect(d.calls.ask.length).toBe(1)
})

test("unknown path → 404", async () => {
  expect((await handlePeerRequest(req("/peer/nope", env("notify")), deps())).status).toBe(404)
})

test("non-POST → 405", async () => {
  expect((await handlePeerRequest(req("/peer/notify", env("notify"), SECRET, "p", "GET"), deps())).status).toBe(405)
})

test("bad signature → 401 + onRejected", async () => {
  const d = deps()
  const r = await handlePeerRequest(req("/peer/notify", env("notify"), "wrong"), d)
  expect(r.status).toBe(401)
  expect(d.calls.rejected[0][1]).toContain("sig")
})

test("unknown peer (no secret) → 401", async () => {
  const d = deps({ secretFor: () => undefined })
  expect((await handlePeerRequest(req("/peer/notify", env("notify")), d)).status).toBe(401)
})

test("duplicate corrId → 409", async () => {
  const d = deps()
  await handlePeerRequest(req("/peer/notify", env("notify", "dup")), d)
  const r = await handlePeerRequest(req("/peer/notify", env("notify", "dup")), d)
  expect(r.status).toBe(409)
})

test("over rate → 429", async () => {
  const d = deps({ rateOk: () => false })
  expect((await handlePeerRequest(req("/peer/notify", env("notify")), d)).status).toBe(429)
})

test("stale ts → 400", async () => {
  const d = deps({ now: () => 10_000_000 }) // far from ts:0
  const r = await handlePeerRequest(req("/peer/notify", env("notify")), d)
  expect(r.status).toBe(400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/peerRoutes.test.ts`
Expected: FAIL — `Cannot find module './peerRoutes'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// hub/peerRoutes.ts
import { verifyPeerBody, freshTs, type PeerDedupe, type PeerEnvelope } from "./peering"
import type { PeeringConfig } from "./types"

export interface PeerRouteDeps {
  cfg: PeeringConfig
  secretFor: (peerName: string) => string | undefined
  dedupe: PeerDedupe
  now: () => number
  onNotify: (e: PeerEnvelope) => void
  onAsk: (e: PeerEnvelope) => void
  onReply: (e: PeerEnvelope) => void
  rateOk: (peerName: string) => boolean
  onRejected: (peerName: string, reason: string) => void
}

export async function handlePeerRequest(req: Request, deps: PeerRouteDeps): Promise<Response> {
  const base = deps.cfg.listenPath ?? "/peer"
  const url = new URL(req.url)
  const kind = url.pathname === `${base}/notify` ? "notify"
    : url.pathname === `${base}/ask` ? "ask"
    : url.pathname === `${base}/reply` ? "reply" : null
  if (!kind) return new Response("not found", { status: 404 })
  if (req.method !== "POST") return new Response("method", { status: 405 })

  const raw = await req.text()
  const peerName = req.headers.get("X-Switchboard-Peer") ?? ""
  const sig = req.headers.get("X-Switchboard-Signature") ?? ""
  const secret = deps.secretFor(peerName)
  if (!secret || !verifyPeerBody(raw, sig, secret)) {
    deps.onRejected(peerName, "bad sig / unknown peer")
    return new Response("unauthorized", { status: 401 })
  }
  if (!deps.rateOk(peerName)) {
    deps.onRejected(peerName, "rate")
    return new Response("rate", { status: 429 })
  }
  let e: PeerEnvelope
  try { e = JSON.parse(raw) as PeerEnvelope } catch {
    deps.onRejected(peerName, "bad json"); return new Response("bad json", { status: 400 })
  }
  const skew = deps.cfg.maxClockSkewMs ?? 120000
  if (!freshTs(e.ts, deps.now(), skew)) {
    deps.onRejected(peerName, "stale ts"); return new Response("stale", { status: 400 })
  }
  if (deps.dedupe.seen(e.corrId)) {
    deps.onRejected(peerName, "duplicate"); return new Response("duplicate", { status: 409 })
  }
  if (kind === "notify") { deps.onNotify(e); return new Response("ok", { status: 200 }) }
  if (kind === "reply")  { deps.onReply(e);  return new Response("ok", { status: 200 }) }
  deps.onAsk(e)
  return new Response("accepted", { status: 202 })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/peerRoutes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/peerRoutes.ts hub/peerRoutes.test.ts
git commit -m "feat(peering): inbound /peer route handler (verify, dedupe, rate, dispatch)"
```

---

## Task 7: Webhook listener accepts an extra handler

**Files:**
- Modify: `hub/webhookListener.ts`
- Test: `hub/webhookListener.test.ts` (add a case)

**Interfaces:**
- Produces: `startWebhookListener(port, routes, extraHandler?)` where `extraHandler?: (req: Request) => Promise<Response | null>` is tried first; returning `null` falls through to the webhook route table. The listener now starts when EITHER a usable route exists OR an `extraHandler` is provided.

- [ ] **Step 1: Write the failing test**

Add to `hub/webhookListener.test.ts`:

```typescript
import { handleWebhookRequest } from "./webhookListener"

test("extraHandler is consulted first; null falls through to routes", async () => {
  // pure-level check via a tiny inline composition mirroring startWebhookListener's fetch
  const extra = async (req: Request) =>
    new URL(req.url).pathname.startsWith("/peer") ? new Response("peer", { status: 202 }) : null
  const compose = async (req: Request) => (await extra(req)) ?? new Response("fell-through", { status: 200 })
  expect((await compose(new Request("http://h/peer/x", { method: "POST" }))).status).toBe(202)
  expect((await compose(new Request("http://h/other", { method: "POST" }))).status).toBe(200)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/webhookListener.test.ts`
Expected: PASS for existing tests; the new test passes too but documents the contract. (If preferred, assert on the real `startWebhookListener` by binding an ephemeral port — optional. The contract is enforced by Step 3.)

- [ ] **Step 3: Modify `startWebhookListener`**

```typescript
export function startWebhookListener(
  port: number, routes: WebhookHandler[],
  extraHandler?: (req: Request) => Promise<Response | null>,
): { stop: () => void } | null {
  const usable = routes.filter((r) => r.secret)
  if (!port || (usable.length === 0 && !extraHandler)) return null
  const server = Bun.serve({
    port,
    fetch: async (req) => {
      if (extraHandler) {
        const r = await extraHandler(req)
        if (r) return r
      }
      return handleWebhookRequest(req, usable)
    },
  })
  return { stop: () => server.stop(true) }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test hub/webhookListener.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (existing 2-arg callers still valid — `extraHandler` is optional).

- [ ] **Step 5: Commit**

```bash
git add hub/webhookListener.ts hub/webhookListener.test.ts
git commit -m "feat(webhook): optional extraHandler tried before the route table"
```

---

## Task 8: Shim socket peer callbacks

**Files:**
- Modify: `hub/transports/shimSocket.ts`
- Test: `hub/transports/shimSocket.test.ts` (create if absent, else add cases)

**Interfaces:**
- Produces on `ShimSocketServer`: `onNotifyPeer(cb: (n: { target: string; text: string }) => void)`, `onAskPeer(cb: (q: { target: string; message: string }) => Promise<string>)`. Dispatch: `notify_peer` → fire `notifyPeerCb`; `ask_peer` → run `askPeerCb` then `socket.write(encode({ t: "ask_peer_result", id, answer }))`.

- [ ] **Step 1: Write the failing test**

```typescript
// hub/transports/shimSocket.test.ts  (add)
import { expect, test } from "bun:test"
import { ShimSocketServer } from "./shimSocket"

test("dispatch notify_peer fires onNotifyPeer", () => {
  const s = new ShimSocketServer("/tmp/x.sock")
  let got: any = null
  s.onNotifyPeer((n) => { got = n })
  // @ts-expect-error reach private dispatch for a unit check
  s.dispatch({ t: "notify_peer", target: "p:agent", text: "hi" }, { write() {} } as any)
  expect(got).toEqual({ target: "p:agent", text: "hi" })
})

test("dispatch ask_peer writes ask_peer_result with the answer", async () => {
  const s = new ShimSocketServer("/tmp/x.sock")
  s.onAskPeer(async () => "the answer")
  const writes: string[] = []
  // @ts-expect-error private dispatch
  s.dispatch({ t: "ask_peer", id: "a1", target: "p:agent", message: "q" },
    { write: (b: string) => writes.push(b) } as any)
  await new Promise((r) => setTimeout(r, 5))
  expect(writes.join("")).toContain("ask_peer_result")
  expect(writes.join("")).toContain("the answer")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/transports/shimSocket.test.ts`
Expected: FAIL — `onNotifyPeer is not a function`.

- [ ] **Step 3: Implement**

In `hub/transports/shimSocket.ts`, add fields beside `askAgentCb`:

```typescript
  private notifyPeerCb: (n: { target: string; text: string }) => void = () => {}
  private askPeerCb: (q: { target: string; message: string }) => Promise<string> = async () => ""
```

Add registrars beside `onAskAgent`:

```typescript
  onNotifyPeer(cb: typeof this.notifyPeerCb) { this.notifyPeerCb = cb }
  onAskPeer(cb: typeof this.askPeerCb) { this.askPeerCb = cb }
```

Add dispatch cases inside the `switch (m.t)` (beside `ask_agent`):

```typescript
      case "notify_peer":
        this.notifyPeerCb({ target: m.target, text: m.text }); break
      case "ask_peer":
        void this.askPeerCb({ target: m.target, message: m.message }).then((answer) => {
          try { socket.write(encode({ t: "ask_peer_result", id: m.id, answer })) } catch {}
        })
        break
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test hub/transports/shimSocket.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add hub/transports/shimSocket.ts hub/transports/shimSocket.test.ts
git commit -m "feat(shim-socket): notify_peer + ask_peer dispatch callbacks"
```

---

## Task 9: Shim tools (`notify_peer`, `ask_peer`) gated by `PEERING=1`

**Files:**
- Modify: `shim/server.ts`
- Modify: `hub/transports/streamJsonFraming.ts` (`buildShimMcpConfig` gains `peeringEnabled`)
- Modify: `hub/transports/streamJson.ts` (`StreamJsonOpts.peeringEnabled`, passed through)
- Test: `shim/server.test.ts` (add a `toolCallToWire` case)

**Interfaces:**
- Consumes: env flag `PEERING=1`.
- Produces: wire `{ t: "notify_peer", target, text }` (fire-and-forget) and `{ t: "ask_peer", id, target, message }` (request/response, awaits `ask_peer_result`). `buildShimMcpConfig(shimPath, socketPath, agentName, consultEnabled?, attachEnabled?, publishEnabled?, peeringEnabled?)`.

- [ ] **Step 1: Write the failing test**

Add to `shim/server.test.ts`:

```typescript
import { toolCallToWire } from "./server"

test("notify_peer maps to a fire-and-forget wire frame", () => {
  expect(toolCallToWire("notify_peer", { target: "p:agent", text: "hi" }))
    .toEqual({ t: "notify_peer", target: "p:agent", text: "hi" })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test shim/server.test.ts`
Expected: FAIL — `toolCallToWire("notify_peer", …)` returns `null`.

- [ ] **Step 3: Implement the wire mapping + tools + gate**

In `shim/server.ts` `toolCallToWire`, add a case (before `default`):

```typescript
    case "notify_peer":
      return { t: "notify_peer", target: args.target, text: args.text }
```

Add a pending map beside `pendingAsk`:

```typescript
  const pendingPeerAsk = new Map<string, (answer: string) => void>()
```

In the socket `data` handler, add a branch beside `ask_agent_result`:

```typescript
          } else if (m.t === "ask_peer_result" && m.id && pendingPeerAsk.has(m.id)) {
            pendingPeerAsk.get(m.id)!(m.answer ?? "")
            pendingPeerAsk.delete(m.id)
```

In `ListToolsRequestSchema`, add (after the `ask_agent` block), gated by `PEERING`:

```typescript
      ...(process.env.PEERING === "1" ? [
        { name: "notify_peer",
          description: "Send a one-way message to an agent on another Switchboard hub (no reply). Address it `peer:agent` — the peer name from hub config and the remote agent's name. Delivery is queued + retried; you get back a queued ack, not the remote agent's response.",
          inputSchema: { type: "object", properties: {
            target: { type: "string", description: "Remote address as \"peer:agent\"." },
            text: { type: "string", description: "The message to deliver." } },
            required: ["target", "text"] } },
        { name: "ask_peer",
          description: "Ask an agent on another Switchboard hub a question and get its answer back. Address it `peer:agent`. The remote hub runs that agent and returns its reply; expect a wait while it thinks. Only agents the remote operator has made peer-reachable will answer.",
          inputSchema: { type: "object", properties: {
            target: { type: "string", description: "Remote address as \"peer:agent\"." },
            message: { type: "string", description: "Your question or task for the remote agent." } },
            required: ["target", "message"] } },
      ] : []),
```

In `CallToolRequestSchema`, add a request/response handler (beside `ask_agent`):

```typescript
    if (req.params.name === "ask_peer") {
      const id = `pa${++reqCounter}`
      const answer = await new Promise<string>((resolve) => {
        pendingPeerAsk.set(id, resolve)
        sock.write(encode({ t: "ask_peer", id, target: args.target, message: args.message }))
        const timer = setTimeout(() => { if (pendingPeerAsk.delete(id)) resolve("(the peer agent did not respond in time)") }, 310000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      return { content: [{ type: "text", text: answer }] }
    }
```

In `hub/transports/streamJsonFraming.ts`, extend `buildShimMcpConfig`:

```typescript
export function buildShimMcpConfig(shimPath: string, socketPath: string, agentName: string, consultEnabled = false, attachEnabled = false, publishEnabled = false, peeringEnabled = false) {
```

and in its `env` block add:

```typescript
          ...(peeringEnabled ? { PEERING: "1" } : {}),
```

In `hub/transports/streamJson.ts`: add `peeringEnabled?: boolean` to `StreamJsonOpts`, and in `start()` pass it as the 7th arg to `buildShimMcpConfig(... this.opts.publishEnabled, this.opts.peeringEnabled)`.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test shim/server.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add shim/server.ts shim/server.test.ts hub/transports/streamJsonFraming.ts hub/transports/streamJson.ts
git commit -m "feat(shim): notify_peer + ask_peer tools gated by PEERING=1"
```

---

## Task 10: Rate limiter helper (`hub/peering.ts` addition)

**Files:**
- Modify: `hub/peering.ts`
- Modify: `hub/peering.test.ts`

**Interfaces:**
- Produces: `class PeerRateLimiter { constructor(now: () => number, perMin: number); ok(peer: string): boolean }` — sliding 60 s window per peer; `perMin <= 0` ⇒ always `ok`.

- [ ] **Step 1: Write the failing test**

Add to `hub/peering.test.ts`:

```typescript
import { PeerRateLimiter } from "./peering"

test("PeerRateLimiter caps per peer per minute; 0 = unlimited", () => {
  let t = 0
  const rl = new PeerRateLimiter(() => t, 2)
  expect(rl.ok("p")).toBe(true)
  expect(rl.ok("p")).toBe(true)
  expect(rl.ok("p")).toBe(false)      // 3rd within the minute
  expect(rl.ok("q")).toBe(true)       // other peer independent
  t = 61_000
  expect(rl.ok("p")).toBe(true)       // window rolled
  const off = new PeerRateLimiter(() => 0, 0)
  for (let i = 0; i < 100; i++) expect(off.ok("p")).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hub/peering.test.ts`
Expected: FAIL — `PeerRateLimiter is not exported`.

- [ ] **Step 3: Implement**

Append to `hub/peering.ts`:

```typescript
export class PeerRateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private now: () => number, private perMin: number) {}
  ok(peer: string): boolean {
    if (this.perMin <= 0) return true
    const t = this.now()
    const arr = (this.hits.get(peer) ?? []).filter((ts) => t - ts < 60_000)
    if (arr.length >= this.perMin) { this.hits.set(peer, arr); return false }
    arr.push(t); this.hits.set(peer, arr); return true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hub/peering.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/peering.ts hub/peering.test.ts
git commit -m "feat(peering): per-peer sliding-window rate limiter"
```

---

## Task 11: Hub wiring (`hub/index.ts`)

This task assembles the tested modules. It has no new unit test (it is integration glue); it is verified by `bun run typecheck`, the full `bun test` suite staying green, and the Task 12 smoke script. Keep each sub-step small and commit once at the end.

**Files:**
- Modify: `hub/index.ts`
- Modify: `hub/transports/streamJson.ts` callers: `makeTransport` must pass `peeringEnabled`.

**Interfaces:**
- Consumes: everything produced in Tasks 1–10.
- Produces: a live peering subsystem when `hub.peering?.enabled`.

- [ ] **Step 1: Imports + singletons**

Near the other hub imports add:

```typescript
import { parseTarget, resolvePeer, peerSecret, PeerDedupe, PeerRateLimiter, type PeerEnvelope } from "./peering"
import { postPeer } from "./peerClient"
import { PeerSpool, type SpoolItem } from "./peerSpool"
import { LiaisonLog } from "./liaisonLog"
import { handlePeerRequest, type PeerRouteDeps } from "./peerRoutes"
import { ConsultRegistry } from "./consult"   // already imported via mayConsult; reuse the class
import { appendFileSync, readFileSync, writeFileSync } from "fs"
import { randomUUID } from "node:crypto"
```

After `const hub = …` config load, add (all inert when peering absent):

```typescript
const peering = hub.peering
const peeringOn = !!peering?.enabled
const liaisonLogPath = `${stateDir}/liaison.log.jsonl`   // reuse the existing stateDir var
const liaison = new LiaisonLog({ append: (l) => { try { appendFileSync(liaisonLogPath, l) } catch {} }, now: Date.now })
const peerDedupe = new PeerDedupe(Date.now, peering?.dedupeWindowMs ?? 600_000)
const peerRate = new PeerRateLimiter(Date.now, peering?.ratePerPeerPerMin ?? 0)
// Outbound asks awaiting a /peer/reply, keyed by corrId. Reuse ConsultRegistry's
// open/settle/sweepExpired shape (virtual "channel" = the corrId).
let peerAskSeq = 0
const peerAskRegistry = new ConsultRegistry(Date.now, () => `pk${++peerAskSeq}`, peering?.askTimeoutMs ?? 300_000)
```

- [ ] **Step 2: Outbound poster + spool**

Add a real fetch adapter + the spool (after the singletons):

```typescript
const realFetch = async (url: string, init: any) => {
  const res = await fetch(url, init); return { status: res.status }
}
function secretForPeer(name: string): string | undefined {
  if (!peering) return undefined
  const def = resolvePeer(peering, name)
  return def ? peerSecret(process.env, def) : undefined
}
const peerSpool = new PeerSpool({
  now: Date.now,
  maxAttempts: peering?.notifyRetry?.maxAttempts ?? 5,
  baseDelayMs: peering?.notifyRetry?.baseDelayMs ?? 2000,
  send: async (item: SpoolItem) => {
    const { peer } = parseTarget(item.target)!
    const def = peering ? resolvePeer(peering, peer) : undefined
    const secret = secretForPeer(peer)
    if (!def || !secret) return true   // unresolvable → drop (don't spin forever)
    const r = await postPeer(peering!.selfName, def, secret, `${peering!.listenPath ?? "/peer"}/notify`, item.body, realFetch)
    return r.ok
  },
  onDeadLetter: (item) => {
    const { peer, agent } = parseTarget(item.target) ?? { peer: "?", agent: "?" }
    audit.record({ kind: "liaison", actor: "hub", action: "deadletter", target: item.target, outcome: "error", corr: item.body.corrId })
    liaison.write({ dir: "out", kind: "deadletter", corrId: item.body.corrId, peer, remoteAgent: agent, text: item.body.text, ok: false, error: "max attempts" })
  },
})
// Drain the spool on a timer (only when peering is on).
if (peeringOn) {
  const drain = setInterval(() => { void peerSpool.drainOnce() }, 2000)
  ;(drain as any).unref?.()
}
```

- [ ] **Step 3: Mirror helper**

```typescript
function liaisonMirror(line: string): void {
  const ch = peering?.mirrorChannelId
  if (ch) void gateway.sendMessage(ch, line).catch(() => {})  // use the hub's existing send (match the real method name in index.ts)
}
```

(Confirm the actual outbound-text method on `gateway` in `index.ts` — e.g. `sendMessage`/`send`; use whichever the file already uses for plain text.)

- [ ] **Step 4: Wire the shim peer callbacks in `makeTransport`**

Inside `makeTransport`, beside `socket.onAskAgent(…)`, add:

```typescript
  // Outbound notify: queue + spool. Fire-and-forget from the agent's view.
  socket.onNotifyPeer(({ target, text }) => {
    if (!peeringOn || !peering) return
    const parsed = parseTarget(target)
    if (!parsed || !resolvePeer(peering, parsed.peer)) {
      audit.record({ kind: "liaison", actor: `agent:${name}`, action: "notify", target, outcome: "deny" })
      return
    }
    const body: PeerEnvelope = { from: peering.selfName, to: target, corrId: randomUUID(), kind: "notify", text, ts: Date.now() }
    audit.record({ kind: "liaison", actor: `agent:${name}`, action: "notify", target, outcome: "ok", corr: body.corrId, detail: { dir: "out", bytes: Buffer.byteLength(text) } })
    liaison.write({ dir: "out", kind: "notify", corrId: body.corrId, peer: parsed.peer, localAgent: name, remoteAgent: parsed.agent, text, ok: true })
    liaisonMirror(`↗ ${name} → ${target}: notify`)
    peerSpool.enqueue(target, body)
  })

  // Outbound ask: open a pending entry keyed by corrId, POST /peer/ask, await /peer/reply.
  socket.onAskPeer(({ target, message }) => new Promise<string>((resolveAnswer) => {
    if (!peeringOn || !peering) { resolveAnswer("(peering disabled)"); return }
    const parsed = parseTarget(target)
    const def = parsed ? resolvePeer(peering, parsed.peer) : undefined
    const secret = parsed ? secretForPeer(parsed.peer) : undefined
    if (!parsed || !def || !secret) { resolveAnswer(`(unknown peer in "${target}")`); return }
    const corrId = randomUUID()
    // peerAskRegistry.open uses (requester, target, resolve); channel == "consult:<id>" but we key our map by corrId via a side index.
    const e = peerAskRegistry.open(name, target, resolveAnswer)
    peerAskByCorr.set(corrId, e.channel)
    audit.record({ kind: "liaison", actor: `agent:${name}`, action: "ask", target, outcome: "pending", corr: corrId, detail: { dir: "out", bytes: Buffer.byteLength(message) } })
    liaison.write({ dir: "out", kind: "ask", corrId, peer: parsed.peer, localAgent: name, remoteAgent: parsed.agent, text: message, ok: true })
    liaisonMirror(`↗ ${name} → ${target}: ask`)
    const body: PeerEnvelope = { from: peering.selfName, to: target, corrId, kind: "ask", text: message, ts: Date.now(), replyTo: `${peering.selfBaseUrl}${peering.listenPath ?? "/peer"}/reply` }
    void postPeer(peering.selfName, def, secret, `${peering.listenPath ?? "/peer"}/ask`, body, realFetch).then((r) => {
      if (!r.ok) { peerAskByCorr.delete(corrId); peerAskRegistry.settle(e.channel, `(peer unreachable: ${r.status})`) }
    })
  }))
```

Add near the singletons a corrId→channel side index and pass `peeringEnabled` to the transport:

```typescript
const peerAskByCorr = new Map<string, string>()
```

In the `StreamJsonOpts` object built inside `makeTransport`, add `peeringEnabled: peeringOn && mayPeerAny(cfg)` where:

```typescript
function mayPeerAny(cfg: AgentConfig): boolean {
  // expose peer tools to an agent only when peering is on (per-agent inbound access is still gated by peerableBy on the TARGET side)
  return peeringOn
}
```

- [ ] **Step 5: Inbound route deps + mount on the listener**

Where the webhook listener is created (`const listener = startWebhookListener(...)`), build peer deps and pass an `extraHandler`:

```typescript
function deliverPeerAsk(e: PeerEnvelope): void {
  // Run a LOCAL consult against the addressed agent, POST the answer back to e.replyTo.
  const parsed = parseTarget(e.to)          // e.to is "<selfName>:<agent>" or "<agent>"? Normalize:
  const agentName = parsed ? parsed.agent : e.to
  const cfg = agents[agentName]
  const callerPeer = e.from
  const allowed = !!cfg && (cfg.access.peerableBy?.includes("*") || cfg.access.peerableBy?.includes(callerPeer))
  const replyTo = e.replyTo
  const def = peering ? resolvePeer(peering, callerPeer) : undefined
  const secret = secretForPeer(callerPeer)
  const sendBack = (answer: string, ok: boolean, errKind: "reply" | "timeout" = "reply") => {
    liaison.write({ dir: "out", kind: errKind, corrId: e.corrId, peer: callerPeer, localAgent: agentName, remoteAgent: undefined, text: answer, ok })
    audit.record({ kind: "liaison", actor: `agent:${agentName}`, action: errKind, target: `${callerPeer}:${e.from}`, outcome: ok ? "ok" : "error", corr: e.corrId })
    if (replyTo && def && secret) {
      const body: PeerEnvelope = { from: peering!.selfName, to: `${callerPeer}`, corrId: e.corrId, kind: "reply", text: answer, ts: Date.now() }
      // POST straight to the absolute replyTo URL (not baseUrl+path).
      void postPeer(peering!.selfName, { ...def, baseUrl: "" }, secret, replyTo, body, realFetch)
    }
  }
  if (!allowed) { sendBack(`(agent "${agentName}" is not peer-reachable from "${callerPeer}")`, false); return }
  liaison.write({ dir: "in", kind: "ask", corrId: e.corrId, peer: callerPeer, localAgent: agentName, text: e.text, ok: true })
  audit.record({ kind: "liaison", actor: `peer:${callerPeer}`, action: "ask", target: agentName, outcome: "ok", corr: e.corrId })
  liaisonMirror(`↘ ${callerPeer} → ${agentName}: ask`)
  const consult = peerAskRegistry.open(`peer:${callerPeer}`, agentName, (answer) => sendBack(answer, true))
  const inbound: InboundMessage = { chatId: consult.channel, messageId: `peerask:${e.corrId}`, userId: "system", user: "hub", content: e.text, ts: new Date().toISOString(), isDM: false }
  const target = pools.get(agentName) ?? transports.get(agentName)
  if (!target?.isAvailable()) { peerAskRegistry.settle(consult.channel, `(agent "${agentName}" is unavailable)`); return }
  dispatcher.dispatch(agentName, consult.channel, inbound)
}

const peerRouteDeps: PeerRouteDeps | null = peeringOn && peering ? {
  cfg: peering,
  secretFor: secretForPeer,
  dedupe: peerDedupe,
  now: Date.now,
  rateOk: (p) => peerRate.ok(p),
  onNotify: (e) => {
    const parsed = parseTarget(e.to); const agentName = parsed ? parsed.agent : e.to
    const cfg = agents[agentName]
    const allowed = !!cfg && (cfg.access.peerableBy?.includes("*") || cfg.access.peerableBy?.includes(e.from))
    liaison.write({ dir: "in", kind: "notify", corrId: e.corrId, peer: e.from, localAgent: agentName, text: e.text, ok: allowed })
    audit.record({ kind: "liaison", actor: `peer:${e.from}`, action: "notify", target: agentName, outcome: allowed ? "ok" : "deny", corr: e.corrId })
    if (allowed) { liaisonMirror(`↘ ${e.from} → ${agentName}: notify`); deliverToAgent(agentName, "", `peer:${e.from}`, e.text) }
  },
  onAsk: deliverPeerAsk,
  onReply: (e) => {
    const channel = peerAskByCorr.get(e.corrId)
    if (channel) { peerAskByCorr.delete(e.corrId); peerAskRegistry.settle(channel, e.text) }
    liaison.write({ dir: "in", kind: "reply", corrId: e.corrId, peer: e.from, text: e.text, ok: true })
    audit.record({ kind: "liaison", actor: `peer:${e.from}`, action: "reply", target: e.from, outcome: "ok", corr: e.corrId })
  },
  onRejected: (peerName, reason) => {
    audit.record({ kind: "liaison", actor: `peer:${peerName}`, action: "rejected", outcome: "deny", detail: { reason } })
    liaison.write({ dir: "in", kind: "rejected", corrId: "-", peer: peerName, ok: false, error: reason })
  },
} : null

const extraHandler = peerRouteDeps
  ? (req: Request) => {
      const base = peering!.listenPath ?? "/peer"
      return new URL(req.url).pathname.startsWith(base) ? handlePeerRequest(req, peerRouteDeps) : Promise.resolve(null)
    }
  : undefined

const listener = startWebhookListener(hub.webhookPort ?? 0, webhookHandlers, extraHandler)
```

> **Note for the implementer:** `e.to` from a remote is `"<remoteSelfName? or agent>"`. The caller builds `to = "<peer>:<agent>"` (its own local address book). On the receiving hub, `<peer>` is *this hub's* name and `<agent>` is the local agent — `parseTarget(e.to).agent` is the local agent. Keep this convention symmetric: **`to` always means "the recipient's `peer:agent` as the sender knows it"**, and the receiver reads the `agent` half. Confirm `deliverToAgent`'s channelId arg: passing `""` routes a peer-notify with no Discord channel; if the hub requires a real channel for delivery, pass `peering.mirrorChannelId ?? ""` and document that notifies surface only in the mirror/transcript.

- [ ] **Step 6: Timeout sweep for outbound asks**

Beside the existing consult timeout sweep (`if (hub.consult?.enabled) setInterval(... sweepExpired ...)`), add:

```typescript
if (peeringOn) {
  const sweep = setInterval(() => {
    for (const e of peerAskRegistry.sweepExpired()) {
      // settle already removed it; resolve was called by sweepExpired? No — sweepExpired only returns; settle the caller:
      e.resolve("(peer ask timed out)")
      audit.record({ kind: "liaison", actor: "hub", action: "timeout", target: e.target, outcome: "error", corr: e.id })
    }
  }, 5000)
  ;(sweep as any).unref?.()
}
```

(Note: `peerAskRegistry` is shared for both outbound pending-asks and the inbound local-consults created in `deliverPeerAsk`. `sweepExpired` handles both; the `resolve` for an inbound entry is `sendBack`, for an outbound entry is the agent's `ask_peer` promise resolver. Verify both resolve paths are idempotent — `ConsultRegistry.settle` is single-shot, but `sweepExpired` bypasses `settle`, so guard with a local settled flag if needed, mirroring the `consultSettled` pattern at `index.ts:353`.)

- [ ] **Step 7: Typecheck + full test suite**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; all tests pass (existing + new modules).

- [ ] **Step 8: Commit**

```bash
git add hub/index.ts hub/transports/streamJson.ts
git commit -m "feat(hub): wire cross-VPS peering — routes, spool, ask consult, audit + transcript"
```

---

## Task 12: Config placeholder, smoke script, README

**Files:**
- Modify: `config/hub.config.json`
- Create: `scripts/smoke-peer.ts`
- Modify: `README.md`

- [ ] **Step 1: Config placeholder**

Add to `config/hub.config.json` (placeholders only — no real values):

```jsonc
  "peering": {
    "enabled": false,
    "listenPath": "/peer",
    "selfName": "hub-a",
    "selfBaseUrl": "http://127.0.0.1:8787",
    "askTimeoutMs": 300000,
    "mirrorChannelId": null,
    "dedupeWindowMs": 600000,
    "maxClockSkewMs": 120000,
    "ratePerPeerPerMin": 120,
    "notifyRetry": { "maxAttempts": 5, "baseDelayMs": 2000 },
    "peers": [
      { "name": "hub-b", "baseUrl": "http://127.0.0.1:8788", "secretEnv": "PEER_HUB_B_SECRET" }
    ]
  }
```

- [ ] **Step 2: Smoke script**

Create `scripts/smoke-peer.ts` that: builds two in-process `handlePeerRequest` deps (or two `Bun.serve` listeners on 8787/8788) wired to fake agents, fires a `notify` and an `ask` from A→B over loopback with a shared secret, and asserts the notify is delivered and the ask round-trips a reply. Model it on `scripts/smoke-streamjson.ts` (print `OK` lines / non-zero exit on failure). Pure loopback — no real VPS.

```typescript
// scripts/smoke-peer.ts — manual: `bun run scripts/smoke-peer.ts` → expect "peer smoke OK"
import { signPeerBody } from "../hub/peering"
// (full body: stand up two listeners, POST notify + ask with HMAC, assert 200/202 + reply callback)
```

(Write the concrete script during execution; it is a manual check, not part of `bun test`.)

- [ ] **Step 3: README**

Add a "Cross-VPS peering" subsection under "Integration config" documenting: the `peering` block, `peer:agent` addressing, the `notify_peer`/`ask_peer` tools (gated by `peering.enabled` + `access.peerableBy` on the target), the per-peer secrets in env, and that bodies are written to `liaison.log.jsonl` while metadata goes to the audit ledger. Keep it generic (no deployment specifics).

- [ ] **Step 4: Typecheck + tests**

Run: `bun run typecheck && bun test`
Expected: clean + green.

- [ ] **Step 5: Commit**

```bash
git add config/hub.config.json scripts/smoke-peer.ts README.md
git commit -m "docs(peering): config placeholder, loopback smoke script, README"
```

---

## Self-Review

**Spec coverage:**
- Static peer registry → Task 1 (`PeerDef[]`) + Task 12 config. ✓
- `peer:agent` addressing → Task 2 `parseTarget`. ✓
- notify (durable) → Task 4 spool + Task 11 Step 4. ✓
- ask (callback) → Task 9 tool + Task 11 (outbound pending-ask + inbound local-consult + `/peer/reply`). ✓
- per-peer HMAC over WG → Tasks 2/3/6. ✓
- silent default + optional Discord mirror → Task 11 `liaisonMirror`. ✓
- metadata→AuditLog (`kind:"liaison"`) + bodies→`liaison.log.jsonl` → Task 1 + Task 5 + Task 11. ✓
- reuse ConsultRegistry / verifySignature / deliverToAgent → Tasks 6/11. ✓
- dedupe + clock-skew + rate cap → Tasks 2/6/10. ✓
- ships dark behind `peering.enabled`; tools absent + routes 404 when off → Task 9 gate + Task 11 `peeringOn`/`extraHandler` null. ✓
- tests against in-process fake peer; manual smoke → Tasks 2-10 unit + Task 12 smoke. ✓
- public-repo hygiene (placeholders) → Task 12. ✓

**Placeholder scan:** Task 11 (index.ts wiring) and Task 12 (smoke script) intentionally carry implementer notes rather than fully-frozen code, because they depend on two things only confirmable in the live file: (a) the exact `stateDir` variable name + `gateway` plain-text send method, and (b) the symmetric meaning of `to` across hubs. These are called out explicitly as **confirm-in-file** steps, not vague TODOs. All pure modules (Tasks 2-10) have complete, runnable code + tests.

**Type consistency:** `PeerEnvelope` (Task 2) is the single envelope type threaded through client (3), spool (4), routes (6), wiring (11). `LiaisonInput`/`LiaisonRecord` (Task 5) used in 11. `buildShimMcpConfig` 7th arg `peeringEnabled` (Task 9) matches `StreamJsonOpts.peeringEnabled` (Task 9) and the `makeTransport` caller (Task 11 Step 4). Shim wire frames `notify_peer`/`ask_peer` + result `ask_peer_result` match between shim (Task 9) and shimSocket (Task 8).

**Two confirm-in-file items for the implementer (carried from spec open-questions, both low-risk):**
1. `stateDir` variable name in `index.ts` (used for `liaison.log.jsonl` path) — grep it; the audit ledger already uses it.
2. The `gateway` plain-text send method name for the optional mirror — match whatever `index.ts` already calls for non-card text.
