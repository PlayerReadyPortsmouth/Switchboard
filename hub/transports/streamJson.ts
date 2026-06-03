import { writeFileSync, unlinkSync } from "fs"
import type { AgentConfig, AgentReply, InboundMessage, CardSpec } from "../types"
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
  close(): Promise<void>
}

/** A Discord snowflake id (17–20 digits). */
const SNOWFLAKE = /^\d{17,20}$/

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
  private cardThisTurn = false
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
    // An agent may pass a non-snowflake chat_id (e.g. an unexpanded "$CHANNEL"
    // env reference) — fall back to the channel this conversation is bound to.
    const chan = (id: string) => (SNOWFLAKE.test(id) ? id : this.lastChatId)
    socket.onNotify(({ chatId, card, correlationId }) => {
      this.cardThisTurn = true
      this.cb({ agent: this.name, kind: "card", chatId: chan(chatId), card, correlationId })
    })
    socket.onReact(({ chatId, messageId, emoji }) =>
      this.cb({ agent: this.name, kind: "react", chatId: chan(chatId), messageId, emoji }))
    socket.onEdit(({ chatId, messageId, text }) =>
      this.cb({ agent: this.name, kind: "edit", chatId: chan(chatId), messageId, text }))
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
      ...(process.env as Record<string, string>),
      HUB_SOCKET: socketPath, AGENT_NAME: this.name,
    })
    this.alive = true
    this.proc.onExit(() => { this.alive = false })
    this.proc.onStdoutLine((line) => {
      const ev = parseStreamEvent(line)
      if (ev?.kind === "result") {
        // The agent's end-of-turn text is posted as a reply ONLY when it didn't
        // already communicate via a card this turn — a card IS the message, so the
        // transcript summary underneath it is redundant noise. Turns with no card
        // (e.g. a short "Backlogged" acknowledgement) still post their text.
        if (!this.cardThisTurn) {
          this.cb({ agent: this.name, kind: "reply", chatId: this.lastChatId, text: ev.text })
        }
        this.cardThisTurn = false
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
