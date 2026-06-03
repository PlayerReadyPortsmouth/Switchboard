# stream-json Agent Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead `claude --channels "command:<shim>"` transport with a `StreamJsonTransport` that drives each agent as a long-lived `claude -p --input-format stream-json` process — hub writes inbound to stdin, reads replies from stdout, and relays card/tool calls through the shim registered as a normal MCP server.

**Architecture:** A new `StreamJsonTransport` owns one claude process and a Unix-socket server (for shim tool-call relay). Pure helpers handle stdout-event parsing, stdin framing, argv, and MCP-config generation behind injected seams so they're unit-testable without the real CLI. The shim becomes a plain MCP server (`post_card`/`react`/`edit`). `gateway`, `notifyRouter`, `deployGate`, `scheduler`, `webhookListener` and the config schema are unchanged; `hub/index.ts` is rewired; `ChannelShimTransport`, `HeadlessTransport`, `makeHeadlessRunner`, and `scripts/start-agent.*` are removed.

**Tech Stack:** Bun, TypeScript (ESM), `bun test`, the `claude` CLI (stream-json mode), `@modelcontextprotocol/sdk`.

Proven invocation (smoke-tested on claude 2.1.161):
```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --mcp-config <file> --strict-mcp-config --dangerously-skip-permissions \
  [--model <m>] [--append-system-prompt <p>] [<claudeArgs…>]
```

---

## File Structure

- **Create** `hub/transports/streamJsonFraming.ts` — pure helpers: `parseStreamEvent`, `userMessageFrame`, `interactionFrame`, `buildClaudeArgv`, `buildShimMcpConfig`.
- **Create** `hub/transports/shimSocket.ts` — `ShimSocketServer`: listens on a Unix socket, parses framed shim messages, exposes `onNotify`/`onReact`/`onEdit`/`onRegister`/`isRegistered`/`close`.
- **Create** `hub/transports/streamJson.ts` — `StreamJsonTransport` (implements `AgentTransport`), composes a `ProcessSpawner` + a socket server; adds `sendInteraction` + `close`. Plus `makeBunProcessSpawner` (real spawner).
- **Modify** `hub/types.ts` — add `teardownCommand?: string` to `SpawnTrigger`.
- **Modify** `shim/server.ts` — plain MCP server: `post_card`/`react`/`edit` only; drop `reply` tool + channel/permission/interaction handlers.
- **Modify** `hub/index.ts` — spawn persistent agents as `StreamJsonTransport`s at boot; spawn ephemeral agents per `spawnTrigger` keyed by `jobId` (+ `teardownCommand`); route card buttons to `transport.sendInteraction`.
- **Delete** `hub/transports/channelShim.ts`, `hub/transports/headless.ts`, `scripts/start-agent.ts`, `scripts/start-agent.sh`, and their tests; remove `makeHeadlessRunner` from `hub/transports/spawnClaude.ts`.
- **Create** `scripts/smoke-streamjson.ts` — repeatable real-CLI round-trip check.

---

## Task 1: Pure framing & argv helpers

**Files:**
- Create: `hub/transports/streamJsonFraming.ts`
- Test: `tests/streamJsonFraming.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import {
  parseStreamEvent, userMessageFrame, interactionFrame,
  buildClaudeArgv, buildShimMcpConfig,
} from "../hub/transports/streamJsonFraming"

test("parseStreamEvent extracts a result reply", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", result: "hello" })
  expect(parseStreamEvent(line)).toEqual({ kind: "result", text: "hello" })
})

test("parseStreamEvent tags assistant turns and ignores other/noise", () => {
  expect(parseStreamEvent(JSON.stringify({ type: "assistant" }))).toEqual({ kind: "assistant" })
  expect(parseStreamEvent(JSON.stringify({ type: "system", subtype: "x" }))).toBeNull()
  expect(parseStreamEvent("not json")).toBeNull()
  expect(parseStreamEvent("")).toBeNull()
})

test("userMessageFrame produces a single-line stream-json user message", () => {
  const s = userMessageFrame("ping")
  expect(s.endsWith("\n")).toBe(true)
  expect(JSON.parse(s)).toEqual({
    type: "user", message: { role: "user", content: [{ type: "text", text: "ping" }] },
  })
})

test("interactionFrame embeds custom_id and user_id as a tagged user message", () => {
  const parsed = JSON.parse(interactionFrame("deploy:go:job-1", "u9"))
  const text = parsed.message.content[0].text
  expect(text).toContain("[interaction]")
  expect(text).toContain("custom_id=deploy:go:job-1")
  expect(text).toContain("user_id=u9")
})

test("buildClaudeArgv assembles the proven flags", () => {
  const argv = buildClaudeArgv({
    mcpConfigPath: "/tmp/m.json", model: "claude-haiku-4-5",
    appendSystemPrompt: "be terse", claudeArgs: ["--add-dir", "/x"],
  })
  expect(argv.slice(0, 6)).toEqual([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  ])
  expect(argv).toContain("--mcp-config"); expect(argv).toContain("/tmp/m.json")
  expect(argv).toContain("--strict-mcp-config")
  expect(argv).toContain("--dangerously-skip-permissions")
  expect(argv).toContain("--model"); expect(argv).toContain("claude-haiku-4-5")
  expect(argv).toContain("--append-system-prompt"); expect(argv).toContain("be terse")
  expect(argv.slice(-2)).toEqual(["--add-dir", "/x"])
})

test("buildClaudeArgv omits optional flags when absent", () => {
  const argv = buildClaudeArgv({ mcpConfigPath: "/tmp/m.json" })
  expect(argv).not.toContain("--model")
  expect(argv).not.toContain("--append-system-prompt")
})

test("buildShimMcpConfig registers the shim with its env", () => {
  const cfg = buildShimMcpConfig("/repo/shim/server.ts", "/run/a.sock", "worker")
  expect(cfg).toEqual({
    mcpServers: {
      "switchboard-shim": {
        command: "bun", args: ["run", "/repo/shim/server.ts"],
        env: { HUB_SOCKET: "/run/a.sock", AGENT_NAME: "worker" },
      },
    },
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/streamJsonFraming.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// hub/transports/streamJsonFraming.ts

/** A parsed stdout stream-json event we care about. */
export type StreamEvent =
  | { kind: "result"; text: string }
  | { kind: "assistant" }

/** Parse one newline-delimited stream-json stdout line. Returns null for noise. */
export function parseStreamEvent(line: string): StreamEvent | null {
  const s = line.trim()
  if (!s) return null
  let ev: any
  try { ev = JSON.parse(s) } catch { return null }
  if (ev.type === "result" && typeof ev.result === "string") return { kind: "result", text: ev.result }
  if (ev.type === "assistant") return { kind: "assistant" }
  return null
}

/** A stream-json user message line (newline-terminated) for the agent's stdin. */
export function userMessageFrame(text: string): string {
  return JSON.stringify({
    type: "user", message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n"
}

/** A button click delivered to the agent as a tagged user message. */
export function interactionFrame(customId: string, userId: string): string {
  return userMessageFrame(`[interaction] custom_id=${customId} user_id=${userId}`)
}

export interface ClaudeArgvOpts {
  mcpConfigPath: string
  model?: string
  appendSystemPrompt?: string
  claudeArgs?: string[]
}

/** Build the argv for a stream-json agent process. */
export function buildClaudeArgv(o: ClaudeArgvOpts): string[] {
  const argv = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", o.mcpConfigPath, "--strict-mcp-config",
    "--dangerously-skip-permissions",
  ]
  if (o.model) argv.push("--model", o.model)
  if (o.appendSystemPrompt) argv.push("--append-system-prompt", o.appendSystemPrompt)
  if (o.claudeArgs?.length) argv.push(...o.claudeArgs)
  return argv
}

/** The --mcp-config object registering the shim as a normal MCP server. */
export function buildShimMcpConfig(shimPath: string, socketPath: string, agentName: string) {
  return {
    mcpServers: {
      "switchboard-shim": {
        command: "bun", args: ["run", shimPath],
        env: { HUB_SOCKET: socketPath, AGENT_NAME: agentName },
      },
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/streamJsonFraming.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/transports/streamJsonFraming.ts tests/streamJsonFraming.test.ts
git commit -m "feat(transport): pure stream-json framing + argv helpers"
```

---

## Task 2: `ShimSocketServer`

The receive half of the old `ChannelShimTransport`: a Unix-socket server the shim connects to, forwarding `post_card`/`react`/`edit` tool calls. Reuses `encode`/`LineDecoder` from `hub/framing`.

**Files:**
- Create: `hub/transports/shimSocket.ts`
- Test: `tests/shimSocket.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { ShimSocketServer } from "../hub/transports/shimSocket"
import { encode } from "../hub/framing"
import { connect } from "bun"
import { tmpdir } from "os"
import { join } from "path"

function tmpSock() { return join(tmpdir(), `sb-shimsock-${Math.floor(performance.now())}-${process.pid}.sock`) }

test("receives register, notify, react, edit from a connected shim", async () => {
  const path = tmpSock()
  const srv = new ShimSocketServer(path)
  let registered = false
  const cards: any[] = []; const reacts: any[] = []; const edits: any[] = []
  srv.onRegister(() => { registered = true })
  srv.onNotify((n) => cards.push(n))
  srv.onReact((r) => reacts.push(r))
  srv.onEdit((e) => edits.push(e))
  await srv.listen()

  const client = await connect({ unix: path, socket: { data() {} } })
  client.write(encode({ t: "register", agent: "a" }))
  client.write(encode({ t: "notify", chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "x" }))
  client.write(encode({ t: "react", chatId: "c1", messageId: "m1", emoji: "✅" }))
  client.write(encode({ t: "edit", chatId: "c1", messageId: "m1", text: "new" }))

  const start = performance.now()
  while ((!registered || cards.length === 0 || reacts.length === 0 || edits.length === 0) && performance.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(registered).toBe(true)
  expect(srv.isRegistered()).toBe(true)
  expect(cards[0]).toEqual({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "x" })
  expect(reacts[0]).toEqual({ chatId: "c1", messageId: "m1", emoji: "✅" })
  expect(edits[0]).toEqual({ chatId: "c1", messageId: "m1", text: "new" })
  client.end(); await srv.close()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/shimSocket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// hub/transports/shimSocket.ts
import { unlinkSync } from "fs"
import type { Socket } from "bun"
import type { CardSpec } from "../types"
import { LineDecoder } from "../framing"

type Conn = { socket: Socket<unknown>; decoder: LineDecoder }

/** A Unix-socket server the agent's shim connects to, forwarding tool calls
 *  (post_card / react / edit) from the agent process to the hub. */
export class ShimSocketServer {
  private server?: ReturnType<typeof Bun.listen>
  private registered = false
  private regCb: () => void = () => {}
  private notifyCb: (n: { chatId: string; card: CardSpec; correlationId: string }) => void = () => {}
  private reactCb: (r: { chatId: string; messageId: string; emoji: string }) => void = () => {}
  private editCb: (e: { chatId: string; messageId: string; text: string }) => void = () => {}

  constructor(private socketPath: string) {}

  onRegister(cb: () => void) { this.regCb = cb }
  onNotify(cb: typeof this.notifyCb) { this.notifyCb = cb }
  onReact(cb: typeof this.reactCb) { this.reactCb = cb }
  onEdit(cb: typeof this.editCb) { this.editCb = cb }
  isRegistered() { return this.registered }

  async listen(): Promise<void> {
    try { unlinkSync(this.socketPath) } catch {}
    const self = this
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open(socket) { (socket as any).__c = { socket, decoder: new LineDecoder() } },
        data(socket, data) {
          const c: Conn = (socket as any).__c
          for (const obj of c.decoder.push(data.toString())) self.dispatch(obj as any)
        },
      },
    })
  }

  private dispatch(m: any): void {
    switch (m.t) {
      case "register": this.registered = true; this.regCb(); break
      case "notify": this.notifyCb({ chatId: m.chatId, card: m.card, correlationId: m.correlationId }); break
      case "react": this.reactCb({ chatId: m.chatId, messageId: m.messageId, emoji: m.emoji }); break
      case "edit": this.editCb({ chatId: m.chatId, messageId: m.messageId, text: m.text }); break
    }
  }

  async close(): Promise<void> {
    this.server?.stop(true)
    try { unlinkSync(this.socketPath) } catch {}
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/shimSocket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/transports/shimSocket.ts tests/shimSocket.test.ts
git commit -m "feat(transport): ShimSocketServer for agent tool-call relay"
```

---

## Task 3: `StreamJsonTransport`

**Files:**
- Create: `hub/transports/streamJson.ts`
- Test: `tests/streamJson.test.ts`

Interfaces (define in `streamJson.ts`):

```ts
export interface AgentProcessHandle {
  writeStdin(s: string): void
  onStdoutLine(cb: (line: string) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
}
export type ProcessSpawner = (
  argv: string[], cwd: string, env: Record<string, string>,
) => AgentProcessHandle

/** Minimal socket surface StreamJsonTransport needs (real = ShimSocketServer). */
export interface ShimSocketLike {
  listen(): Promise<void>
  onRegister(cb: () => void): void
  onNotify(cb: (n: { chatId: string; card: import("../types").CardSpec; correlationId: string }) => void): void
  onReact(cb: (r: { chatId: string; messageId: string; emoji: string }) => void): void
  onEdit(cb: (e: { chatId: string; messageId: string; text: string }) => void): void
  close(): Promise<void>
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { StreamJsonTransport } from "../hub/transports/streamJson"
import type { AgentConfig } from "../hub/types"

function fakeProc() {
  let stdoutCb: (l: string) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const writes: string[] = []
  let killed = false
  return {
    handle: {
      writeStdin: (s: string) => writes.push(s),
      onStdoutLine: (cb: any) => { stdoutCb = cb },
      onExit: (cb: any) => { exitCb = cb },
      kill: () => { killed = true },
    },
    emitStdout: (l: string) => stdoutCb(l),
    emitExit: (c: number) => exitCb(c),
    writes, killed: () => killed,
  }
}
function fakeSocket() {
  let notify: any = () => {}; let reg: any = () => {}
  return {
    sock: {
      listen: async () => {},
      onRegister: (cb: any) => { reg = cb },
      onNotify: (cb: any) => { notify = cb },
      onReact: () => {}, onEdit: () => {},
      close: async () => {},
    },
    fireNotify: (n: any) => notify(n),
    fireRegister: () => reg(),
  }
}
const cfg: AgentConfig = {
  emoji: "x", description: "d", mode: "persistent",
  access: { roles: [] }, runtime: { cwd: "/w", model: "claude-haiku-4-5" },
}

function make() {
  const fp = fakeProc(); const fs = fakeSocket()
  let spawnedArgv: string[] = []
  const t = new StreamJsonTransport("worker", cfg, {
    spawner: (argv) => { spawnedArgv = argv; return fp.handle },
    socket: fs.sock,
    shimPath: "/repo/shim/server.ts",
    socketPath: "/run/worker.sock",
    mcpConfigPath: "/run/worker.mcp.json",
    writeMcpConfig: () => {},   // no fs in unit test
  })
  return { t, fp, fs, argv: () => spawnedArgv }
}

test("start() spawns claude with stream-json argv and is available", async () => {
  const { t, argv } = make()
  await t.start()
  expect(argv()).toContain("--input-format")
  expect(argv()).toContain("stream-json")
  expect(t.isAvailable()).toBe(true)
})

test("deliver writes a stream-json user message to stdin", async () => {
  const { t, fp } = make(); await t.start()
  t.deliver("c1", { chatId: "c1", messageId: "m", userId: "u", user: "x", content: "ping", ts: "t", isDM: false })
  expect(fp.writes.length).toBe(1)
  expect(JSON.parse(fp.writes[0]).message.content[0].text).toBe("ping")
})

test("a result event becomes a reply to the last-delivered chat", async () => {
  const { t, fp } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => replies.push(r))
  t.deliver("c9", { chatId: "c9", messageId: "m", userId: "u", user: "x", content: "hi", ts: "t", isDM: false })
  fp.emitStdout(JSON.stringify({ type: "result", subtype: "success", result: "done" }))
  expect(replies).toEqual([{ agent: "worker", kind: "reply", chatId: "c9", text: "done" }])
})

test("a notify (card) from the socket becomes a card reply", async () => {
  const { t, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => replies.push(r))
  fs.fireNotify({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  expect(replies[0]).toMatchObject({ agent: "worker", kind: "card", chatId: "c1", correlationId: "k" })
})

test("sendInteraction writes a tagged user message", async () => {
  const { t, fp } = make(); await t.start()
  t.sendInteraction("deploy:go:job-1", "u9")
  expect(fp.writes[0]).toContain("[interaction]")
  expect(fp.writes[0]).toContain("deploy:go:job-1")
})

test("isAvailable becomes false after the process exits", async () => {
  const { t, fp } = make(); await t.start()
  fp.emitExit(0)
  expect(t.isAvailable()).toBe(false)
})

test("close kills the process and is idempotent", async () => {
  const { t, fp } = make(); await t.start()
  await t.close(); await t.close()
  expect(fp.killed()).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/streamJson.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// hub/transports/streamJson.ts
import { writeFileSync, unlinkSync } from "fs"
import type { AgentConfig, AgentReply, InboundMessage } from "../types"
import type { AgentTransport } from "./index"
import {
  parseStreamEvent, userMessageFrame, interactionFrame,
  buildClaudeArgv, buildShimMcpConfig,
} from "./streamJsonFraming"

export interface AgentProcessHandle {
  writeStdin(s: string): void
  onStdoutLine(cb: (line: string) => void): void
  onExit(cb: (code: number) => void): void
  kill(): void
}
export type ProcessSpawner = (
  argv: string[], cwd: string, env: Record<string, string>,
) => AgentProcessHandle

export interface ShimSocketLike {
  listen(): Promise<void>
  onRegister(cb: () => void): void
  onNotify(cb: (n: { chatId: string; card: import("../types").CardSpec; correlationId: string }) => void): void
  onReact(cb: (r: { chatId: string; messageId: string; emoji: string }) => void): void
  onEdit(cb: (e: { chatId: string; messageId: string; text: string }) => void): void
  close(): Promise<void>
}

export interface StreamJsonOpts {
  spawner: ProcessSpawner
  socket: ShimSocketLike
  shimPath: string
  socketPath: string
  mcpConfigPath: string
  /** Seam for tests; defaults to writing the file. */
  writeMcpConfig?: (path: string, contents: string) => void
}

/** One agent = one long-lived `claude -p --input-format stream-json` process.
 *  Inbound → stdin; reply ← stdout `result`; cards ← shim socket. */
export class StreamJsonTransport implements AgentTransport {
  private proc: AgentProcessHandle | null = null
  private alive = false
  private closed = false
  private lastChatId = ""
  private cb: (r: AgentReply) => void = () => {}

  constructor(
    public readonly name: string,
    private cfg: AgentConfig,
    private opts: StreamJsonOpts,
  ) {}

  onReply(cb: (r: AgentReply) => void): void { this.cb = cb }
  isAvailable(): boolean { return this.alive }

  async start(): Promise<void> {
    const { socket, spawner, shimPath, socketPath, mcpConfigPath } = this.opts
    socket.onNotify(({ chatId, card, correlationId }) =>
      this.cb({ agent: this.name, kind: "card", chatId, card, correlationId }))
    socket.onReact(({ chatId, messageId, emoji }) =>
      this.cb({ agent: this.name, kind: "react", chatId, messageId, emoji }))
    socket.onEdit(({ chatId, messageId, text }) =>
      this.cb({ agent: this.name, kind: "edit", chatId, messageId, text }))
    await socket.listen()

    const write = this.opts.writeMcpConfig ?? ((p, c) => writeFileSync(p, c))
    write(mcpConfigPath, JSON.stringify(buildShimMcpConfig(shimPath, socketPath, this.name)))

    const argv = buildClaudeArgv({
      mcpConfigPath,
      model: this.cfg.runtime.model,
      appendSystemPrompt: this.cfg.runtime.appendSystemPrompt,
      claudeArgs: this.cfg.runtime.claudeArgs,
    })
    this.proc = spawner(argv, this.cfg.runtime.cwd, {
      ...process.env as Record<string, string>,
      HUB_SOCKET: socketPath, AGENT_NAME: this.name,
    })
    this.alive = true
    this.proc.onExit(() => { this.alive = false })
    this.proc.onStdoutLine((line) => {
      const ev = parseStreamEvent(line)
      if (ev?.kind === "result") {
        this.cb({ agent: this.name, kind: "reply", chatId: this.lastChatId, text: ev.text })
      }
    })
  }

  deliver(_chatKey: string, inbound: InboundMessage): void {
    this.lastChatId = inbound.chatId
    this.proc?.writeStdin(userMessageFrame(inbound.content))
  }

  sendInteraction(customId: string, userId: string): void {
    this.proc?.writeStdin(interactionFrame(customId, userId))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { this.proc?.kill() } catch {}
    await this.opts.socket.close()
    try { unlinkSync(this.opts.mcpConfigPath) } catch {}
  }
}
```

Note: `AgentReply` already has `kind: "reply" | "react" | "edit" | "card"` plus `card`/`correlationId` fields (see `hub/types.ts`) — no type change needed.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/streamJson.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/transports/streamJson.ts tests/streamJson.test.ts
git commit -m "feat(transport): StreamJsonTransport (stdin deliver, stdout reply, socket cards)"
```

---

## Task 4: Real Bun process spawner

**Files:**
- Modify: `hub/transports/streamJson.ts` (append `makeBunProcessSpawner`)
- Test: `tests/streamJson.test.ts` (add one behavioural test driving a real `cat`-like echo is overkill; instead unit-test line-splitting via a tiny exported helper)

- [ ] **Step 1: Add a failing test for stdout line-splitting**

Append to `tests/streamJson.test.ts`:
```ts
import { splitLines } from "../hub/transports/streamJson"

test("splitLines yields complete lines and buffers a partial remainder", () => {
  const acc = { buf: "" }
  expect(splitLines(acc, 'a\nb\nc')).toEqual(["a", "b"])
  expect(acc.buf).toBe("c")
  expect(splitLines(acc, 'c-more\n')).toEqual(["c-more"])
  expect(acc.buf).toBe("")
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/streamJson.test.ts -t splitLines`
Expected: FAIL — `splitLines` not exported.

- [ ] **Step 3: Implement**

Append to `hub/transports/streamJson.ts`:
```ts
/** Accumulate chunks and yield complete newline-delimited lines. */
export function splitLines(acc: { buf: string }, chunk: string): string[] {
  acc.buf += chunk
  const out: string[] = []
  let nl: number
  while ((nl = acc.buf.indexOf("\n")) >= 0) {
    out.push(acc.buf.slice(0, nl))
    acc.buf = acc.buf.slice(nl + 1)
  }
  return out
}

/** Real spawner: Bun.spawn with a stdout line reader. */
export function makeBunProcessSpawner(bin = "claude"): ProcessSpawner {
  return (argv, cwd, env) => {
    const proc = Bun.spawn([bin, ...argv], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "inherit" })
    let lineCb: (l: string) => void = () => {}
    let exitCb: (c: number) => void = () => {}
    const acc = { buf: "" }
    ;(async () => {
      const dec = new TextDecoder()
      for await (const chunk of proc.stdout as any) {
        for (const line of splitLines(acc, dec.decode(chunk))) lineCb(line)
      }
    })()
    void proc.exited.then((code) => exitCb(code ?? 0))
    return {
      writeStdin: (s) => { proc.stdin.write(s); proc.stdin.flush() },
      onStdoutLine: (cb) => { lineCb = cb },
      onExit: (cb) => { exitCb = cb },
      kill: () => { try { proc.stdin.end() } catch {}; proc.kill() },
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/streamJson.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/transports/streamJson.ts tests/streamJson.test.ts
git commit -m "feat(transport): real Bun process spawner + line splitter"
```

---

## Task 5: Simplify the shim to a plain MCP server

**Files:**
- Modify: `shim/server.ts`
- Modify: `shim/server.test.ts` (drop reply-tool + channel-notification cases; keep post_card/react/edit wire mapping)

- [ ] **Step 1: Update the test to the new surface**

In `shim/server.test.ts`, ensure `toolCallToWire` covers only `post_card`/`react`/`edit_message` and returns `null` for `reply` (removed). Replace any `reply` expectations with:
```ts
test("reply tool is no longer mapped (replies come via stdout result)", () => {
  expect(toolCallToWire("reply", { chat_id: "c", text: "x" })).toBeNull()
})
test("post_card maps to a notify wire message", () => {
  expect(toolCallToWire("post_card", { chat_id: "c", card: { title: "t", body: "b", buttons: [] }, correlation_id: "k" }))
    .toEqual({ t: "notify", chatId: "c", card: { title: "t", body: "b", buttons: [] }, correlationId: "k" })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test shim/server.test.ts`
Expected: FAIL — `reply` still maps.

- [ ] **Step 3: Implement**

In `shim/server.ts`:
- In `toolCallToWire`, **remove** the `case "reply":` branch (keep `react`, `edit_message`, `post_card`).
- **Remove** `inboundToChannelNotification` (inbound now arrives via the agent's stdin, not the shim).
- In `main()`: remove the `experimental: { "claude/channel": {} }` capability, the `Bun.connect` `data` handler branches for `inbound`/`permission_result`/`interaction_result`, and the `permission_request` notification handler. Keep: connect to `HUB_SOCKET`, send `{ t: "register", agent: AGENT }`, the `ListTools` handler (drop the `reply` tool entry; keep `react`/`edit_message`/`post_card`), and the `CallTool` handler.
- Update the server `instructions` to: `"Post rich cards with post_card; react/edit_message as needed. Your normal text response is your reply to the user."`

- [ ] **Step 4: Run to verify it passes**

Run: `bun test shim/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shim/server.ts shim/server.test.ts
git commit -m "refactor(shim): plain MCP server (post_card/react/edit); drop channel + reply paths"
```

---

## Task 6: Add `teardownCommand` to `SpawnTrigger`

**Files:**
- Modify: `hub/types.ts:94-100`
- Test: `tests/config.test.ts` (add a parse assertion)

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:
```ts
import { test as t2, expect as e2 } from "bun:test"
t2("SpawnTrigger accepts an optional teardownCommand", () => {
  const trig = { pattern: "X (\\S+)", agent: "w", taskTemplate: "do $1", setupCommand: "mk $jobId", teardownCommand: "rm $jobId" }
  e2(trig.teardownCommand).toBe("rm $jobId")  // type-level: compiles only if field exists
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run typecheck`
Expected: FAIL — `teardownCommand` not on `SpawnTrigger` (if the test imports the type) — or PASS trivially; the real gate is Step 3's typecheck after wiring in Task 7. If the test passes trivially, keep it as a regression guard.

- [ ] **Step 3: Implement**

In `hub/types.ts`, add to `SpawnTrigger`:
```ts
  teardownCommand?: string // optional shell command run after the spawned agent ends (same $1/$jobId interpolation)
```

- [ ] **Step 4: Run to verify**

Run: `bun run typecheck` then `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/types.ts tests/config.test.ts
git commit -m "feat(types): optional SpawnTrigger.teardownCommand"
```

---

## Task 7: Rewire `hub/index.ts`; remove dead transports & start-agent

**Files:**
- Modify: `hub/index.ts`
- Delete: `hub/transports/channelShim.ts`, `tests/channelShim.test.ts`, `hub/transports/headless.ts`, `tests/headless.test.ts`, `scripts/start-agent.ts`, `scripts/start-agent.sh`, `tests/start-agent.test.ts`
- Modify: `hub/transports/spawnClaude.ts` (remove `makeHeadlessRunner` + its `HeadlessRunner` import usage; keep `makeRouterRunner`), `tests/spawnClaude.test.ts` (drop headless cases)

- [ ] **Step 1: Delete dead files and prune spawnClaude**

```bash
git rm hub/transports/channelShim.ts tests/channelShim.test.ts \
       hub/transports/headless.ts tests/headless.test.ts \
       scripts/start-agent.ts scripts/start-agent.sh tests/start-agent.test.ts
```
In `hub/transports/spawnClaude.ts` remove `makeHeadlessRunner` and the `HeadlessRunner` type import; keep `makeRouterRunner`. In `tests/spawnClaude.test.ts` remove any `makeHeadlessRunner` tests.

- [ ] **Step 2: Rewire `hub/index.ts`**

Replace transport construction and routing. Key changes (full replacement of the transport-construction + button-routing regions):

```ts
import { StreamJsonTransport } from "./transports/streamJson"
import { ShimSocketServer } from "./transports/shimSocket"
import { makeBunProcessSpawner } from "./transports/streamJson"
import { makeRouterRunner } from "./transports/spawnClaude"
import { join } from "path"

const SHIM_PATH = join(import.meta.dir, "..", "shim", "server.ts")
const spawner = makeBunProcessSpawner()

// key → live transport (persistent agent name, or jobId for spawned workers)
const transports = new Map<string, StreamJsonTransport>()

function makeTransport(name: string, key: string, cfg: import("./types").AgentConfig): StreamJsonTransport {
  const socketPath = join(hub.stateDir, `${key}.sock`)
  const t = new StreamJsonTransport(name, cfg, {
    spawner,
    socket: new ShimSocketServer(socketPath),
    shimPath: SHIM_PATH,
    socketPath,
    mcpConfigPath: join(hub.stateDir, `${key}.mcp.json`),
  })
  t.onReply((reply) => { void onAgentReply(reply, key) })
  transports.set(key, t)
  return t
}

// Persistent agents: spawn at boot.
const dispatchTransports: StreamJsonTransport[] = []
for (const [name, cfg] of Object.entries(agents)) {
  if (cfg.mode === "persistent") {
    const t = makeTransport(name, name, cfg)
    await t.start()
    dispatchTransports.push(t)
  }
}
const dispatcher = new Dispatcher(dispatchTransports)
```

`onAgentReply(reply, key)` replaces the old `dispatcher.onReply` body. It must:
1. Register card buttons: when `reply.kind === "card"`, `notifyRouter.register(reply.card!.buttons.map(b => b.customId), key)` then `gateway.sendCard(reply.chatId, reply.card!)`.
2. Run spawn triggers on `reply.text` (when `reply.kind === "reply"`), exactly as the old `dispatcher.onReply` did — call `runSpawnTrigger` and `return` if matched.
3. Otherwise `gateway.sendReply(reply, agents[reply.agent])` (for `reply`) / `gateway` react/edit handling as before.

```ts
async function onAgentReply(reply: import("./types").AgentReply, key: string): Promise<void> {
  if (reply.kind === "card" && reply.card) {
    notifyRouter.register(reply.card.buttons.map((b) => b.customId), key)
    await gateway.sendCard(reply.chatId, reply.card)
    return
  }
  if (reply.kind === "reply" && reply.text) {
    for (const trig of spawnTriggers) {
      const m = trig.re.exec(reply.text)
      if (m) { await runSpawnTrigger(trig, m as unknown as string[], reply.chatId); return }
    }
  }
  await gateway.sendReply(reply, agents[reply.agent])
}
```

Button routing (replace the `gateway.onNotifyButton` + permission-shim wiring):
```ts
gateway.onNotifyButton((customId, userId) => {
  const key = notifyRouter.agentFor(customId)
  if (key) transports.get(key)?.sendInteraction(customId, userId)
})
```
Remove the per-shim `onPermissionRequest`/`onNotify`/`onPermissionButton` loops and the `shims` map (permissions are now `--dangerously-skip-permissions`; cards/interactions handled above). `deliverToAgent` now uses the dispatcher/transport:
```ts
function deliverToAgent(agentName: string, channelId: string, idTag: string, content: string): void {
  const ok = dispatcher.dispatch(agentName, channelId, {
    chatId: channelId, messageId: idTag, userId: "system", user: "hub",
    content, ts: new Date().toISOString(), isDM: false,
  })
  if (!ok) process.stderr.write(`deliver: agent "${agentName}" unavailable; skipping\n`)
}
```

`runSpawnTrigger` (replace the HeadlessTransport body): build an on-demand transport keyed by jobId, start it, deliver the task, and schedule teardown:
```ts
async function runSpawnTrigger(trig: import("./types").SpawnTrigger, groups: string[], chatId: string): Promise<void> {
  const cfg = agents[trig.agent]
  if (!cfg) { process.stderr.write(`spawn-trigger: agent "${trig.agent}" not found\n`); return }
  const jobId = nextJobId()
  if (trig.setupCommand) {
    const code = await Bun.spawn(["sh", "-c", interpolate(trig.setupCommand, groups, jobId)],
      { stdout: "inherit", stderr: "inherit" }).exited
    if (code !== 0) { process.stderr.write(`spawn-trigger: setupCommand exited ${code}; aborting\n`); return }
  }
  const t = makeTransport(trig.agent, jobId, cfg)
  await t.start()
  t.deliver(jobId, { chatId, messageId: `spawn:${jobId}`, userId: "system", user: "hub",
    content: interpolate(trig.taskTemplate, groups, jobId), ts: new Date().toISOString(), isDM: false })
  // Idle teardown: reset on each delivered/observed activity; reuse ephemeralTimeoutMs as the idle window.
  // (Simplest correct behaviour: tear down on process exit; idle GC is a follow-up.)
  scheduleTeardown(jobId, t, () => trig.teardownCommand && interpolate(trig.teardownCommand, groups, jobId))
}

function scheduleTeardown(jobId: string, t: StreamJsonTransport, teardownCmd: () => string | undefined | false): void {
  const tick = setInterval(() => {
    if (!t.isAvailable()) {
      clearInterval(tick)
      void t.close()
      transports.delete(jobId)
      const cmd = teardownCmd()
      if (cmd) void Bun.spawn(["sh", "-c", cmd], { stdout: "inherit", stderr: "inherit" }).exited
    }
  }, 10_000)
  tick.unref()
}
```

Keep the `interpolate`, `nextJobId`, `spawnTriggers` (regex-compiled), webhook listener, scheduler, and command-handling code unchanged. Remove `import` lines for `ChannelShimTransport`, `HeadlessTransport`, `makeHeadlessRunner`, `PermissionRouter`, `drainApprovals`-permission usage that no longer applies (keep `drainApprovals` pairing poller — unrelated). Keep `baseGate`, `orchestrator`, `gateway.setPermissionAuthorizer` (harmless) as-is.

- [ ] **Step 3: Typecheck + full test**

Run: `bun run typecheck && bun test`
Expected: PASS; suite reflects removed/added files.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(hub): drive agents via StreamJsonTransport; remove channels/headless/start-agent"
```

---

## Task 8: Repeatable real-CLI smoke check

**Files:**
- Create: `scripts/smoke-streamjson.ts`

- [ ] **Step 1: Implement** (no unit test — this IS the integration check)

```ts
#!/usr/bin/env bun
// Real-CLI proof: spawn a stream-json agent via StreamJsonTransport, deliver a
// message, assert a stdout reply AND a socket-relayed card. Requires an
// authenticated `claude` on PATH. Usage: bun run scripts/smoke-streamjson.ts
import { join } from "path"
import { StreamJsonTransport, makeBunProcessSpawner } from "../hub/transports/streamJson"
import { ShimSocketServer } from "../hub/transports/shimSocket"
import type { AgentConfig } from "../hub/types"

const cfg: AgentConfig = {
  emoji: "x", description: "smoke", mode: "ephemeral",
  access: { roles: [] },
  runtime: {
    cwd: import.meta.dir, model: "claude-haiku-4-5",
    appendSystemPrompt:
      "When you receive a message, FIRST call mcp__switchboard-shim__post_card with chat_id='c1' " +
      "and card={title:'Hi',body:'b',buttons:[{customId:'t:x:1',label:'OK'}]}. THEN reply with exactly SMOKE_OK.",
  },
}
const socketPath = "/tmp/sb-smoke.sock"
let reply: string | null = null, card = false
const t = new StreamJsonTransport("smoke", cfg, {
  spawner: makeBunProcessSpawner(),
  socket: new ShimSocketServer(socketPath),
  shimPath: join(import.meta.dir, "..", "shim", "server.ts"),
  socketPath, mcpConfigPath: "/tmp/sb-smoke.mcp.json",
})
t.onReply((r) => { if (r.kind === "reply") reply = r.text ?? null; if (r.kind === "card") card = true })
await t.start()
t.deliver("c1", { chatId: "c1", messageId: "m", userId: "u", user: "x", content: "ping", ts: new Date().toISOString(), isDM: false })
const start = Date.now()
while ((reply === null || !card) && Date.now() - start < 120_000) await new Promise((r) => setTimeout(r, 500))
console.error("reply:", reply, "| card:", card)
await t.close()
process.exit(reply !== null && card ? 0 : 1)
```

- [ ] **Step 2: Run it**

Run: `bun run scripts/smoke-streamjson.ts`
Expected: `reply: SMOKE_OK | card: true` and exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-streamjson.ts
git commit -m "test(transport): repeatable real-CLI stream-json smoke check"
```

---

## Task 9: Final verification + README status

**Files:**
- Modify: `README.md` (channels → stream-json wording + the v1 gap note)

- [ ] **Step 1:** Update `README.md` where it describes persistent/ephemeral agents via `claude --channels`/`claude -p --resume` to describe the stream-json model. Replace the "Manual Discord end-to-end testing is still pending" gap with the current status.

- [ ] **Step 2: Full gate**

Run: `bun test && bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 3: Ready-ref grep (public repo!)**

Run: `git diff master | grep -iEn "readyapp|hubspot|feedback|player-ready|aurora|tutoring|45\.141|186188|1496399|1511807|NEW_FEEDBACK|SPAWN_FIX" || echo "NO READY REFS"`
Expected: `NO READY REFS`.

- [ ] **Step 4: Commit**

```bash
git add README.md && git commit -m "docs: README reflects stream-json agent transport"
```

---

## Self-Review notes

- **Spec coverage:** StreamJsonTransport (T1–T4), shim simplification (T5), teardownCommand (T6), index wiring incl. ephemeral-as-stream-json + interaction routing + open permissions (T7), smoke proof (T8), docs (T9). Reply-via-stdout, cards-via-socket, interactions-via-stdin all covered.
- **Type consistency:** `AgentReply.kind` includes `card`/`react`/`edit`/`reply`; `StreamJsonTransport` emits those. `buildClaudeArgv`/`buildShimMcpConfig`/`parseStreamEvent`/`userMessageFrame`/`interactionFrame`/`splitLines` names are used consistently across T1, T3, T4, T8.
- **Deferred (not gaps):** true idle-GC of spawned workers (T7 tears down on process exit; idle window is a noted follow-up). Acceptable for Phase 1.
