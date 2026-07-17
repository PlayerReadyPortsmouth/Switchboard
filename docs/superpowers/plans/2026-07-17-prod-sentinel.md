# prod-sentinel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ReadyApp `api` 5xx/unhandled error becomes a signed webhook to Switchboard, where a new persistent `prod-sentinel` agent root-causes it against the deployed source and files (or bumps) one triaged Bug-board card.

**Architecture:** Two repos. ReadyApp adds a fail-open, flag-gated `reportProdError()` called from the Fastify error handler + crash handlers; it dedups by signature at the source and POSTs an HMAC-signed payload to `http://127.0.0.1:4400/hooks/prod-error`. Switchboard adds a webhook route + a persistent, read-only, Opus-backed agent whose system prompt is the triage SOP.

**Tech Stack:** ReadyApp `apps/api` (Fastify 5, TypeScript ESM, vitest, `@tutoring/api`); Switchboard (Bun hub, JSON config); Node `crypto` (sha256/HMAC).

## Global Constraints

- **Emit is fail-open:** `reportProdError` must NEVER throw or block the request path — wrap everything in try/catch, fire-and-forget. Copied from spec.
- **Emit is flag-gated fail-closed:** no-op unless AppSetting `prod_sentinel_emit === "true"`. Absent/any-other value = off. Byte-identical to today when off.
- **Only 5xx / unhandled** are reported; anything `< 500` is skipped.
- **HMAC signing:** header `X-Switchboard-Signature: sha256=<hex>` over the raw JSON body, secret `PROD_SENTINEL_WEBHOOK_SECRET` (same value both sides). This is the scheme the hub's `webhookListener` already verifies.
- **Agent is read-only:** `prod-sentinel` toolset is `Read/Grep/Glob/Bash` only — NO `Edit`/`Write`. It never modifies code. Model `claude-opus-4-8`.
- **Dedup key** is the 16-hex `signature`; every card carries a hidden `sentinel-sig:<signature>` marker line for board-check dedup.
- **Scope:** ReadyApp `api` only. **Deploys:** ReadyApp via `live` with `[deploy: api]`; Switchboard config is edited on the VPS (`/srv/ready-switchboard/config`) + `!reload hard`.
- **ReadyApp test conventions:** colocated `*.test.ts`, vitest, inject IO (fetch/clock/getSetting) as params — no real network/DB in these units.

---

## Phase A — ReadyApp `api` error-emit

### Task A1: Error signature helpers

**Files:**
- Create: `apps/api/src/lib/prodSentinel.ts`
- Test: `apps/api/src/lib/prodSentinel.test.ts`

**Interfaces:**
- Produces: `normalizeMessage(message: string): string`, `topAppFrame(stack: string): string`, `computeSignature(message: string, stack: string): string` (16 lowercase hex chars).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/prodSentinel.test.ts
import { describe, it, expect } from "vitest";
import { normalizeMessage, topAppFrame, computeSignature } from "./prodSentinel";

describe("prodSentinel signature", () => {
  it("normalizeMessage strips uuids, numbers, and quoted values", () => {
    expect(normalizeMessage("No deal 550e8400-e29b-41d4-a716-446655440000 for id 42 'abc'"))
      .toBe("No deal ? for id ? ?");
  });

  it("topAppFrame picks the first app frame, skipping node_modules", () => {
    const stack = [
      "Error: boom",
      "    at Object.foo (/srv/readyapp/node_modules/x/index.js:1:1)",
      "    at handler (/srv/readyapp/apps/api/src/routes/sessions.ts:120:9)",
    ].join("\n");
    expect(topAppFrame(stack)).toContain("apps/api/src/routes/sessions.ts:120:9");
  });

  it("computeSignature is stable across volatile substrings and is 16 hex chars", () => {
    const a = computeSignature("failed for id 1", "at h (/srv/readyapp/apps/api/src/x.ts:1:1)");
    const b = computeSignature("failed for id 99", "at h (/srv/readyapp/apps/api/src/x.ts:1:1)");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts`
Expected: FAIL — `prodSentinel` has no such exports.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/lib/prodSentinel.ts
import { createHash } from "node:crypto";

const VOLATILE: RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // uuid
  /'[^']*'|"[^"]*"/g,                                               // quoted values
  /\b\d+\b/g,                                                       // bare numbers
];

export function normalizeMessage(message: string): string {
  let m = message;
  for (const re of VOLATILE) m = m.replace(re, "?");
  return m.replace(/\s+/g, " ").trim();
}

export function topAppFrame(stack: string): string {
  const frames = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
  return (
    frames.find((l) => l.includes("apps/") && !l.includes("node_modules")) ??
    frames[0] ??
    ""
  );
}

export function computeSignature(message: string, stack: string): string {
  const basis = `${normalizeMessage(message)}\n${topAppFrame(stack)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/prodSentinel.ts apps/api/src/lib/prodSentinel.test.ts
git commit -m "feat(api): prod-sentinel error signature helpers"
```

---

### Task A2: Source-side dedup + cooldown

**Files:**
- Modify: `apps/api/src/lib/prodSentinel.ts`
- Test: `apps/api/src/lib/prodSentinel.test.ts`

**Interfaces:**
- Produces: `class ProdErrorDedup { constructor(cooldownMs: number, maxEntries?: number); record(signature: string, nowMs: number): { count: number; firstSeenMs: number } | null }`. Returns the emit info (with the count accumulated since the last emit) on first sighting or once the cooldown has elapsed since the last emit; returns `null` (suppress) otherwise.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/api/src/lib/prodSentinel.test.ts
import { ProdErrorDedup } from "./prodSentinel";

describe("ProdErrorDedup", () => {
  it("emits the first sighting with count 1", () => {
    const d = new ProdErrorDedup(600_000);
    expect(d.record("sig", 0)).toEqual({ count: 1, firstSeenMs: 0 });
  });

  it("suppresses repeats within the cooldown, then emits with the suppressed count", () => {
    const d = new ProdErrorDedup(600_000);
    expect(d.record("sig", 0)).toEqual({ count: 1, firstSeenMs: 0 });     // emit
    expect(d.record("sig", 1_000)).toBeNull();                             // within cooldown
    expect(d.record("sig", 2_000)).toBeNull();
    const out = d.record("sig", 600_001);                                  // cooldown elapsed
    expect(out).toEqual({ count: 3, firstSeenMs: 1_000 });                 // 3 suppressed since last emit
  });

  it("tracks distinct signatures independently", () => {
    const d = new ProdErrorDedup(600_000);
    expect(d.record("a", 0)).not.toBeNull();
    expect(d.record("b", 0)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts`
Expected: FAIL — `ProdErrorDedup` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to apps/api/src/lib/prodSentinel.ts
interface WindowState { count: number; firstSeenMs: number; lastEmitMs: number }

export class ProdErrorDedup {
  private readonly windows = new Map<string, WindowState>();
  constructor(private readonly cooldownMs: number, private readonly maxEntries = 500) {}

  record(signature: string, nowMs: number): { count: number; firstSeenMs: number } | null {
    const w = this.windows.get(signature);
    if (!w) {
      this.windows.set(signature, { count: 0, firstSeenMs: nowMs, lastEmitMs: nowMs });
      this.evict();
      return { count: 1, firstSeenMs: nowMs };
    }
    w.count += 1;
    if (nowMs - w.lastEmitMs >= this.cooldownMs) {
      const out = { count: w.count, firstSeenMs: w.firstSeenMs };
      w.count = 0;
      w.firstSeenMs = nowMs;
      w.lastEmitMs = nowMs;
      return out;
    }
    return null;
  }

  private evict(): void {
    if (this.windows.size <= this.maxEntries) return;
    const oldest = this.windows.keys().next().value;
    if (oldest !== undefined) this.windows.delete(oldest);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/prodSentinel.ts apps/api/src/lib/prodSentinel.test.ts
git commit -m "feat(api): prod-sentinel source-side dedup + cooldown"
```

---

### Task A3: `reportProdError` — flag-gated, signed, fail-open POST

**Files:**
- Modify: `apps/api/src/lib/prodSentinel.ts`
- Test: `apps/api/src/lib/prodSentinel.test.ts`

**Interfaces:**
- Consumes: `computeSignature`, `ProdErrorDedup` (Task A1/A2); `getCachedSetting` from `./appSettingCache.js`.
- Produces: `PROD_SENTINEL_FLAG_KEY = "prod_sentinel_emit"`; `interface ProdErrorContext { route?: string; statusCode?: number }`; `reportProdError(err: unknown, ctx?: ProdErrorContext, deps?: { fetch?: typeof fetch; now?: () => number; getSetting?: (key: string) => Promise<string | null> }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/api/src/lib/prodSentinel.test.ts
import { reportProdError, PROD_SENTINEL_FLAG_KEY } from "./prodSentinel";
import { createHmac } from "node:crypto";

const on = async () => "true";
const off = async () => "false";

function harness(overrides: Partial<Parameters<typeof reportProdError>[2]> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetch: fetchMock, now: () => 1_000, getSetting: on, ...overrides } };
}

describe("reportProdError", () => {
  const OLD = process.env;
  beforeEach(() => {
    process.env = { ...OLD, PROD_SENTINEL_WEBHOOK_URL: "http://127.0.0.1:4400/hooks/prod-error", PROD_SENTINEL_WEBHOOK_SECRET: "s3cret", GIT_SHA: "abc1234" };
  });
  afterEach(() => { process.env = OLD; });

  it("no-op when the flag is off", async () => {
    const { calls, deps } = harness({ getSetting: off });
    await reportProdError(new Error("boom"), { statusCode: 500 }, deps);
    expect(calls).toHaveLength(0);
  });

  it("skips < 500", async () => {
    const { calls, deps } = harness();
    await reportProdError(new Error("bad request"), { statusCode: 400 }, deps);
    expect(calls).toHaveLength(0);
  });

  it("POSTs a signed payload for a 500", async () => {
    const { calls, deps } = harness();
    await reportProdError(new Error("boom"), { statusCode: 500, route: "POST /x" }, deps);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("http://127.0.0.1:4400/hooks/prod-error");
    const body = init.body as string;
    const expectedSig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect((init.headers as Record<string, string>)["x-switchboard-signature"]).toBe(expectedSig);
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ statusCode: 500, route: "POST /x", release: "abc1234", count: 1 });
    expect(parsed.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is fail-open when fetch throws", async () => {
    const throwing = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const { deps } = harness({ fetch: throwing });
    await expect(reportProdError(new Error("boom"), { statusCode: 500 }, deps)).resolves.toBeUndefined();
  });

  it("exports the flag key", () => { expect(PROD_SENTINEL_FLAG_KEY).toBe("prod_sentinel_emit"); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts`
Expected: FAIL — `reportProdError` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to apps/api/src/lib/prodSentinel.ts
import { createHmac } from "node:crypto";
import { getCachedSetting } from "./appSettingCache.js";

export const PROD_SENTINEL_FLAG_KEY = "prod_sentinel_emit";

export interface ProdErrorContext { route?: string; statusCode?: number }

const dedup = new ProdErrorDedup(Number(process.env.PROD_SENTINEL_COOLDOWN_MS ?? 600_000));

export async function reportProdError(
  err: unknown,
  ctx: ProdErrorContext = {},
  deps: { fetch?: typeof fetch; now?: () => number; getSetting?: (key: string) => Promise<string | null> } = {},
): Promise<void> {
  try {
    const statusCode = ctx.statusCode ?? 500;
    if (statusCode < 500) return;

    const url = process.env.PROD_SENTINEL_WEBHOOK_URL;
    const secret = process.env.PROD_SENTINEL_WEBHOOK_SECRET;
    if (!url || !secret) return;

    const getSetting = deps.getSetting ?? getCachedSetting;
    if ((await getSetting(PROD_SENTINEL_FLAG_KEY)) !== "true") return; // fail-closed

    const now = (deps.now ?? Date.now)();
    const e = err instanceof Error ? err : new Error(String(err));
    const stack = e.stack ?? "";
    const signature = computeSignature(e.message, stack);

    const window = dedup.record(signature, now);
    if (!window) return; // within cooldown → suppressed

    const payload = {
      signature,
      message: e.message,
      errorName: e.name,
      stack: stack.split("\n").map((s) => s.trim()).filter((l) => l.startsWith("at ") && !l.includes("node_modules")).slice(0, 12),
      route: ctx.route ?? null,
      statusCode,
      release: process.env.GIT_SHA ?? null,
      environment: process.env.READYAPP_MODE ?? process.env.NODE_ENV ?? "production",
      count: window.count,
      firstSeen: new Date(window.firstSeenMs).toISOString(),
      lastSeen: new Date(now).toISOString(),
    };
    const body = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": sig },
      body,
    });
  } catch {
    // fail-open: error reporting must never affect the request path
  }
}
```

Note: add `import { beforeEach, afterEach } from "vitest";` to the test file's imports if not already present.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts`
Expected: PASS (all tests). Then `pnpm --filter @tutoring/api typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/prodSentinel.ts apps/api/src/lib/prodSentinel.test.ts
git commit -m "feat(api): reportProdError flag-gated signed fail-open emit"
```

---

### Task A4: Wire `reportProdError` into the server error paths

**Files:**
- Modify: `apps/api/src/server.ts` (setErrorHandler ~line 822; crash handlers ~lines 1566 & 1575)

**Interfaces:**
- Consumes: `reportProdError` from `./lib/prodSentinel.js`.

- [ ] **Step 1: Add the import**

At the top of `apps/api/src/server.ts` with the other `./lib` imports:
```ts
import { reportProdError } from "./lib/prodSentinel.js";
```

- [ ] **Step 2: Call it in the Fastify error handler**

In `server.setErrorHandler(...)`, immediately after the `appendLog({...});` call (currently ends ~line 822) and before `if (reply.sent) return;`, add:
```ts
  if (statusCode >= 500) {
    void reportProdError(error, { route: `${request.method} ${route}`, statusCode });
  }
```
(`statusCode` and `route` are already in scope from lines 796 and 803.)

- [ ] **Step 3: Call it in the crash handlers**

In `process.on("unhandledRejection", (reason) => { ... })` (~1566), after the `Sentry.captureException` line add:
```ts
  void reportProdError(reason, { route: "unhandledRejection", statusCode: 500 });
```
In `process.on("uncaughtException", (err) => { ... })` (~1575), after `server.log.error(...)` and before the Sentry/exit block add:
```ts
  void reportProdError(err, { route: "uncaughtException", statusCode: 500 });
```
(`void` keeps these fire-and-forget; `reportProdError` never rejects.)

- [ ] **Step 4: Typecheck + full api test suite (no regressions)**

Run: `pnpm --filter @tutoring/api typecheck`
Expected: clean.
Run: `pnpm --filter @tutoring/api exec vitest run src/lib/prodSentinel.test.ts src/server.test.ts` (run `src/server.test.ts` only if it exists; otherwise just the prodSentinel file).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): report 5xx and crashes to prod-sentinel"
```

---

## Phase B — Switchboard agent + wiring (on the VPS)

> These tasks edit live config on `readyapp-newvps` (`ssh readyapp-newvps`). Back up each file before editing (`cp x x.bak-$(date -u +%Y%m%d-%H%M%S)`). Config: `/srv/ready-switchboard/config/`. Env: `~/.switchboard/.env`.

### Task B1: Provision — channel, secret, target URL

**Files:**
- Modify: `~/.switchboard/.env` (add `PROD_SENTINEL_WEBHOOK_SECRET`)
- Modify: `/srv/readyapp/env/api.env` (add `PROD_SENTINEL_WEBHOOK_URL`, `PROD_SENTINEL_WEBHOOK_SECRET`)

- [ ] **Step 1: Create the `#prod-incidents` Discord channel** in the Switchboard guild (`1496399691716497490`); copy its channel id (right-click → Copy Channel ID). Record it as `PROD_INCIDENTS_CHANNEL_ID` for Task B2.

- [ ] **Step 2: Generate one shared secret**

```bash
openssl rand -hex 32   # use this value for BOTH env files below (same value)
```

- [ ] **Step 3: Set it on the Switchboard side**

```bash
ssh readyapp-newvps 'printf "\nPROD_SENTINEL_WEBHOOK_SECRET=%s\n" "<SECRET>" >> ~/.switchboard/.env'
```

- [ ] **Step 4: Set it + the target URL on the ReadyApp side**

```bash
ssh readyapp-newvps 'cp /srv/readyapp/env/api.env /srv/readyapp/env/api.env.bak-prodsentinel-$(date -u +%Y%m%d-%H%M%S); printf "\nexport PROD_SENTINEL_WEBHOOK_URL=http://127.0.0.1:4400/hooks/prod-error\nexport PROD_SENTINEL_WEBHOOK_SECRET=%s\n" "<SECRET>" >> /srv/readyapp/env/api.env'
```
(These take effect on the api's next reload — Phase C. `4400` is the hub's webhook listener, already bound `*:4400`.)

- [ ] **Step 5: No commit** (VPS-only, secrets). Note the channel id + that the secret is set in both envs.

---

### Task B2: Add the webhook route + `prod-sentinel` agent

**Files:**
- Modify: `/srv/ready-switchboard/config/hub.config.json` (append to `webhooks`)
- Modify: `/srv/ready-switchboard/config/agents.json` (add `prod-sentinel`)

**Interfaces:**
- Consumes: the payload shape POSTed by `reportProdError` (Task A3); `PROD_INCIDENTS_CHANNEL_ID` (Task B1).

- [ ] **Step 1: Back up both config files**

```bash
ssh readyapp-newvps 'cd /srv/ready-switchboard/config && for f in hub.config.json agents.json; do cp "$f" "$f.bak-prodsentinel-$(date -u +%Y%m%d-%H%M%S)"; done'
```

- [ ] **Step 2: Add the webhook route** to `hub.config.json`'s `webhooks` array (use `jq` to stay valid JSON):

```bash
ssh readyapp-newvps 'cd /srv/ready-switchboard/config && jq ".webhooks += [{\"path\":\"/hooks/prod-error\",\"secretEnv\":\"PROD_SENTINEL_WEBHOOK_SECRET\",\"agent\":\"prod-sentinel\",\"channelId\":\"<PROD_INCIDENTS_CHANNEL_ID>\",\"prefix\":\"PROD_ERROR\"}]" hub.config.json > /tmp/hub.new.json && jq empty /tmp/hub.new.json && mv /tmp/hub.new.json hub.config.json && echo OK'
```

- [ ] **Step 3: Add the `prod-sentinel` agent** to `agents.json`. Write the SOP to a file first (multi-line), then `jq` it in:

```bash
cat > /tmp/prod-sentinel-sop.txt <<'SOP'
You are **prod-sentinel**. You watch ReadyApp production errors and turn each into ONE triaged Bug-board card. You NEVER edit, fix, or write code — you only read, diagnose, and file/update cards.

Your input is a single message beginning with `PROD_ERROR ` followed by JSON: {signature, message, errorName, stack[], route, statusCode, release, environment, count, firstSeen, lastSeen}. Parse it. Let SIG = the signature.

Work in `/srv/readyapp` (the live deploy checkout, at the commit named by `release`). Read-only: never write there.

## Step 1 — Dedup against the board
Search the ReadyApp "Bug fixes" board for an OPEN card whose body contains the exact marker `sentinel-sig:SIG`. Use the board/ticket search tools.
- If one exists: add a comment noting a new occurrence window (the new `count`, `firstSeen`→`lastSeen`, and `release` if it changed), then STOP. Do not create a second card. Do not ping unless your reassessed severity has risen to `high` for the first time (then post the ping in Step 4).

## Step 2 — Root-cause
Open the first app frame in `stack` (a `apps/...:line:col` path) in `/srv/readyapp`; read that code and its immediate callers; grep for the failing pattern if useful. Form a ONE-paragraph suspected-cause hypothesis. Note whether `release` matches a very recent deploy (a regression signal).

## Step 3 — File the card
Create a card on the "Bug fixes" board:
- Title: a concise summary — `<statusCode> <route> — <errorName>: <short message>` (e.g. `500 POST /sessions/:id/attendance — TypeError reading 'id'`).
- Body, in this order:
  - **Suspected cause:** your one-paragraph hypothesis, naming the `file:line`.
  - **Error:** `errorName: message`
  - **Where:** `route` (method+path), `release` (GIT_SHA).
  - **Frequency:** `count` occurrences, first `firstSeen`, last `lastSeen`.
  - **Stack (top app frames):** the `stack` array, fenced.
  - A final line, verbatim: `sentinel-sig:SIG` (replace SIG with the real signature — this is how you dedup next time).
- Severity label (see rubric).

## Step 4 — Escalate only if high-severity
If severity is `high`, post ONE line to this channel (#prod-incidents), @-mentioning Aurora (`<@186188409499418628>`), linking the card. Medium/low: file the card silently, say nothing in the channel.

## Severity rubric
- `high`: touches money / billing / data-integrity / auth / safeguarding, OR a fast broad crash loop (high `count` in a short window).
- `medium`: a real 500 on a normal flow, contained.
- `low`: rare/edge, single occurrence, non-critical path.

## Hard rules
- Never edit/write/fix code or push anything. Read-only investigation only.
- Exactly one card per signature — always Step 1 first.
- If you cannot confidently root-cause, still file the card with the stack + "cause: unknown, needs investigation" rather than skipping it.
SOP
# Then inject it as the appendSystemPrompt of a new agent:
ssh readyapp-newvps 'SOP="$(cat /tmp/prod-sentinel-sop.txt)"; cd /srv/ready-switchboard/config && jq --arg sop "$SOP" ".agents = ((.agents // .) ) | .[\"prod-sentinel\"] = {emoji:\"🚨\",description:\"watches ReadyApp prod errors; root-causes and files triaged Bug-board cards\",mode:\"persistent\",access:{roles:[\"dev\",\"admin\"],users:[\"186188409499418628\"]},runtime:{cwd:\"/srv/readyapp\",model:\"claude-opus-4-8\",allowedTools:[\"Read\",\"Grep\",\"Glob\",\"Bash\"],appendSystemPrompt:$sop,sessionGovernor:{enabled:true,softPct:0.75,hardPct:0.9,strategy:\"restart\"}}} " agents.json > /tmp/agents.new.json && jq empty /tmp/agents.new.json && mv /tmp/agents.new.json agents.json && echo OK'
```

Note: confirm the top-level shape of `agents.json` first (`jq "keys" agents.json`). If agents live under a top-level `agents` object, set `.agents["prod-sentinel"]`; if agents are the top-level object, set `.["prod-sentinel"]`. Adjust the `jq` path accordingly — the example above assumes top-level agent keys (matches `config/agents.example.json`).

- [ ] **Step 4: Hard-reload the hub**

Trigger `!reload hard` in Discord (or restart): `ssh readyapp-newvps 'pm2 restart switchboard-hub'` and confirm `prod-sentinel` appears: `curl -s http://127.0.0.1:8080/api/operations/agents -H "X-Switchboard-User: aurora.nicholas@player-ready.co.uk" | grep -o prod-sentinel`.

- [ ] **Step 5: Commit the SOP to the repo for reviewability** (config lives on the VPS, but keep the SOP text in git):

```bash
# in the Switchboard repo:
mkdir -p config/agents.d
cp <the SOP text> config/agents.d/prod-sentinel.system.md   # copy from /tmp/prod-sentinel-sop.txt
git add config/agents.d/prod-sentinel.system.md
git commit -m "docs(agents): prod-sentinel system prompt (deployed to VPS agents.json)"
```

---

### Task B3: Live smoke — synthetic error → card, then dedup

**Files:** none (verification only).

- [ ] **Step 1: Send a synthetic signed `PROD_ERROR`** to the hub webhook (uses the same HMAC scheme the emit uses):

```bash
ssh readyapp-newvps 'SECRET=$(grep "^PROD_SENTINEL_WEBHOOK_SECRET=" ~/.switchboard/.env | cut -d= -f2); BODY="{\"signature\":\"deadbeefdeadbeef\",\"message\":\"synthetic smoke error\",\"errorName\":\"TypeError\",\"stack\":[\"at handler (/srv/readyapp/apps/api/src/routes/sessions.ts:120:9)\"],\"route\":\"POST /smoke\",\"statusCode\":500,\"release\":\"smoketest\",\"environment\":\"production\",\"count\":1,\"firstSeen\":\"2026-07-17T00:00:00Z\",\"lastSeen\":\"2026-07-17T00:00:00Z\"}"; SIG="sha256=$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed "s/^.* //")"; curl -s -o /dev/null -w "webhook -> %{http_code}\n" -X POST http://127.0.0.1:4400/hooks/prod-error -H "content-type: application/json" -H "X-Switchboard-Signature: $SIG" --data "$BODY"'
```
Expected: `webhook -> 200/202`. Within ~1 min, `prod-sentinel` files a card on the Bug fixes board with a `sentinel-sig:deadbeefdeadbeef` marker.

- [ ] **Step 2: Verify the card** exists on the Bug fixes board (via the board UI or an MCP `get_board`/`list_tickets`), with the stack, route, release, and the `sentinel-sig:` marker.

- [ ] **Step 3: Re-send the identical POST** (same `signature`). Expected: `prod-sentinel` **comments on the existing card** (occurrence bump), does NOT create a second card.

- [ ] **Step 4: Clean up** the smoke card (archive/delete it) so it doesn't pollute the board.

---

## Phase C — Rollout

### Task C1: Deploy the ReadyApp emit to `live` (flag OFF, dark)

- [ ] **Step 1:** From the ReadyApp worktree on the feature branch, add the deploy commit and merge to `live`:

```bash
git commit --allow-empty -m "push: add prod-sentinel error emit (flag off) [deploy: api]"
git push origin HEAD:live   # (after review; live auto-deploys the api)
```

- [ ] **Step 2: Confirm the deploy** succeeds and the api is healthy on the new commit:

```bash
ssh readyapp-newvps 'curl -sS localhost:4300/status | head -c 300; echo; pm2 describe api | grep -E "status|uptime"'
```

- [ ] **Step 3: Confirm dark/no-op** — with the flag still off (AppSetting `prod_sentinel_emit` absent), trigger a benign 500 (or just watch normal traffic): NO card should be filed, NO webhook POSTs. `reportProdError` is a no-op when the flag ≠ "true".

### Task C2: Enable + verify end-to-end + tune

- [ ] **Step 1: Enable the flag** — set AppSetting `prod_sentinel_emit = "true"` (via the admin settings UI or the api's settings write path). Confirm the api picks it up within the 60s cache TTL.

- [ ] **Step 2: Drive a real error path** (or re-run the synthetic webhook, but end-to-end this time — cause an actual 500 on a safe endpoint in a controlled way) and confirm the FULL chain: api error → webhook → `prod-sentinel` files ONE triaged card → high-severity pings `#prod-incidents`.

- [ ] **Step 3: Tune** the cooldown window (`PROD_SENTINEL_COOLDOWN_MS`) and the severity rubric based on the first real cards. Widen the flag's rollout once signal quality is confirmed.

---

## Self-review notes

- **Spec coverage:** signal source + filter + signature (A1/A3), source dedup+cooldown (A2), flag-gated fail-open signed emit (A3), server wiring incl. crash handlers (A4), webhook route + agent def + SOP with board-check dedup + severity + read-only + hi-sev ping (B2), smoke incl. dedup (B3), dark→canary rollout (C1/C2). All spec sections map to a task.
- **Placeholders:** `<SECRET>`, `<PROD_INCIDENTS_CHANNEL_ID>`, `<the SOP text>` are intentional fill-at-runtime values (a generated secret, a Discord id, a copy step), not vague requirements — each has an explicit acquisition step (B1/B2).
- **Type consistency:** `computeSignature`/`ProdErrorDedup.record`/`reportProdError` signatures are used identically across A3/A4; the payload fields emitted in A3 match those parsed by the SOP in B2 and the synthetic body in B3.
