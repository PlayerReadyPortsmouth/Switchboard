import { writeFileSync, unlinkSync, readFileSync } from "fs"
import type { AgentConfig, AgentReply, InboundMessage, CardSpec, TurnUsage } from "../types"
import { contextTokens, fillPct } from "../usage"
import { TurnGate } from "../turnGate"
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

/** Minimal socket surface StreamJsonTransport needs (real = ShimSocketServer). */
export interface ShimSocketLike {
  listen(): Promise<void>
  onRegister(cb: () => void): void
  onNotify(cb: (n: { chatId: string; card: CardSpec; correlationId: string }) => void): void
  onReact(cb: (r: { chatId: string; messageId: string; emoji: string }) => void): void
  onEdit(cb: (e: { chatId: string; messageId: string; text: string }) => void): void
  onUpdate(cb: (u: { chatId: string; card: CardSpec; correlationId: string }) => void): void
  onFinish(cb: () => void): void
  close(): Promise<void>
}

/** A Discord snowflake id (17–20 digits). */
const SNOWFLAKE = /^\d{17,20}$/

/** Coerce a possibly-malformed agent card into a renderable CardSpec — a card
 *  missing `buttons` / `title` / `body` must not crash the card pipeline. */
export function normalizeCard(card: any): CardSpec {
  const c = card ?? {}
  return {
    ...c,
    title: typeof c.title === "string" ? c.title : "(untitled)",
    body: typeof c.body === "string" ? c.body : "",
    buttons: Array.isArray(c.buttons) ? c.buttons : [],
  }
}

export interface StreamJsonOpts {
  spawner: ProcessSpawner
  socket: ShimSocketLike
  shimPath: string
  socketPath: string
  mcpConfigPath: string
  /** Seam for tests; defaults to writing the file. */
  writeMcpConfig?: (path: string, contents: string) => void
  /** Expose the ask_agent inter-agent consult tool to this agent (CONSULT=1). */
  consultEnabled?: boolean
  /** Expose the attach_file outbound-attachment tool to this agent (ATTACH_FILES=1). */
  attachEnabled?: boolean
  /** Persist+resume the CLI session across restarts (persistent agents). */
  resumable?: boolean
  /** Path to read/write the captured session id. */
  sessionPath?: string
  /** Seams for tests; default to fs read/write of sessionPath. */
  readSession?: () => string | undefined
  writeSession?: (id: string) => void
  /** Called when a submission is rejected because the turn queue is full. */
  onOverflow?: (inbound: InboundMessage) => void
}

/** One agent = one long-lived `claude -p --input-format stream-json` process.
 *  Inbound → stdin; reply ← stdout `result`; cards ← shim socket. */
export class StreamJsonTransport implements AgentTransport {
  private proc: AgentProcessHandle | null = null
  private alive = false
  private closed = false
  private lastChatId = ""
  private cardThisTurn = false
  private lastActivity = Date.now()
  private lastUsage: TurnUsage | null = null
  private cb: (r: AgentReply) => void = () => {}
  private gate: TurnGate

  constructor(
    public readonly name: string,
    private cfg: AgentConfig,
    private opts: StreamJsonOpts,
  ) {
    // One turn in flight at a time; the rest queue. The actual stdin write is
    // the injected `send` — it also stamps lastChatId/lastActivity at *delivery*
    // time so a queued message's reply routes to the right channel.
    this.gate = new TurnGate({
      send: (inbound) => {
        this.lastActivity = Date.now()
        this.lastChatId = inbound.chatId
        this.proc?.writeStdin(userMessageFrame(inbound.content))
      },
      maxQueueDepth: cfg.runtime.maxQueueDepth,
      coalesce: cfg.runtime.coalesceBurst,
    })
  }

  onReply(cb: (r: AgentReply) => void): void { this.cb = cb }
  isAvailable(): boolean { return this.alive }

  async start(): Promise<void> {
    const { socket, spawner, shimPath, socketPath, mcpConfigPath } = this.opts
    // An agent may pass a non-snowflake chat_id (e.g. an unexpanded "$CHANNEL"
    // env reference) — fall back to the channel this conversation is bound to.
    const chan = (id: string) => (SNOWFLAKE.test(id) ? id : this.lastChatId)
    socket.onNotify(({ chatId, card, correlationId }) => {
      this.cardThisTurn = true
      this.cb({ agent: this.name, kind: "card", chatId: chan(chatId), card: normalizeCard(card), correlationId })
    })
    socket.onReact(({ chatId, messageId, emoji }) =>
      this.cb({ agent: this.name, kind: "react", chatId: chan(chatId), messageId, emoji }))
    socket.onEdit(({ chatId, messageId, text }) =>
      this.cb({ agent: this.name, kind: "edit", chatId: chan(chatId), messageId, text }))
    socket.onUpdate(({ chatId, card, correlationId }) => {
      this.cardThisTurn = true
      this.cb({ agent: this.name, kind: "update", chatId: chan(chatId), card: normalizeCard(card), correlationId })
    })
    socket.onFinish(() => {
      // Only ephemeral/spawned agents self-terminate; a persistent agent serves
      // many items and must never be killed by a finish.
      if (this.cfg.mode === "ephemeral") { this.alive = false; try { this.proc?.kill() } catch {} }
    })
    await socket.listen()

    const write = this.opts.writeMcpConfig ?? ((p, c) => writeFileSync(p, c))
    write(mcpConfigPath, JSON.stringify(buildShimMcpConfig(shimPath, socketPath, this.name, this.opts.consultEnabled, this.opts.attachEnabled)))

    const initialSessionId = this.opts.resumable
      ? (this.opts.readSession?.() ?? (this.opts.sessionPath ? readSessionFile(this.opts.sessionPath) : undefined))
      : undefined

    // spawnWith is a local closure so it can reference `this` and retry itself
    // exactly once when a stale --resume causes an immediate pre-init exit.
    const spawnWith = (resumeSessionId: string | undefined, isFallback: boolean) => {
      let initReceived = false
      const argv = buildClaudeArgv({
        mcpConfigPath, resumeSessionId,
        model: this.cfg.runtime.model,
        appendSystemPrompt: this.cfg.runtime.appendSystemPrompt,
        claudeArgs: this.cfg.runtime.claudeArgs,
      })
      this.proc = spawner(argv, this.cfg.runtime.cwd, {
        ...(process.env as Record<string, string>),
        HUB_SOCKET: socketPath, AGENT_NAME: this.name,
      })
      this.alive = true
      this.proc.onExit(() => {
        this.alive = false
        this.gate.reset()
        // Stale --resume: the CLI exits immediately before emitting init when the
        // session id is no longer on disk. Retry once as a fresh session and clear
        // the stale file so future restarts don't hit the same loop.
        if (!initReceived && resumeSessionId && !isFallback) {
          if (this.opts.sessionPath) try { unlinkSync(this.opts.sessionPath) } catch {}
          spawnWith(undefined, true)
        }
      })
      this.proc.onStdoutLine((line) => {
        const ev = parseStreamEvent(line)
        if (ev?.kind === "init") {
          initReceived = true
          if (this.opts.resumable) {
            if (this.opts.writeSession) this.opts.writeSession(ev.sessionId)
            else if (this.opts.sessionPath) writeSessionFile(this.opts.sessionPath, ev.sessionId)
          }
          return
        }
        if (ev?.kind === "result") {
          // Capture this turn's token/cost usage (when the CLI reported it) so the
          // hub can estimate context fill, drive the session governor, and surface
          // it on the live status board. Usage rides out on the reply too.
          if (ev.usage) this.lastUsage = ev.usage
          // The agent's end-of-turn text is posted as a reply ONLY when it didn't
          // already communicate via a card this turn — a card IS the message, so the
          // transcript summary underneath it is redundant noise. Turns with no card
          // (e.g. a short "Backlogged" acknowledgement) still post their text.
          if (!this.cardThisTurn) {
            this.cb({ agent: this.name, kind: "reply", chatId: this.lastChatId, text: ev.text, usage: ev.usage })
          }
          this.cardThisTurn = false
          this.gate.turnComplete()   // turn finished → drain the next queued message
        }
      })
    }

    spawnWith(initialSessionId, false)
  }

  deliver(_chatKey: string, inbound: InboundMessage): void {
    this.lastActivity = Date.now()
    const r = this.gate.submit(inbound)   // sent now, queued, or rejected (overflow)
    if (r === "overflow") this.opts.onOverflow?.(inbound)
  }

  sendInteraction(customId: string, userId: string, fields?: Record<string, string>): void {
    this.lastActivity = Date.now()
    this.proc?.writeStdin(interactionFrame(customId, userId, fields))
  }

  lastActivityMs(): number { return this.lastActivity }

  /** True while a turn is in flight (a reply is still pending). */
  isBusy(): boolean { return this.gate.isBusy() }
  /** Number of messages waiting behind the in-flight turn. */
  queueDepth(): number { return this.gate.queueDepth() }

  /** Discord channel id of the most recently delivered message (empty before first turn). */
  getLastChatId(): string { return this.lastChatId }
  /** Most recent turn's usage, or null before the first reporting turn. */
  lastUsageInfo(): TurnUsage | null { return this.lastUsage }
  /** Estimated current context size (tokens) from the last turn's prompt. */
  contextTokens(): number { return this.lastUsage ? contextTokens(this.lastUsage) : 0 }
  /** Estimated context fill (0..1) against this agent's model window. */
  fillPct(windows?: Record<string, number>): number {
    return this.lastUsage ? fillPct(this.lastUsage, this.cfg.runtime.model, windows) : 0
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { this.proc?.kill() } catch {}
    await this.opts.socket.close()
    try { unlinkSync(this.opts.mcpConfigPath) } catch {}
  }
}

function readSessionFile(p: string): string | undefined {
  try { const s = readFileSync(p, "utf8").trim(); return s || undefined } catch { return undefined }
}
function writeSessionFile(p: string, id: string): void {
  try { writeFileSync(p, id) } catch {}
}

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
