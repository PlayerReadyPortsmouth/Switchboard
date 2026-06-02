# Switchboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hub that fans one Discord bot out to many Claude Code agents — each with its own setup — behind a small Claude (Haiku) router with sticky/auto-switch routing and per-role/per-user access control.

**Architecture:** A single **hub** process owns the bot token + Discord gateway (Discord allows only one gateway per token). It resolves the caller's roles/user-id, computes the agents they may use, routes the message via a `claude -p --model claude-haiku-4-5` classifier (sticky binding with confident auto-switch), and dispatches to the chosen agent through one of two transports: **persistent** agents are live `claude --channels` sessions reached over a Unix socket via a thin shim; **ephemeral** agents are headless `claude -p --resume` spawns. Replies are tagged with the agent's emoji/name and chunked to Discord's 2000-char limit.

**Tech Stack:** Bun + TypeScript, discord.js v14, `@modelcontextprotocol/sdk` (shim), Bun's built-in test runner (`bun:test`). Router & ephemeral workers shell out to the `claude` CLI (reusing Claude Code auth — no separate API key).

**Design spec:** `docs/superpowers/specs/2026-06-02-switchboard-design.md`

---

## File structure (decomposition)

```
hub/
  types.ts            # all shared interfaces (InboundMessage, AgentReply, AgentConfig, HubConfig, ...)
  config.ts           # load + validate hub.config.json and agents.json; expand ~ paths
  access.ts           # permittedAgents() — roles/users/"*" → permitted set (pure)
  baseGate.ts         # pairing/allowlist gate over access.json (ported from upstream)
  format.ts           # chunk() + formatOutbound() — tag first chunk, split to 2000 (pure)
  framing.ts          # newline-JSON encode() + LineDecoder (pure; shared with shim)
  router.ts           # buildRouterPrompt / parseRouterOutput / route() (claude -p haiku)
  bindings.ts         # chatKey(), decideAgent() (pure) + BindingStore (persisted)
  permissions.ts      # request_id ↔ agent namespacing for relay (pure map wrapper)
  transports/
    index.ts          # AgentTransport interface + Dispatcher
    headless.ts       # ephemeral: claude -p --resume (injected runner)
    channelShim.ts    # persistent: Unix socket server speaking the framing protocol
  gateway.ts          # discord.js client: inbound parse, role resolution, outbound send
  index.ts            # entry: load config, wire gateway + router + transports + bindings
shim/
  server.ts           # per-persistent-agent MCP channel server → Unix socket
config/
  hub.config.json
  agents.example.json
scripts/
  start-agent.sh
tests/                # mirrors hub/ module names
package.json  tsconfig.json
```

Files that change together live together. Pure logic (`access`, `format`, `framing`, `router` parsing, `bindings` decisions) is isolated from I/O (`gateway`, transports) so the core is unit-tested without Discord or a real `claude` binary. I/O modules take their side-effecting dependency (the discord client, the process runner) as an injected argument so integration tests use stubs.

---

## Phase 0 — Project setup

### Task 1: Scaffold the Bun + TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "switchboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "hub": "bun run hub/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "discord.js": "^14.14.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["hub", "shim", "tests"]
}
```

- [ ] **Step 3: Write a smoke test** in `tests/smoke.test.ts`

```ts
import { test, expect } from "bun:test"

test("test runner works", () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 4: Install deps and run the smoke test**

Run: `bun install && bun test`
Expected: `1 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json tests/smoke.test.ts bun.lock
git commit -m "chore: scaffold Bun + TypeScript project"
```

---

### Task 2: Shared types

**Files:**
- Create: `hub/types.ts`

- [ ] **Step 1: Write `hub/types.ts`** (no test — type-only module, exercised by every later test)

```ts
/** A Discord message normalised for routing. */
export interface InboundMessage {
  chatId: string        // Discord channel id (DM channel or guild channel)
  messageId: string
  userId: string        // author snowflake
  user: string          // author username
  content: string
  ts: string            // ISO timestamp
  isDM: boolean
  attachments?: { name: string; type: string; size: number }[]
}

/** A request from an agent back out to Discord. */
export interface AgentReply {
  agent: string
  kind: "reply" | "react" | "edit"
  chatId: string
  text?: string
  messageId?: string    // for react/edit
  emoji?: string        // for react
  replyTo?: string      // for reply threading
  files?: string[]      // absolute paths for reply attachments
}

export interface AgentAccess {
  roles: string[]       // role names; "*" means any paired user
  users?: string[]      // user snowflakes
}

export interface AgentRuntime {
  cwd: string
  model?: string
  allowedTools?: string[]      // ephemeral only
  claudeArgs?: string[]        // persistent: extra flags for claude --channels
  appendSystemPrompt?: string
}

export interface AgentConfig {
  emoji: string
  description: string
  mode: "persistent" | "ephemeral"
  access: AgentAccess
  runtime: AgentRuntime
}

export type AgentRegistry = Record<string, AgentConfig>

export interface HubConfig {
  botTokenEnv: string
  guildIds: string[]
  socketPath: string
  stateDir: string
  routerModel: string
  switchThreshold: number
  defaultAgent: string
  ephemeralTimeoutMs: number
  tagStyle: "prefix" | "embed"
  chatKeyScope: "user" | "channel"
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add hub/types.ts
git commit -m "feat: shared Switchboard types"
```

---

## Phase 1 — Pure core (access, format, framing)

### Task 3: Access resolution — `permittedAgents()`

**Files:**
- Create: `tests/access.test.ts`
- Create: `hub/access.ts`

- [ ] **Step 1: Write the failing test** in `tests/access.test.ts`

```ts
import { test, expect } from "bun:test"
import { permittedAgents } from "../hub/access"
import type { AgentRegistry } from "../hub/types"

const reg: AgentRegistry = {
  research: { emoji: "🔬", description: "", mode: "persistent",
    access: { roles: ["dev", "admin"], users: [] }, runtime: { cwd: "." } },
  deploy: { emoji: "🚀", description: "", mode: "persistent",
    access: { roles: ["admin"], users: ["111"] }, runtime: { cwd: "." } },
  qa: { emoji: "💡", description: "", mode: "ephemeral",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
}

test("role intersection grants access", () => {
  expect(permittedAgents(reg, ["dev"], "999").sort()).toEqual(["qa", "research"])
})

test("admin sees role-gated agents", () => {
  expect(permittedAgents(reg, ["admin"], "999").sort()).toEqual(["deploy", "qa", "research"])
})

test("user-id grant works without a role", () => {
  expect(permittedAgents(reg, [], "111").sort()).toEqual(["deploy", "qa"])
})

test('"*" agent is available to any paired user', () => {
  expect(permittedAgents(reg, [], "999")).toEqual(["qa"])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/access.test.ts`
Expected: FAIL — `Cannot find module "../hub/access"`.

- [ ] **Step 3: Implement `hub/access.ts`**

```ts
import type { AgentRegistry } from "./types"

/** Agents the caller may use, given their resolved roles and user id. */
export function permittedAgents(
  registry: AgentRegistry,
  callerRoles: string[],
  callerUserId: string,
): string[] {
  const roleSet = new Set(callerRoles)
  const out: string[] = []
  for (const [name, cfg] of Object.entries(registry)) {
    const roles = cfg.access.roles ?? []
    const users = cfg.access.users ?? []
    const ok =
      roles.includes("*") ||
      roles.some(r => roleSet.has(r)) ||
      users.includes(callerUserId)
    if (ok) out.push(name)
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/access.test.ts`
Expected: `4 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/access.ts tests/access.test.ts
git commit -m "feat: per-agent access resolution (roles + users + wildcard)"
```

---

### Task 4: Outbound formatting — chunk + tag

**Files:**
- Create: `tests/format.test.ts`
- Create: `hub/format.ts`

- [ ] **Step 1: Write the failing test** in `tests/format.test.ts`

```ts
import { test, expect } from "bun:test"
import { chunk, formatOutbound } from "../hub/format"
import type { AgentConfig } from "../hub/types"

const research: AgentConfig = {
  emoji: "🔬", description: "", mode: "persistent",
  access: { roles: ["*"] }, runtime: { cwd: "." },
}

test("short text is one chunk", () => {
  expect(chunk("hello", 2000, "length")).toEqual(["hello"])
})

test("long text splits under the limit", () => {
  const parts = chunk("a".repeat(2500), 2000, "length")
  expect(parts.length).toBe(2)
  expect(parts[0].length).toBeLessThanOrEqual(2000)
})

test("newline mode prefers paragraph boundaries", () => {
  const text = "para one".padEnd(1990, ".") + "\n\n" + "para two"
  const parts = chunk(text, 2000, "newline")
  expect(parts[0].endsWith(".")).toBe(true)
  expect(parts[1]).toBe("para two")
})

test("formatOutbound tags only the first chunk", () => {
  const out = formatOutbound("a".repeat(2500), research, "prefix", 2000, "length")
  expect(out[0].startsWith("**🔬 research** · ")).toBe(true)
  expect(out[1].startsWith("**🔬")).toBe(false)
})
```

> Note: the test references the agent's *name* `research`; `formatOutbound` receives it as an argument (see signature below).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/format.ts`** (chunk ported from upstream `server.ts`)

```ts
import type { AgentConfig } from "./types"

export function chunk(text: string, limit: number, mode: "length" | "newline"): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === "newline") {
      const para = rest.lastIndexOf("\n\n", limit)
      const line = rest.lastIndexOf("\n", limit)
      const space = rest.lastIndexOf(" ", limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest) out.push(rest)
  return out
}

/** Split text to Discord's limit and tag the first chunk with the agent's identity. */
export function formatOutbound(
  text: string,
  agent: AgentConfig & { name?: string },
  style: "prefix" | "embed",
  limit: number,
  mode: "length" | "newline",
  name = agent.name ?? "",
): string[] {
  const tag = style === "prefix" ? `**${agent.emoji} ${name}** · ` : ""
  // Reserve room for the tag so the first chunk still fits under the limit.
  const first = chunk(text, limit - tag.length, mode)
  if (first.length === 0) return [tag]
  return first.map((c, i) => (i === 0 ? tag + c : c))
}
```

> `embed` style is wired in the gateway (Task 18); `formatOutbound` returns the untagged chunks for embeds (the gateway builds the embed object). For v1 the default is `prefix`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/format.test.ts`
Expected: `4 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/format.ts tests/format.test.ts
git commit -m "feat: outbound chunking + per-agent tagging"
```

---

### Task 5: Wire protocol framing — newline JSON

**Files:**
- Create: `tests/framing.test.ts`
- Create: `hub/framing.ts`

- [ ] **Step 1: Write the failing test** in `tests/framing.test.ts`

```ts
import { test, expect } from "bun:test"
import { encode, LineDecoder } from "../hub/framing"

test("encode appends a newline", () => {
  expect(encode({ t: "ping" })).toBe('{"t":"ping"}\n')
})

test("decoder emits complete objects and buffers partials", () => {
  const dec = new LineDecoder()
  expect(dec.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }])
  expect(dec.push('2}\n')).toEqual([{ b: 2 }])
})

test("decoder handles multiple objects in one chunk", () => {
  const dec = new LineDecoder()
  expect(dec.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/framing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/framing.ts`**

```ts
export function encode(obj: unknown): string {
  return JSON.stringify(obj) + "\n"
}

/** Accumulates byte chunks and yields parsed objects on each complete line. */
export class LineDecoder {
  private buf = ""
  push(data: string): unknown[] {
    this.buf += data
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.trim()) out.push(JSON.parse(line))
    }
    return out
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/framing.test.ts`
Expected: `3 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/framing.ts tests/framing.test.ts
git commit -m "feat: newline-delimited JSON wire framing"
```

---

## Phase 2 — Routing & bindings

### Task 6: Router output parsing & fallback

**Files:**
- Create: `tests/router.test.ts`
- Create: `hub/router.ts`

- [ ] **Step 1: Write the failing test** in `tests/router.test.ts`

```ts
import { test, expect } from "bun:test"
import { parseRouterOutput, buildRouterPrompt, route } from "../hub/router"

const permitted = ["research", "deploy", "qa"]

test("parses a clean JSON decision", () => {
  const d = parseRouterOutput('{"agent":"deploy","confidence":0.9,"switch":true}', permitted)
  expect(d).toEqual({ agent: "deploy", confidence: 0.9, switch: true })
})

test("extracts JSON embedded in prose", () => {
  const d = parseRouterOutput('Sure! {"agent":"qa","confidence":0.4,"switch":false} done', permitted)
  expect(d?.agent).toBe("qa")
})

test("rejects an agent outside the permitted set", () => {
  expect(parseRouterOutput('{"agent":"root","confidence":1,"switch":true}', permitted)).toBeNull()
})

test("returns null on garbage", () => {
  expect(parseRouterOutput("no json here", permitted)).toBeNull()
})

test("clamps confidence to [0,1]", () => {
  expect(parseRouterOutput('{"agent":"qa","confidence":5,"switch":false}', permitted)?.confidence).toBe(1)
})

test("prompt lists each permitted agent's description", () => {
  const { user } = buildRouterPrompt({
    message: "deploy to prod",
    permitted: [{ name: "deploy", description: "prod deploys" }],
    current: null,
  })
  expect(user).toContain("deploy")
  expect(user).toContain("prod deploys")
})

test("route() returns the parsed decision from the runner", async () => {
  const run = async () => '{"agent":"research","confidence":0.8,"switch":true}'
  const d = await route(
    { message: "research X", permitted: [{ name: "research", description: "r" }], current: null },
    run, "claude-haiku-4-5",
  )
  expect(d?.agent).toBe("research")
})

test("route() returns null when the runner throws", async () => {
  const run = async () => { throw new Error("spawn failed") }
  const d = await route(
    { message: "x", permitted: [{ name: "research", description: "r" }], current: null },
    run, "claude-haiku-4-5",
  )
  expect(d).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/router.ts`**

```ts
export interface RouteInput {
  message: string
  permitted: { name: string; description: string }[]
  current: string | null
}
export interface RouteDecision { agent: string; confidence: number; switch: boolean }

export function buildRouterPrompt(input: RouteInput): { system: string; user: string } {
  const system =
    "You are a router. Choose exactly one agent to handle the user's message from the " +
    "provided list. Respond with ONLY a JSON object: " +
    '{"agent": "<name>", "confidence": <0..1>, "switch": <bool>}. ' +
    "confidence is how sure you are. switch is true only if the topic clearly changed " +
    "from the current agent. Prefer staying with the current agent when the message is a " +
    "follow-up. Never invent an agent name outside the list."
  const list = input.permitted.map(a => `- ${a.name}: ${a.description}`).join("\n")
  const user =
    `Current agent: ${input.current ?? "(none)"}\n\n` +
    `Available agents:\n${list}\n\n` +
    `User message:\n${input.message}`
  return { system, user }
}

export function parseRouterOutput(raw: string, permitted: string[]): RouteDecision | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let obj: any
  try { obj = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (typeof obj?.agent !== "string" || !permitted.includes(obj.agent)) return null
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0))
  return { agent: obj.agent, confidence, switch: Boolean(obj.switch) }
}

/** Runner contract: given claude args + stdin, resolve stdout. Injected for testability. */
export type ClaudeRunner = (args: string[], stdin: string) => Promise<string>

export async function route(
  input: RouteInput,
  run: ClaudeRunner,
  model: string,
): Promise<RouteDecision | null> {
  const { system, user } = buildRouterPrompt(input)
  try {
    const out = await run(
      ["-p", "--model", model, "--append-system-prompt", system, "--output-format", "text"],
      user,
    )
    return parseRouterOutput(out, input.permitted.map(a => a.name))
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/router.test.ts`
Expected: `8 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/router.ts tests/router.test.ts
git commit -m "feat: Haiku router prompt, parsing, and fallback"
```

---

### Task 7: Binding decision policy + chatKey

**Files:**
- Create: `tests/bindings-decide.test.ts`
- Create: `hub/bindings.ts`

- [ ] **Step 1: Write the failing test** in `tests/bindings-decide.test.ts`

```ts
import { test, expect } from "bun:test"
import { chatKey, decideAgent } from "../hub/bindings"

test("chatKey is per-user in DMs", () => {
  expect(chatKey("user", true, "chan", "u1")).toBe("dm:u1")
})

test("chatKey is per-channel+user in guilds (user scope)", () => {
  expect(chatKey("user", false, "chan", "u1")).toBe("guild:chan:u1")
})

test("chatKey is per-channel in guilds (channel scope)", () => {
  expect(chatKey("channel", false, "chan", "u1")).toBe("guild:chan")
})

test("no current binding → take the router's pick", () => {
  const a = decideAgent({ current: null, permitted: ["research", "qa"],
    decision: { agent: "research", confidence: 0.4, switch: false },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("sticky: stays with current on low-confidence different pick", () => {
  const a = decideAgent({ current: "research", permitted: ["research", "deploy"],
    decision: { agent: "deploy", confidence: 0.5, switch: true },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("auto-switch: switches on high-confidence different pick", () => {
  const a = decideAgent({ current: "research", permitted: ["research", "deploy"],
    decision: { agent: "deploy", confidence: 0.9, switch: true },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("deploy")
})

test("current agent no longer permitted → route fresh", () => {
  const a = decideAgent({ current: "deploy", permitted: ["research", "qa"],
    decision: { agent: "research", confidence: 0.3, switch: false },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("router failed (null) → keep current if still permitted", () => {
  const a = decideAgent({ current: "research", permitted: ["research", "qa"],
    decision: null, threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("router failed and no current → defaultAgent", () => {
  const a = decideAgent({ current: null, permitted: ["research", "qa"],
    decision: null, threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("qa")
})

test("router failed, no current, default not permitted → first permitted", () => {
  const a = decideAgent({ current: null, permitted: ["research"],
    decision: null, threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/bindings-decide.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure parts of `hub/bindings.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"
import type { RouteDecision } from "./router"

export function chatKey(
  scope: "user" | "channel",
  isDM: boolean,
  channelId: string,
  userId: string,
): string {
  if (isDM) return `dm:${userId}`
  return scope === "channel" ? `guild:${channelId}` : `guild:${channelId}:${userId}`
}

export function decideAgent(args: {
  current: string | null
  permitted: string[]
  decision: RouteDecision | null
  threshold: number
  defaultAgent: string
}): string {
  const { current, permitted, decision, threshold, defaultAgent } = args
  const currentValid = current != null && permitted.includes(current)

  if (decision) {
    if (!currentValid) return decision.agent                  // route fresh
    if (decision.agent === current) return current            // stay
    if (decision.confidence >= threshold) return decision.agent // confident switch
    return current                                            // sticky
  }
  // Router failed.
  if (currentValid) return current
  if (permitted.includes(defaultAgent)) return defaultAgent
  return permitted[0]
}

export interface Binding { agent: string; sessionId?: string; lastActive: number }

/** Persisted chatKey → Binding store. */
export class BindingStore {
  private map: Record<string, Binding> = {}
  constructor(private path: string) {
    try { this.map = JSON.parse(readFileSync(path, "utf8")) } catch { this.map = {} }
  }
  get(key: string): Binding | undefined { return this.map[key] }
  set(key: string, b: Binding): void { this.map[key] = b; this.save() }
  clear(key: string): void { delete this.map[key]; this.save() }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/bindings-decide.test.ts`
Expected: `10 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/bindings.ts tests/bindings-decide.test.ts
git commit -m "feat: sticky/auto-switch decision policy + chatKey + binding store"
```

---

### Task 8: BindingStore persistence round-trip

**Files:**
- Create: `tests/bindings-store.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/bindings-store.test.ts`

```ts
import { test, expect } from "bun:test"
import { BindingStore } from "../hub/bindings"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("set persists and reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"))
  const path = join(dir, "bindings.json")
  const a = new BindingStore(path)
  a.set("dm:u1", { agent: "research", lastActive: 1 })
  const b = new BindingStore(path)
  expect(b.get("dm:u1")?.agent).toBe("research")
})

test("clear removes a binding across reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"))
  const path = join(dir, "bindings.json")
  const a = new BindingStore(path)
  a.set("dm:u1", { agent: "qa", lastActive: 1 })
  a.clear("dm:u1")
  expect(new BindingStore(path).get("dm:u1")).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `bun test tests/bindings-store.test.ts`
Expected: PASS (BindingStore already implemented in Task 7). If it fails, fix `BindingStore` before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/bindings-store.test.ts
git commit -m "test: BindingStore persistence round-trip"
```

---

## Phase 3 — Transports

### Task 9: Transport interface + Dispatcher

**Files:**
- Create: `tests/dispatcher.test.ts`
- Create: `hub/transports/index.ts`

- [ ] **Step 1: Write the failing test** in `tests/dispatcher.test.ts`

```ts
import { test, expect } from "bun:test"
import { Dispatcher, type AgentTransport } from "../hub/transports"
import type { InboundMessage, AgentReply } from "../hub/types"

function fakeTransport(name: string, available = true): AgentTransport & { delivered: any[] } {
  const delivered: any[] = []
  let cb: (r: AgentReply) => void = () => {}
  return {
    name, delivered,
    deliver: (chatKey, inbound) => { delivered.push({ chatKey, inbound }) },
    onReply: c => { cb = c },
    isAvailable: () => available,
    _emit: (r: AgentReply) => cb(r),
  } as any
}

const inbound: InboundMessage = {
  chatId: "c", messageId: "m", userId: "u", user: "bob",
  content: "hi", ts: "t", isDM: true,
}

test("dispatch routes to the named transport", () => {
  const research = fakeTransport("research")
  const d = new Dispatcher([research])
  d.dispatch("research", "dm:u", inbound)
  expect(research.delivered.length).toBe(1)
})

test("dispatch to an unavailable agent reports offline", () => {
  const research = fakeTransport("research", false)
  const d = new Dispatcher([research])
  expect(d.isAvailable("research")).toBe(false)
})

test("replies propagate through the dispatcher callback", () => {
  const research = fakeTransport("research") as any
  const d = new Dispatcher([research])
  const got: AgentReply[] = []
  d.onReply(r => got.push(r))
  research._emit({ agent: "research", kind: "reply", chatId: "c", text: "yo" })
  expect(got[0].text).toBe("yo")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/dispatcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/transports/index.ts`**

```ts
import type { InboundMessage, AgentReply } from "../types"

export interface AgentTransport {
  readonly name: string
  deliver(chatKey: string, inbound: InboundMessage): void
  onReply(cb: (reply: AgentReply) => void): void
  isAvailable(): boolean
}

/** Routes inbound messages to the right transport and fans replies back out. */
export class Dispatcher {
  private byName = new Map<string, AgentTransport>()
  private replyCb: (r: AgentReply) => void = () => {}

  constructor(transports: AgentTransport[]) {
    for (const t of transports) {
      this.byName.set(t.name, t)
      t.onReply(r => this.replyCb(r))
    }
  }
  dispatch(agent: string, chatKey: string, inbound: InboundMessage): boolean {
    const t = this.byName.get(agent)
    if (!t || !t.isAvailable()) return false
    t.deliver(chatKey, inbound)
    return true
  }
  isAvailable(agent: string): boolean {
    return this.byName.get(agent)?.isAvailable() ?? false
  }
  onReply(cb: (r: AgentReply) => void): void { this.replyCb = cb }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/dispatcher.test.ts`
Expected: `3 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/transports/index.ts tests/dispatcher.test.ts
git commit -m "feat: AgentTransport interface + Dispatcher"
```

---

### Task 10: Headless transport (ephemeral)

**Files:**
- Create: `tests/headless.test.ts`
- Create: `hub/transports/headless.ts`

- [ ] **Step 1: Write the failing test** in `tests/headless.test.ts`

```ts
import { test, expect } from "bun:test"
import { HeadlessTransport } from "../hub/transports/headless"
import type { AgentConfig, InboundMessage, AgentReply } from "../hub/types"

const cfg: AgentConfig = {
  emoji: "💡", description: "", mode: "ephemeral",
  access: { roles: ["*"] }, runtime: { cwd: ".", model: "claude-haiku-4-5", allowedTools: ["Read"] },
}
const inbound: InboundMessage = {
  chatId: "c", messageId: "m", userId: "u", user: "bob", content: "what is 2+2?", ts: "t", isDM: true,
}

test("delivers a reply from the headless runner", async () => {
  const runs: { args: string[]; stdin: string }[] = []
  const run = async (args: string[], stdin: string) => {
    runs.push({ args, stdin })
    return { stdout: JSON.stringify({ result: "4", session_id: "sess-1" }) }
  }
  const t = new HeadlessTransport("qa", cfg, run, 5000)
  const got: AgentReply[] = []
  t.onReply(r => got.push(r))
  t.deliver("dm:u", inbound)
  await Bun.sleep(10)
  expect(got[0].text).toBe("4")
  expect(got[0].agent).toBe("qa")
  expect(runs[0].args).toContain("--allowedTools")
})

test("resumes with the stored session id on the second turn", async () => {
  const seen: string[] = []
  const run = async (args: string[]) => {
    const i = args.indexOf("--resume")
    seen.push(i >= 0 ? args[i + 1] : "(none)")
    return { stdout: JSON.stringify({ result: "ok", session_id: "sess-1" }) }
  }
  const t = new HeadlessTransport("qa", cfg, run, 5000)
  t.onReply(() => {})
  t.deliver("dm:u", inbound); await Bun.sleep(10)
  t.deliver("dm:u", inbound); await Bun.sleep(10)
  expect(seen[0]).toBe("(none)")
  expect(seen[1]).toBe("sess-1")
})

test("a runner timeout/throw produces an apology reply", async () => {
  const run = async () => { throw new Error("timeout") }
  const t = new HeadlessTransport("qa", cfg, run, 5000)
  const got: AgentReply[] = []
  t.onReply(r => got.push(r))
  t.deliver("dm:u", inbound)
  await Bun.sleep(10)
  expect(got[0].text?.toLowerCase()).toContain("couldn't")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/headless.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/transports/headless.ts`**

```ts
import type { AgentConfig, InboundMessage, AgentReply } from "../types"
import type { AgentTransport } from "./index"

export interface HeadlessResult { stdout: string }
export type HeadlessRunner = (
  args: string[], stdin: string, cwd: string, timeoutMs: number,
) => Promise<HeadlessResult>

/** Ephemeral agent: one `claude -p --resume` spawn per turn, isolated per chatKey. */
export class HeadlessTransport implements AgentTransport {
  private sessions = new Map<string, string>()   // chatKey → session_id
  private cb: (r: AgentReply) => void = () => {}

  constructor(
    public readonly name: string,
    private cfg: AgentConfig,
    private run: HeadlessRunner,
    private timeoutMs: number,
  ) {}

  onReply(cb: (r: AgentReply) => void): void { this.cb = cb }
  isAvailable(): boolean { return true }   // spawned on demand; always available

  deliver(chatKey: string, inbound: InboundMessage): void {
    void this.handle(chatKey, inbound)
  }

  private async handle(chatKey: string, inbound: InboundMessage): Promise<void> {
    const args = ["-p", "--output-format", "json"]
    if (this.cfg.runtime.model) args.push("--model", this.cfg.runtime.model)
    if (this.cfg.runtime.allowedTools?.length) {
      args.push("--allowedTools", this.cfg.runtime.allowedTools.join(","))
    }
    if (this.cfg.runtime.appendSystemPrompt) {
      args.push("--append-system-prompt", this.cfg.runtime.appendSystemPrompt)
    }
    const prior = this.sessions.get(chatKey)
    if (prior) args.push("--resume", prior)

    try {
      const { stdout } = await this.run(args, inbound.content, this.cfg.runtime.cwd, this.timeoutMs)
      const parsed = JSON.parse(stdout) as { result?: string; session_id?: string }
      if (parsed.session_id) this.sessions.set(chatKey, parsed.session_id)
      this.cb({ agent: this.name, kind: "reply", chatId: inbound.chatId,
        text: parsed.result ?? "(no output)", replyTo: inbound.messageId })
    } catch (err) {
      this.cb({ agent: this.name, kind: "reply", chatId: inbound.chatId,
        text: `Sorry — I couldn't complete that just now. (${(err as Error).message})`,
        replyTo: inbound.messageId })
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/headless.test.ts`
Expected: `3 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/transports/headless.ts tests/headless.test.ts
git commit -m "feat: headless ephemeral transport (claude -p --resume)"
```

---

### Task 11: Real headless runner (process spawn)

**Files:**
- Create: `hub/transports/spawnClaude.ts`
- Create: `tests/spawnClaude.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/spawnClaude.test.ts` (uses a stub binary, not real `claude`)

```ts
import { test, expect } from "bun:test"
import { makeHeadlessRunner } from "../hub/transports/spawnClaude"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("runner invokes the binary and returns stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bin-"))
  const stub = join(dir, "fakeclaude")
  writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\necho \'{"result":"hi","session_id":"s1"}\'\n')
  chmodSync(stub, 0o755)
  const run = makeHeadlessRunner(stub)
  const { stdout } = await run(["-p"], "hello", dir, 5000)
  expect(JSON.parse(stdout).result).toBe("hi")
})

test("runner rejects when the binary exceeds the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bin-"))
  const stub = join(dir, "slowclaude")
  writeFileSync(stub, '#!/bin/sh\nsleep 5\n')
  chmodSync(stub, 0o755)
  const run = makeHeadlessRunner(stub)
  await expect(run(["-p"], "x", dir, 200)).rejects.toThrow()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/spawnClaude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/transports/spawnClaude.ts`**

```ts
import type { HeadlessRunner } from "./headless"
import type { ClaudeRunner } from "../router"

/** Real headless runner: spawns the claude CLI, feeds stdin, enforces a timeout. */
export function makeHeadlessRunner(bin = "claude"): HeadlessRunner {
  return async (args, stdin, cwd, timeoutMs) => {
    const proc = Bun.spawn([bin, ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(stdin); proc.stdin.end()
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      const stdout = await new Response(proc.stdout).text()
      const code = await proc.exited
      if (code !== 0) throw new Error(`claude exited ${code}`)
      return { stdout }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Router runner: same spawn, text output, used by hub/router.ts route(). */
export function makeRouterRunner(bin = "claude"): ClaudeRunner {
  return async (args, stdin) => {
    const proc = Bun.spawn([bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(stdin); proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`claude exited ${code}`)
    return stdout
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/spawnClaude.test.ts`
Expected: `2 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/transports/spawnClaude.ts tests/spawnClaude.test.ts
git commit -m "feat: real claude-CLI spawn runners (headless + router) with timeout"
```

---

### Task 12: Channel-shim transport (persistent) — socket server

**Files:**
- Create: `tests/channelShim.test.ts`
- Create: `hub/transports/channelShim.ts`

- [ ] **Step 1: Write the failing test** in `tests/channelShim.test.ts` (drives the server over a real Unix socket using Bun)

```ts
import { test, expect } from "bun:test"
import { ChannelShimTransport } from "../hub/transports/channelShim"
import { encode, LineDecoder } from "../hub/framing"
import type { InboundMessage, AgentReply } from "../hub/types"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const inbound: InboundMessage = {
  chatId: "c", messageId: "m", userId: "u", user: "bob", content: "hi", ts: "t", isDM: true,
}

test("a registered shim becomes available; inbound reaches it; replies come back", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "sb-sock-")), "hub.sock")
  const t = new ChannelShimTransport("research", sock)
  await t.listen()

  expect(t.isAvailable()).toBe(false)            // nothing connected yet

  // Connect a fake shim client.
  const received: any[] = []
  const dec = new LineDecoder()
  const client = await Bun.connect({
    unix: sock,
    socket: { data(_s, d) { for (const o of dec.push(d.toString())) received.push(o) } },
  })
  client.write(encode({ t: "register", agent: "research" }))
  await Bun.sleep(20)
  expect(t.isAvailable()).toBe(true)

  const replies: AgentReply[] = []
  t.onReply(r => replies.push(r))

  t.deliver("dm:u", inbound)
  await Bun.sleep(20)
  expect(received.find(o => o.t === "inbound")?.inbound.content).toBe("hi")

  client.write(encode({ t: "reply", chatId: "c", text: "hello back", replyTo: "m" }))
  await Bun.sleep(20)
  expect(replies[0]).toMatchObject({ agent: "research", kind: "reply", text: "hello back" })

  client.end()
  await t.close()
})

test("availability drops when the shim disconnects", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "sb-sock-")), "hub.sock")
  const t = new ChannelShimTransport("research", sock)
  await t.listen()
  const client = await Bun.connect({ unix: sock, socket: { data() {} } })
  client.write(encode({ t: "register", agent: "research" }))
  await Bun.sleep(20)
  expect(t.isAvailable()).toBe(true)
  client.end()
  await Bun.sleep(20)
  expect(t.isAvailable()).toBe(false)
  await t.close()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/channelShim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/transports/channelShim.ts`**

```ts
import { unlinkSync } from "fs"
import type { Socket } from "bun"
import type { InboundMessage, AgentReply } from "../types"
import type { AgentTransport } from "./index"
import { encode, LineDecoder } from "../framing"

type Conn = { socket: Socket<unknown>; decoder: LineDecoder; registered: boolean }

/** Persistent agent: a Unix-socket server; one connected shim handles this agent. */
export class ChannelShimTransport implements AgentTransport {
  private server?: ReturnType<typeof Bun.listen>
  private conn: Conn | null = null
  private cb: (r: AgentReply) => void = () => {}
  private permCb: (requestId: string, behavior: "allow" | "deny") => void = () => {}

  constructor(public readonly name: string, private socketPath: string) {}

  async listen(): Promise<void> {
    try { unlinkSync(this.socketPath) } catch {}
    const self = this
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open(socket) { (socket as any).__conn = { socket, decoder: new LineDecoder(), registered: false } },
        data(socket, data) {
          const conn: Conn = (socket as any).__conn
          for (const obj of conn.decoder.push(data.toString())) self.onMessage(conn, obj as any)
        },
        close(socket) {
          if (self.conn && self.conn.socket === socket) self.conn = null
        },
      },
    })
  }

  private onMessage(conn: Conn, msg: any): void {
    switch (msg.t) {
      case "register":
        conn.registered = true
        this.conn = conn
        break
      case "reply":
        this.cb({ agent: this.name, kind: "reply", chatId: msg.chatId,
          text: msg.text, replyTo: msg.replyTo, files: msg.files })
        break
      case "react":
        this.cb({ agent: this.name, kind: "react", chatId: msg.chatId,
          messageId: msg.messageId, emoji: msg.emoji })
        break
      case "edit":
        this.cb({ agent: this.name, kind: "edit", chatId: msg.chatId,
          messageId: msg.messageId, text: msg.text })
        break
      // permission_request handled in Phase 5 (Task 16).
    }
  }

  onReply(cb: (r: AgentReply) => void): void { this.cb = cb }
  isAvailable(): boolean { return this.conn?.registered === true }

  deliver(chatKey: string, inbound: InboundMessage): void {
    if (!this.conn) return
    this.conn.socket.write(encode({ t: "inbound", chatKey, inbound }))
  }

  /** Used in Task 16 to relay a permission answer back to this agent's shim. */
  sendPermissionResult(requestId: string, behavior: "allow" | "deny"): void {
    this.conn?.socket.write(encode({ t: "permission_result", requestId, behavior }))
  }

  async close(): Promise<void> {
    this.server?.stop(true)
    try { unlinkSync(this.socketPath) } catch {}
  }
}
```

> Note: v1 uses **one socket path per persistent agent** (simplest, isolates agents). The hub creates one `ChannelShimTransport` per persistent agent, each on `‹stateDir›/‹agent›.sock`. A single multiplexed socket is a possible later optimization.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/channelShim.test.ts`
Expected: `2 pass`.

- [ ] **Step 5: Commit**

```bash
git add hub/transports/channelShim.ts tests/channelShim.test.ts
git commit -m "feat: persistent channel-shim transport over Unix socket"
```

---

### Task 13: The persistent-agent shim (`shim/server.ts`)

**Files:**
- Create: `shim/server.ts`
- Create: `tests/shim.test.ts`

The shim is an MCP **channel** server (so `claude --channels` drives it) that, instead of talking to Discord, talks to the hub socket. It is adapted from upstream `server.ts`: the discord.js client, gateway, and access control are removed; `reply`/`react`/`edit_message` become socket writes; inbound `notifications/claude/channel` come from the socket.

- [ ] **Step 1: Write the failing test** in `tests/shim.test.ts` (tests the pure translation helpers the shim exposes)

```ts
import { test, expect } from "bun:test"
import { inboundToChannelNotification, toolCallToWire } from "../shim/server"

test("socket inbound → channel notification params", () => {
  const params = inboundToChannelNotification({
    chatKey: "dm:u",
    inbound: { chatId: "c", messageId: "m", userId: "u", user: "bob",
      content: "hello", ts: "t", isDM: true },
  })
  expect(params.content).toBe("hello")
  expect(params.meta.chat_id).toBe("c")
  expect(params.meta.message_id).toBe("m")
  expect(params.meta.user).toBe("bob")
})

test("reply tool call → wire reply message", () => {
  const wire = toolCallToWire("reply", { chat_id: "c", text: "hi", reply_to: "m" })
  expect(wire).toEqual({ t: "reply", chatId: "c", text: "hi", replyTo: "m", files: undefined })
})

test("react tool call → wire react message", () => {
  const wire = toolCallToWire("react", { chat_id: "c", message_id: "m", emoji: "👍" })
  expect(wire).toEqual({ t: "react", chatId: "c", messageId: "m", emoji: "👍" })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/shim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `shim/server.ts`**

Structure: export the two pure helpers (testable) plus a `main()` that wires the MCP server to the socket. Guard `main()` behind `import.meta.main` so importing the module in tests does not start the server.

```ts
#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { encode, LineDecoder } from "../hub/framing"

interface WireInbound {
  chatKey: string
  inbound: { chatId: string; messageId: string; userId: string; user: string
    content: string; ts: string; isDM: boolean
    attachments?: { name: string; type: string; size: number }[] }
}

/** Translate a hub socket inbound into the channel-notification params CC expects. */
export function inboundToChannelNotification(w: WireInbound) {
  const i = w.inbound
  return {
    content: i.content,
    meta: {
      chat_id: i.chatId, message_id: i.messageId,
      user: i.user, user_id: i.userId, ts: i.ts,
    },
  }
}

/** Translate an MCP tool call from CC into the wire message for the hub. */
export function toolCallToWire(name: string, args: Record<string, any>) {
  switch (name) {
    case "reply":
      return { t: "reply", chatId: args.chat_id, text: args.text,
        replyTo: args.reply_to, files: args.files }
    case "react":
      return { t: "react", chatId: args.chat_id, messageId: args.message_id, emoji: args.emoji }
    case "edit_message":
      return { t: "edit", chatId: args.chat_id, messageId: args.message_id, text: args.text }
    default:
      return null
  }
}

async function main() {
  const SOCKET = process.env.HUB_SOCKET
  const AGENT = process.env.AGENT_NAME
  if (!SOCKET || !AGENT) {
    process.stderr.write("shim: HUB_SOCKET and AGENT_NAME required\n"); process.exit(1)
  }

  const mcp = new Server(
    { name: "switchboard-shim", version: "1.0.0" },
    { capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions:
        "Messages from Discord arrive as <channel ...>. Reply with the reply tool, " +
        "passing chat_id back. Use react and edit_message as needed. Your transcript " +
        "output never reaches the user — only the reply tool does." },
  )

  const dec = new LineDecoder()
  const sock = await Bun.connect({
    unix: SOCKET,
    socket: {
      data(_s, data) {
        for (const obj of dec.push(data.toString())) {
          const m = obj as any
          if (m.t === "inbound") {
            void mcp.notification({
              method: "notifications/claude/channel",
              params: inboundToChannelNotification(m),
            })
          }
        }
      },
    },
  })
  sock.write(encode({ t: "register", agent: AGENT }))

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "reply", description: "Reply on Discord. Pass chat_id from the inbound message.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" }, text: { type: "string" },
          reply_to: { type: "string" }, files: { type: "array", items: { type: "string" } } },
          required: ["chat_id", "text"] } },
      { name: "react", description: "Add an emoji reaction to a message.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string" } },
          required: ["chat_id", "message_id", "emoji"] } },
      { name: "edit_message", description: "Edit a message the bot previously sent.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" }, message_id: { type: "string" }, text: { type: "string" } },
          required: ["chat_id", "message_id", "text"] } },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const wire = toolCallToWire(req.params.name, (req.params.arguments ?? {}) as any)
    if (!wire) return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true }
    sock.write(encode(wire))
    return { content: [{ type: "text", text: "sent" }] }
  })

  await mcp.connect(new StdioServerTransport())
}

if (import.meta.main) void main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/shim.test.ts`
Expected: `3 pass`.

- [ ] **Step 5: Commit**

```bash
git add shim/server.ts tests/shim.test.ts
git commit -m "feat: persistent-agent channel shim (MCP channel ↔ hub socket)"
```

---

## Phase 4 — Config, gateway, and wiring

### Task 14: Config loading + validation

**Files:**
- Create: `tests/config.test.ts`
- Create: `hub/config.ts`
- Create: `config/hub.config.json`
- Create: `config/agents.example.json`

- [ ] **Step 1: Write the failing test** in `tests/config.test.ts`

```ts
import { test, expect } from "bun:test"
import { loadConfigs, expandHome } from "../hub/config"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("expandHome resolves a leading ~", () => {
  expect(expandHome("~/x").startsWith("/")).toBe(true)
})

test("loads and validates both files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"))
  writeFileSync(join(dir, "hub.config.json"), JSON.stringify({
    botTokenEnv: "DISCORD_BOT_TOKEN", guildIds: ["g1"], socketPath: "~/.sb/hub.sock",
    stateDir: "~/.sb", routerModel: "claude-haiku-4-5", switchThreshold: 0.7,
    defaultAgent: "qa", ephemeralTimeoutMs: 1000, tagStyle: "prefix", chatKeyScope: "user",
  }))
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    qa: { emoji: "💡", description: "q", mode: "ephemeral",
      access: { roles: ["*"] }, runtime: { cwd: "." } },
  }))
  const { hub, agents } = loadConfigs(dir)
  expect(hub.defaultAgent).toBe("qa")
  expect(agents.qa.mode).toBe("ephemeral")
})

test("rejects a defaultAgent missing from the registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"))
  writeFileSync(join(dir, "hub.config.json"), JSON.stringify({
    botTokenEnv: "T", guildIds: [], socketPath: "s", stateDir: "d",
    routerModel: "m", switchThreshold: 0.7, defaultAgent: "ghost",
    ephemeralTimeoutMs: 1, tagStyle: "prefix", chatKeyScope: "user",
  }))
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    qa: { emoji: "💡", description: "q", mode: "ephemeral", access: { roles: ["*"] }, runtime: { cwd: "." } },
  }))
  expect(() => loadConfigs(dir)).toThrow(/defaultAgent/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/config.ts`**

```ts
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { HubConfig, AgentRegistry } from "./types"

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
}

export function loadConfigs(dir: string): { hub: HubConfig; agents: AgentRegistry } {
  const hub = JSON.parse(readFileSync(join(dir, "hub.config.json"), "utf8")) as HubConfig
  const agents = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")) as AgentRegistry

  hub.socketPath = expandHome(hub.socketPath)
  hub.stateDir = expandHome(hub.stateDir)
  for (const a of Object.values(agents)) a.runtime.cwd = expandHome(a.runtime.cwd)

  if (!agents[hub.defaultAgent]) {
    throw new Error(`config: defaultAgent "${hub.defaultAgent}" is not in the agent registry`)
  }
  for (const [name, cfg] of Object.entries(agents)) {
    if (cfg.mode !== "persistent" && cfg.mode !== "ephemeral") {
      throw new Error(`config: agent "${name}" has invalid mode "${cfg.mode}"`)
    }
  }
  return { hub, agents }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: `3 pass`.

- [ ] **Step 5: Write the example config files**

`config/hub.config.json`:
```json
{
  "botTokenEnv": "DISCORD_BOT_TOKEN",
  "guildIds": [],
  "socketPath": "~/.switchboard/hub.sock",
  "stateDir": "~/.switchboard",
  "routerModel": "claude-haiku-4-5",
  "switchThreshold": 0.7,
  "defaultAgent": "qa",
  "ephemeralTimeoutMs": 120000,
  "tagStyle": "prefix",
  "chatKeyScope": "user"
}
```

`config/agents.example.json`:
```json
{
  "qa": {
    "emoji": "💡", "description": "quick code & general questions",
    "mode": "ephemeral",
    "access": { "roles": ["*"] },
    "runtime": { "cwd": "~", "model": "claude-haiku-4-5", "allowedTools": ["Read", "Grep", "Glob"] }
  },
  "research": {
    "emoji": "🔬", "description": "web research, deep multi-source dives",
    "mode": "persistent",
    "access": { "roles": ["dev", "admin"], "users": [] },
    "runtime": { "cwd": "~", "model": "claude-sonnet-4-6" }
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add hub/config.ts tests/config.test.ts config/hub.config.json config/agents.example.json
git commit -m "feat: config loading + validation, example configs"
```

---

### Task 15: Gateway — inbound parse, role resolution, outbound send

**Files:**
- Create: `tests/gateway-helpers.test.ts`
- Create: `hub/gateway.ts`

The discord.js client itself is exercised manually (Task 19). Here we unit-test the **pure helpers** the gateway uses, and keep the client wiring thin.

- [ ] **Step 1: Write the failing test** in `tests/gateway-helpers.test.ts`

```ts
import { test, expect } from "bun:test"
import { parseControlCommand, renderAgentList } from "../hub/gateway"
import type { AgentRegistry } from "../hub/types"

const reg: AgentRegistry = {
  research: { emoji: "🔬", description: "deep dives", mode: "persistent",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
  qa: { emoji: "💡", description: "quick Q", mode: "ephemeral",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
}

test("parses !switch with an argument", () => {
  expect(parseControlCommand("!switch research")).toEqual({ cmd: "switch", arg: "research" })
})

test("parses bare commands", () => {
  expect(parseControlCommand("!agents")).toEqual({ cmd: "agents", arg: undefined })
  expect(parseControlCommand("!who")).toEqual({ cmd: "who", arg: undefined })
  expect(parseControlCommand("!reset")).toEqual({ cmd: "reset", arg: undefined })
})

test("non-commands return null", () => {
  expect(parseControlCommand("hello there")).toBeNull()
})

test("renderAgentList shows permitted agents and marks the bound one", () => {
  const out = renderAgentList(reg, ["research", "qa"], "qa")
  expect(out).toContain("🔬 research")
  expect(out).toContain("deep dives")
  expect(out).toContain("← current")  // marks the bound agent
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/gateway-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/gateway.ts`** (helpers + client wiring)

```ts
import {
  Client, GatewayIntentBits, Partials, ChannelType, type Message,
} from "discord.js"
import type { AgentRegistry, InboundMessage, AgentReply, AgentConfig, HubConfig } from "./types"
import { formatOutbound } from "./format"

export type Control =
  | { cmd: "agents"; arg: undefined }
  | { cmd: "who"; arg: undefined }
  | { cmd: "reset"; arg: undefined }
  | { cmd: "switch"; arg: string }

export function parseControlCommand(text: string): Control | null {
  const m = text.trim().match(/^!(agents|who|reset|switch)(?:\s+(\S+))?$/i)
  if (!m) return null
  const cmd = m[1].toLowerCase() as Control["cmd"]
  if (cmd === "switch") return { cmd, arg: m[2] ?? "" }
  return { cmd, arg: undefined } as Control
}

export function renderAgentList(reg: AgentRegistry, permitted: string[], current: string | null): string {
  const lines = permitted.map(n => {
    const c = reg[n]
    const mark = n === current ? "  ← current" : ""
    return `${c.emoji} **${n}** — ${c.description}${mark}`
  })
  return lines.length ? lines.join("\n") : "(no agents available to you)"
}

/** Thin discord.js wrapper. Caller supplies handlers; this owns the client + I/O. */
export class Gateway {
  readonly client: Client
  private onMessage: (m: InboundMessage) => void = () => {}

  constructor(private cfg: HubConfig, private registry: AgentRegistry) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,   // role resolution
      ],
      partials: [Partials.Channel],
    })
  }

  handleInbound(cb: (m: InboundMessage) => void): void { this.onMessage = cb }

  /** Resolve a user's roles by looking them up as a member across configured guilds. */
  async resolveRoles(userId: string): Promise<string[]> {
    const roles = new Set<string>()
    for (const gid of this.cfg.guildIds) {
      try {
        const guild = await this.client.guilds.fetch(gid)
        const member = await guild.members.fetch(userId)
        for (const r of member.roles.cache.values()) roles.add(r.name)
      } catch { /* not a member of this guild */ }
    }
    return [...roles]
  }

  async start(token: string): Promise<void> {
    this.client.on("messageCreate", (msg: Message) => {
      if (msg.author.bot) return
      this.onMessage({
        chatId: msg.channelId, messageId: msg.id, userId: msg.author.id,
        user: msg.author.username, content: msg.content,
        ts: msg.createdAt.toISOString(), isDM: msg.channel.type === ChannelType.DM,
        attachments: [...msg.attachments.values()].map(a => ({
          name: a.name ?? a.id, type: a.contentType ?? "unknown", size: a.size })),
      })
    })
    await this.client.login(token)
  }

  /** Send a tagged, chunked reply for a given agent. */
  async sendReply(reply: AgentReply, agent: AgentConfig): Promise<void> {
    const ch = await this.client.channels.fetch(reply.chatId)
    if (!ch || !("send" in ch)) return
    const chunks = formatOutbound(reply.text ?? "", agent, this.cfg.tagStyle, 2000, "newline", reply.agent)
    for (let i = 0; i < chunks.length; i++) {
      await (ch as any).send({
        content: chunks[i],
        ...(i === 0 && reply.files?.length ? { files: reply.files } : {}),
        ...(i === 0 && reply.replyTo
          ? { reply: { messageReference: reply.replyTo, failIfNotExists: false } } : {}),
      })
    }
  }

  async sendPlain(chatId: string, text: string): Promise<void> {
    const ch = await this.client.channels.fetch(chatId)
    if (ch && "send" in ch) await (ch as any).send({ content: text })
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/gateway-helpers.test.ts`
Expected: `4 pass`.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add hub/gateway.ts tests/gateway-helpers.test.ts
git commit -m "feat: discord gateway (inbound parse, role resolution, tagged outbound) + control parsing"
```

---

### Task 16: Permission relay namespacing

**Files:**
- Create: `tests/permissions.test.ts`
- Create: `hub/permissions.ts`

- [ ] **Step 1: Write the failing test** in `tests/permissions.test.ts`

```ts
import { test, expect } from "bun:test"
import { PermissionRouter } from "../hub/permissions"

test("maps a request id to its originating agent and back", () => {
  const pr = new PermissionRouter()
  pr.register("req-1", "research")
  expect(pr.agentFor("req-1")).toBe("research")
})

test("resolving consumes the mapping", () => {
  const pr = new PermissionRouter()
  pr.register("req-1", "deploy")
  expect(pr.resolve("req-1")).toBe("deploy")
  expect(pr.agentFor("req-1")).toBeUndefined()
})

test("unknown request id resolves to undefined", () => {
  expect(new PermissionRouter().resolve("nope")).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/permissions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/permissions.ts`**

```ts
/** Tracks which agent raised each permission request, so the answer routes back correctly. */
export class PermissionRouter {
  private byRequest = new Map<string, string>()
  register(requestId: string, agent: string): void { this.byRequest.set(requestId, agent) }
  agentFor(requestId: string): string | undefined { return this.byRequest.get(requestId) }
  resolve(requestId: string): string | undefined {
    const a = this.byRequest.get(requestId)
    this.byRequest.delete(requestId)
    return a
  }
}
```

- [ ] **Step 4: Extend the shim + transport for permission requests**

In `hub/transports/channelShim.ts`, add a `permission_request` case to `onMessage` that surfaces it via a dedicated callback:

```ts
// add field:
private permReqCb: (req: { requestId: string; toolName: string; description: string; inputPreview: string }) => void = () => {}
onPermissionRequest(cb: typeof this.permReqCb): void { this.permReqCb = cb }
// in onMessage switch:
case "permission_request":
  this.permReqCb({ requestId: msg.requestId, toolName: msg.toolName,
    description: msg.description, inputPreview: msg.inputPreview })
  break
```

In `shim/server.ts`, forward CC's `permission_request` notification onto the socket and relay the hub's `permission_result` back to CC. Add inside `main()` after the socket is created:

```ts
mcp.setNotificationHandler(
  // CC → shim: a tool wants permission
  (await import("zod")).z.object({
    method: (await import("zod")).z.literal("notifications/claude/channel/permission_request"),
    params: (await import("zod")).z.object({
      request_id: (await import("zod")).z.string(),
      tool_name: (await import("zod")).z.string(),
      description: (await import("zod")).z.string(),
      input_preview: (await import("zod")).z.string(),
    }),
  }) as any,
  async ({ params }: any) => {
    sock.write(encode({ t: "permission_request", requestId: params.request_id,
      toolName: params.tool_name, description: params.description, inputPreview: params.input_preview }))
  },
)
// hub → shim: the answer (handled in the socket data loop)
//   if (m.t === "permission_result")
//     void mcp.notification({ method: "notifications/claude/channel/permission",
//       params: { request_id: m.requestId, behavior: m.behavior } })
```

Add the `permission_result` branch to the shim's socket `data` loop alongside the `inbound` branch.

- [ ] **Step 5: Run permission tests + typecheck**

Run: `bun test tests/permissions.test.ts && bun run typecheck`
Expected: `3 pass`, no type errors.

- [ ] **Step 6: Commit**

```bash
git add hub/permissions.ts tests/permissions.test.ts hub/transports/channelShim.ts shim/server.ts
git commit -m "feat: permission relay namespacing (request id ↔ agent) + shim wiring"
```

---

### Task 17: The hub orchestrator (`hub/index.ts`)

**Files:**
- Create: `hub/orchestrator.ts`  (the testable wiring)
- Create: `hub/index.ts`         (the thin entrypoint)
- Create: `tests/orchestrator.test.ts`

Split the wiring (`handleMessage`) from process bootstrap so it can be unit-tested with fakes.

- [ ] **Step 1: Write the failing test** in `tests/orchestrator.test.ts`

```ts
import { test, expect } from "bun:test"
import { Orchestrator } from "../hub/orchestrator"
import type { AgentRegistry, HubConfig, InboundMessage } from "../hub/types"

const hub: HubConfig = {
  botTokenEnv: "T", guildIds: [], socketPath: "s", stateDir: "/tmp/sb-test-orch",
  routerModel: "m", switchThreshold: 0.7, defaultAgent: "qa",
  ephemeralTimeoutMs: 1000, tagStyle: "prefix", chatKeyScope: "user",
}
const reg: AgentRegistry = {
  research: { emoji: "🔬", description: "deep dives", mode: "persistent",
    access: { roles: ["dev"] }, runtime: { cwd: "." } },
  qa: { emoji: "💡", description: "quick", mode: "ephemeral",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
}
const dm = (content: string, userId = "u1"): InboundMessage =>
  ({ chatId: "c", messageId: "m", userId, user: "bob", content, ts: "t", isDM: true })

function fakes() {
  const dispatched: { agent: string; chatKey: string }[] = []
  const plain: { chatId: string; text: string }[] = []
  return {
    dispatched, plain,
    deps: {
      resolveRoles: async (_id: string) => ["dev"],
      route: async () => ({ agent: "research", confidence: 0.9, switch: true }),
      dispatch: (agent: string, chatKey: string) => { dispatched.push({ agent, chatKey }); return true },
      isAvailable: () => true,
      sendPlain: async (chatId: string, text: string) => { plain.push({ chatId, text }) },
    },
  }
}

test("routes a first message to the chosen agent", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("research the X protocol"))
  expect(f.dispatched[0].agent).toBe("research")
})

test("!agents lists permitted agents without dispatching", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("!agents"))
  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].text).toContain("research")
})

test("a non-permitted user only reaches wildcard agents", async () => {
  const f = fakes()
  f.deps.resolveRoles = async () => []   // no roles
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("anything"))
  expect(f.dispatched[0].agent).toBe("qa")  // research is dev-gated; falls back to wildcard qa
})

test("!switch to a non-permitted agent is refused", async () => {
  const f = fakes()
  f.deps.resolveRoles = async () => []
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("!switch research"))
  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].text.toLowerCase()).toContain("not available")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/orchestrator.ts`**

```ts
import type { AgentRegistry, HubConfig, InboundMessage } from "./types"
import type { RouteDecision } from "./router"
import { permittedAgents } from "./access"
import { chatKey, decideAgent, BindingStore } from "./bindings"
import { parseControlCommand, renderAgentList } from "./gateway"
import { join } from "path"

export interface OrchestratorDeps {
  resolveRoles: (userId: string) => Promise<string[]>
  route: (msg: string, permitted: { name: string; description: string }[], current: string | null)
    => Promise<RouteDecision | null>
  dispatch: (agent: string, chatKey: string, inbound: InboundMessage) => boolean
  isAvailable: (agent: string) => boolean
  sendPlain: (chatId: string, text: string) => Promise<void>
}

export class Orchestrator {
  private bindings: BindingStore
  constructor(private hub: HubConfig, private reg: AgentRegistry, private deps: OrchestratorDeps) {
    this.bindings = new BindingStore(join(hub.stateDir, "bindings.json"))
  }

  async handleMessage(inbound: InboundMessage): Promise<void> {
    const roles = await this.deps.resolveRoles(inbound.userId)
    const permitted = permittedAgents(this.reg, roles, inbound.userId)
    const key = chatKey(this.hub.chatKeyScope, inbound.isDM, inbound.chatId, inbound.userId)
    const bound = this.bindings.get(key)?.agent ?? null

    const control = parseControlCommand(inbound.content)
    if (control) { await this.handleControl(control, inbound, key, permitted, bound); return }

    if (permitted.length === 0) {
      await this.deps.sendPlain(inbound.chatId, "You don't have access to any agents yet.")
      return
    }

    const current = bound && permitted.includes(bound) ? bound : null
    const decision = await this.deps.route(
      inbound.content,
      permitted.map(n => ({ name: n, description: this.reg[n].description })),
      current,
    )
    const agent = decideAgent({
      current, permitted, decision,
      threshold: this.hub.switchThreshold, defaultAgent: this.hub.defaultAgent,
    })

    if (!this.deps.isAvailable(agent)) {
      await this.deps.sendPlain(inbound.chatId,
        `${this.reg[agent].emoji} ${agent} is offline right now. Try \`!agents\`.`)
      return
    }
    this.bindings.set(key, { agent, sessionId: this.bindings.get(key)?.sessionId, lastActive: inbound.ts.length })
    this.deps.dispatch(agent, key, inbound)
  }

  private async handleControl(
    c: ReturnType<typeof parseControlCommand> & object,
    inbound: InboundMessage, key: string, permitted: string[], bound: string | null,
  ): Promise<void> {
    switch (c.cmd) {
      case "agents":
        await this.deps.sendPlain(inbound.chatId, renderAgentList(this.reg, permitted, bound)); return
      case "who":
        await this.deps.sendPlain(inbound.chatId, bound ? `Bound to **${bound}**.` : "Not bound yet."); return
      case "reset":
        this.bindings.clear(key)
        await this.deps.sendPlain(inbound.chatId, "Cleared. Next message routes fresh."); return
      case "switch":
        if (!permitted.includes(c.arg)) {
          await this.deps.sendPlain(inbound.chatId, `**${c.arg}** is not available to you.`); return
        }
        this.bindings.set(key, { agent: c.arg, lastActive: inbound.ts.length })
        await this.deps.sendPlain(inbound.chatId, `Switched to ${this.reg[c.arg].emoji} **${c.arg}**.`); return
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/orchestrator.test.ts`
Expected: `4 pass`.

- [ ] **Step 5: Implement the thin entrypoint `hub/index.ts`**

```ts
import { join } from "path"
import { config as loadEnv } from "./env"   // see note below
import { loadConfigs } from "./config"
import { Gateway } from "./gateway"
import { Dispatcher } from "./transports/index"
import { HeadlessTransport } from "./transports/headless"
import { ChannelShimTransport } from "./transports/channelShim"
import { makeHeadlessRunner, makeRouterRunner } from "./transports/spawnClaude"
import { route as routeFn } from "./router"
import { Orchestrator } from "./orchestrator"

const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const { hub, agents } = loadConfigs(CONFIG_DIR)

loadEnv(join(hub.stateDir, ".env"))   // load DISCORD_BOT_TOKEN if present
const token = process.env[hub.botTokenEnv]
if (!token) { console.error(`missing ${hub.botTokenEnv}`); process.exit(1) }

const gateway = new Gateway(hub, agents)
const routerRunner = makeRouterRunner()
const headlessRunner = makeHeadlessRunner()

const transports = []
const shims: Record<string, ChannelShimTransport> = {}
for (const [name, cfg] of Object.entries(agents)) {
  if (cfg.mode === "ephemeral") {
    transports.push(new HeadlessTransport(name, cfg, headlessRunner, hub.ephemeralTimeoutMs))
  } else {
    const t = new ChannelShimTransport(name, join(hub.stateDir, `${name}.sock`))
    await t.listen()
    shims[name] = t
    transports.push(t)
  }
}
const dispatcher = new Dispatcher(transports)

dispatcher.onReply(async reply => {
  await gateway.sendReply(reply, agents[reply.agent])
})

const orchestrator = new Orchestrator(hub, agents, {
  resolveRoles: id => gateway.resolveRoles(id),
  route: (msg, permitted, current) =>
    routeFn({ message: msg, permitted, current }, routerRunner, hub.routerModel),
  dispatch: (agent, key, inbound) => dispatcher.dispatch(agent, key, inbound),
  isAvailable: agent => dispatcher.isAvailable(agent),
  sendPlain: (chatId, text) => gateway.sendPlain(chatId, text),
})

gateway.handleInbound(m => { void orchestrator.handleMessage(m) })
await gateway.start(token)
console.error("switchboard hub: gateway connected")
```

- [ ] **Step 6: Add the tiny env loader `hub/env.ts`**

```ts
import { readFileSync } from "fs"
/** Load KEY=value lines from a .env file into process.env (real env wins). */
export function config(path: string): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch { /* no .env — rely on real env */ }
}
```

- [ ] **Step 7: Typecheck + full test run**

Run: `bun run typecheck && bun test`
Expected: all tests pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add hub/orchestrator.ts hub/index.ts hub/env.ts tests/orchestrator.test.ts
git commit -m "feat: hub orchestrator + entrypoint wiring"
```

---

## Phase 5 — Launch script, docs, manual E2E

### Task 18: `start-agent.sh` for persistent agents

**Files:**
- Create: `scripts/start-agent.sh`

- [ ] **Step 1: Write `scripts/start-agent.sh`**

```bash
#!/usr/bin/env bash
# Launch a persistent Switchboard agent: a `claude --channels` session whose
# channel server is the Switchboard shim, pointed at this agent's hub socket.
#
# Usage: scripts/start-agent.sh <agent-name> [extra claude args...]
set -euo pipefail

AGENT="${1:?usage: start-agent.sh <agent-name> [claude args...]}"; shift || true
STATE_DIR="${SWITCHBOARD_STATE_DIR:-$HOME/.switchboard}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export AGENT_NAME="$AGENT"
export HUB_SOCKET="$STATE_DIR/${AGENT}.sock"

if [[ ! -S "$HUB_SOCKET" ]]; then
  echo "hub socket $HUB_SOCKET not found — start the hub first (bun run hub)" >&2
  exit 1
fi

# The shim is registered as a local channel MCP server via --channels.
# CLAUDE_CHANNEL_COMMAND tells claude how to spawn our shim for this session.
exec claude --channels "command:bun run $REPO_DIR/shim/server.ts" "$@"
```

> The exact `--channels` invocation for a local (non-plugin) channel server must be confirmed against the installed Claude Code version during Task 19; if `command:` form is unsupported, package the shim as a minimal local plugin exposing the `claude/channel` capability and reference it as `plugin:switchboard-shim`. Capture the working form in the README.

- [ ] **Step 2: Make it executable and commit**

```bash
chmod +x scripts/start-agent.sh
git add scripts/start-agent.sh
git commit -m "feat: start-agent.sh launcher for persistent agents"
```

---

### Task 19: Manual end-to-end verification

**Files:**
- Modify: `README.md` (add a "Running" section documenting the verified steps)

This task has no automated test — it verifies the whole system against real Discord + real `claude`.

- [ ] **Step 1: Create a Discord bot** per the upstream plugin README (New Application → Bot → enable **Message Content Intent** AND **Server Members Intent** → reset token). Invite it to a test server with: View Channels, Send Messages, Read Message History, Add Reactions.

- [ ] **Step 2: Configure**

```bash
mkdir -p ~/.switchboard
printf 'DISCORD_BOT_TOKEN=%s\n' "<token>" > ~/.switchboard/.env
chmod 600 ~/.switchboard/.env
cp config/agents.example.json config/agents.json
# edit config/hub.config.json: set guildIds to your test server's guild id
```

- [ ] **Step 3: Start the hub**

Run: `bun run hub`
Expected stderr: `switchboard hub: gateway connected`.

- [ ] **Step 4: Pair + ephemeral path.** DM the bot "what is 2+2?". Expected: a reply tagged `**💡 qa** · 4` (or similar). Confirms: gateway inbound, access (`qa` is `"*"`), router → `qa`, headless spawn, tagged reply.

- [ ] **Step 5: Start a persistent agent.** In a second terminal: `scripts/start-agent.sh research`. Confirm the hub logs the shim registering. DM the bot "research the history of WebRTC". Expected: a reply tagged `**🔬 research** · …`. Confirms: socket transport, persistent session, role gating (give yourself the `dev`/`admin` role; without it `research` should be invisible to `!agents`).

- [ ] **Step 6: Sticky + auto-switch.** Send a follow-up ("go deeper") — expect it stays on `research`. Then send "now answer a quick general question" — expect a confident switch (tag changes to `💡 qa`). Try `!who`, `!agents`, `!switch research`, `!reset`.

- [ ] **Step 7: Permission relay.** Configure `research` with a tool that needs approval; trigger it; confirm the Allow/Deny buttons arrive in your DM and that answering routes back to the right agent.

- [ ] **Step 8: Role revocation.** Remove your `dev` role; send another message; confirm `research` is no longer offered and the bot routes you elsewhere.

- [ ] **Step 9: Document the verified run** in `README.md` (the exact `--channels` form that worked, the intents required, the config steps). Commit.

```bash
git add README.md config/agents.json
git commit -m "docs: verified end-to-end running instructions"
```

> Note: `config/agents.json` contains real cwds/ids but no secrets (token lives only in `~/.switchboard/.env`). If your agent paths are sensitive, add `config/agents.json` to `.gitignore` instead of committing it.

---

## Self-review notes (coverage check)

- Spec §5 data-flow steps 1–9 → Tasks 15 (inbound/roles/outbound), 17 (gate→route→decide→dispatch), 4 (tag+chunk), 16 (permission relay).
- Spec §6 transports → Tasks 9 (interface), 10–11 (headless), 12–13 (shim).
- Spec §8 control commands → Tasks 15 (parse/render) + 17 (behavior).
- Spec §9 config → Task 14.
- Spec §10 edge cases → Task 7 (decideAgent fallbacks, permitted-shrink), 10 (timeout apology), 17 (offline reply, no-access reply).
- Spec §3/§7 access + permission stance → Tasks 3, 16.
- Spec §12 testing → unit tests throughout; Task 19 manual E2E.
- Base pairing/allowlist gate (spec §13): **deferred note** — v1 relies on Discord's "shared server" + Public Bot toggle + role/user access as the perimeter; the upstream pairing flow can be ported into a `hub/baseGate.ts` as a fast-follow if open DM spam becomes an issue. This is the one spec element intentionally staged out of the first build; flagged here so it isn't mistaken for full coverage.
