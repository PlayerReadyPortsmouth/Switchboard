import { readFileSync, unlinkSync, writeFileSync } from "fs"
import type { AgentConfig, AgentReply, AgentTurnOutcome, InboundMessage, SendOutcome, TurnUsage } from "../types"
import { contextTokens, fillPct } from "../usage"
import { TurnGate } from "../turnGate"
import type { AgentTransport } from "./index"
import type { AgentProcessHandle, ProcessSpawner, ShimSocketLike } from "./streamJson"
import { normalizeCard } from "./streamJson"
import { buildCodexAppServerArgv, codexUsage, parseCodexMessage, rpcNotification, rpcRequest, type CodexMessage } from "./codexAppServerFraming"

export interface CodexAppServerOpts {
  spawner: ProcessSpawner
  socket: ShimSocketLike
  shimPath: string
  socketPath: string
  consultEnabled?: boolean
  attachEnabled?: boolean
  publishEnabled?: boolean
  peeringEnabled?: boolean
  receiptsEnabled?: boolean
  resumable?: boolean
  sessionPath?: string
  readSession?: () => string | undefined
  writeSession?: (id: string) => void
  clearSession?: () => void
  onOverflow?: (inbound: InboundMessage) => void
  reportError?: (error: unknown) => void
  requestTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const SNOWFLAKE = /^\d{17,20}$/
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value)

/** One configured agent backed by a long-lived `codex app-server` process/thread. */
export class CodexAppServerTransport implements AgentTransport {
  private proc: AgentProcessHandle | null = null
  private alive = false
  private closed = false
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private threadId = ""
  private lastChatId = ""
  private lastActivity = Date.now()
  private lastUsage: TurnUsage | null = null
  private turnUsage: TurnUsage | null = null
  private deltaText = ""
  private completedText: string | undefined
  private cardThisTurn = false
  private turnCallbacks: Promise<boolean>[] = []
  private finalizing = false
  private interactionSeq = 0
  private cb: (r: AgentReply) => void | Promise<void | SendOutcome> = () => {}
  private outcomeCb: (outcome: AgentTurnOutcome) => void | Promise<void> = () => {}
  private toolUseCb: (tools: { id: string; name: string }[]) => void = () => {}
  private toolResultCb: (results: { id: string; isError: boolean }[]) => void = () => {}
  private activeTools = new Map<string, string>()
  private readonly terminalTurns = new Set<string>()
  private gate: TurnGate

  constructor(public readonly name: string, private cfg: AgentConfig, private opts: CodexAppServerOpts) {
    this.gate = new TurnGate({
      send: inbound => { void this.startTurn(inbound).catch(error => this.failActive(error)) },
      maxQueueDepth: cfg.runtime.maxQueueDepth,
      coalesce: cfg.runtime.coalesceBurst,
    })
  }

  onReply(cb: typeof this.cb): void { this.cb = cb }
  onTurnOutcome(cb: typeof this.outcomeCb): void { this.outcomeCb = cb }
  onToolUse(cb: typeof this.toolUseCb): void { this.toolUseCb = cb }
  onToolResult(cb: typeof this.toolResultCb): void { this.toolResultCb = cb }
  isAvailable(): boolean { return this.alive }
  isBusy(): boolean { return this.gate.isBusy() }
  queueDepth(): number { return this.gate.queueDepth() }
  lastActivityMs(): number { return this.lastActivity }
  getLastChatId(): string { return this.lastChatId }
  lastUsageInfo(): TurnUsage | null { return this.lastUsage }
  contextTokens(): number { return this.lastUsage ? contextTokens(this.lastUsage) : 0 }
  fillPct(windows?: Record<string, number>): number { return this.lastUsage ? fillPct(this.lastUsage, this.cfg.runtime.model, windows) : 0 }

  async start(): Promise<void> {
    const { socket, spawner } = this.opts
    this.bindSocket()
    await socket.listen()
    const argv = buildCodexAppServerArgv({
      shimPath: this.opts.shimPath, socketPath: this.opts.socketPath, agentName: this.name,
      appendSystemPrompt: this.cfg.runtime.appendSystemPrompt, codexArgs: this.cfg.runtime.codexArgs,
      consultEnabled: this.opts.consultEnabled, attachEnabled: this.opts.attachEnabled,
      publishEnabled: this.opts.publishEnabled, peeringEnabled: this.opts.peeringEnabled,
      receiptsEnabled: this.opts.receiptsEnabled,
    })
    this.proc = spawner(argv, this.cfg.runtime.cwd, {
      ...(process.env as Record<string, string>), HUB_SOCKET: this.opts.socketPath, AGENT_NAME: this.name,
    })
    this.proc.onStdoutLine(line => this.handleLine(line))
    this.proc.onExit(code => this.handleExit(code))

    await this.request("initialize", { clientInfo: { name: "switchboard", title: "Switchboard", version: "1" } })
    this.proc.writeStdin(rpcNotification("initialized", {}))
    const saved = this.opts.resumable ? this.readSession() : undefined
    let result: unknown
    if (saved) {
      try { result = await this.request("thread/resume", { threadId: saved, ...this.threadSettings() }) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/(missing|not found|invalid).{0,30}thread|thread.{0,30}(missing|not found|invalid)/i.test(message)) throw error
        this.clearSession()
        result = await this.request("thread/start", this.threadSettings())
      }
    } else {
      result = await this.request("thread/start", this.threadSettings())
    }
    const id = record(result) && record(result.thread) && typeof result.thread.id === "string" ? result.thread.id : ""
    if (!id) throw new Error("Codex app-server did not return a thread id")
    this.threadId = id
    if (this.opts.resumable) this.writeSession(id)
    this.alive = true
  }

  deliver(_chatKey: string, inbound: InboundMessage): boolean {
    this.lastActivity = Date.now()
    const result = this.gate.submit(inbound)
    if (result === "overflow") this.opts.onOverflow?.(inbound)
    return result !== "overflow"
  }

  sendInteraction(customId: string, userId: string, fields?: Record<string, string>): void {
    const base = `[interaction] custom_id=${customId} user_id=${userId}`
    const suffix = fields && Object.keys(fields).length ? ` fields=${JSON.stringify(fields)}` : ""
    const inbound: InboundMessage = {
      chatId: this.lastChatId, messageId: `interaction:${++this.interactionSeq}:${customId}`,
      userId, user: userId, content: base + suffix, ts: new Date().toISOString(), isDM: false,
    }
    this.deliver(this.lastChatId, inbound)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.alive = false
    this.rejectPending(new Error("Codex app-server transport closed"))
    this.failPendingTurns()
    try { this.proc?.kill() } catch {}
    await this.opts.socket.close()
  }

  private threadSettings(): Record<string, unknown> {
    return {
      ...(this.cfg.runtime.model ? { model: this.cfg.runtime.model } : {}),
      cwd: this.cfg.runtime.cwd,
      approvalPolicy: "never",
      sandbox: this.cfg.runtime.codexSandbox ?? "danger-full-access",
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("Codex app-server is not running"))
    const id = this.nextId++
    const timeout = this.opts.requestTimeoutMs ?? 30_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.writeStdin(rpcRequest(id, method, params))
    })
  }

  private handleLine(line: string): void {
    const message = parseCodexMessage(line)
    if (!message) return
    if (message.kind === "response") { this.handleResponse(message); return }
    if (message.kind === "request") { this.declineRequest(message); return }
    this.handleNotification(message.method, message.params)
  }

  private handleResponse(message: Extract<CodexMessage, { kind: "response" }>): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`Codex app-server: ${message.error.message}`))
    else pending.resolve(message.result)
  }

  private declineRequest(message: Extract<CodexMessage, { kind: "request" }>): void {
    const result = message.method === "mcpServer/elicitation/request"
      ? { action: "decline", content: null }
      : { decision: "decline" }
    this.proc?.writeStdin(JSON.stringify({ id: message.id, result }) + "\n")
  }

  private handleNotification(method: string, params: unknown): void {
    const p = record(params) ? params : {}
    if (method === "thread/tokenUsage/updated") {
      const usage = codexUsage(p)
      if (usage) { this.lastUsage = usage; this.turnUsage = usage }
      return
    }
    if (method === "item/agentMessage/delta" && typeof p.delta === "string") {
      this.deltaText += p.delta
      return
    }
    const item = record(p.item) ? p.item : undefined
    if (method === "item/started" && item) {
      const tool = this.toolIdentity(item)
      if (tool) { this.activeTools.set(tool.id, tool.name); this.toolUseCb([tool]) }
      return
    }
    if (method === "item/completed" && item) {
      if (item.type === "agentMessage" && typeof item.text === "string") this.completedText = item.text
      const tool = this.toolIdentity(item) ?? (typeof item.id === "string" && this.activeTools.has(item.id)
        ? { id: item.id, name: this.activeTools.get(item.id)! }
        : undefined)
      if (tool) this.toolResultCb([{ id: tool.id, isError: item.status === "failed" || Boolean(item.error) }])
      if (tool) this.activeTools.delete(tool.id)
      return
    }
    if (method === "turn/completed") {
      const turn = record(p.turn) ? p.turn : {}
      const state: AgentTurnOutcome["state"] = turn.status === "completed" ? "completed" : "failed"
      void this.finishTurn(state)
    }
  }

  private toolIdentity(item: Record<string, any>): { id: string; name: string } | undefined {
    if (typeof item.id !== "string") return undefined
    if (item.type === "mcpToolCall" && typeof item.tool === "string") {
      return { id: item.id, name: typeof item.server === "string" ? `${item.server}/${item.tool}` : item.tool }
    }
    if (item.type === "commandExecution") return { id: item.id, name: "commandExecution" }
    return undefined
  }

  private async startTurn(inbound: InboundMessage): Promise<void> {
    if (!this.alive || !this.threadId) throw new Error("Codex app-server thread is not available")
    this.lastActivity = Date.now()
    this.lastChatId = inbound.chatId
    this.deltaText = ""
    this.completedText = undefined
    this.cardThisTurn = false
    this.turnCallbacks = []
    this.finalizing = false
    this.turnUsage = null
    this.activeTools.clear()
    await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text: inbound.content }] })
  }

  private async finishTurn(initialState: AgentTurnOutcome["state"]): Promise<void> {
    if (this.finalizing) return
    const active = this.gate.activeTurn()
    if (!active) return
    this.finalizing = true
    const callbacks = this.turnCallbacks
    const text = this.completedText ?? this.deltaText
    const replyTask = !this.cardThisTurn && text
      ? this.invokeReply({
          agent: this.name, kind: "reply", chatId: active.chatId, messageId: active.messageId, text,
          ...(this.turnUsage ? { usage: this.turnUsage } : {}),
        })
      : null
    const failures = await Promise.all([...callbacks, ...(replyTask ? [replyTask.then(result => result.failed)] : [])])
    await this.emitOutcome(active, initialState === "failed" || failures.some(Boolean) ? "failed" : "completed")
    this.gate.turnComplete()
  }

  private failActive(error: unknown): void {
    this.safeReport(error)
    void this.finishTurn("failed")
  }

  private bindSocket(): void {
    const chan = (id: string) => SNOWFLAKE.test(id) ? id : this.lastChatId
    this.opts.socket.onNotify(({ chatId, card, correlationId }) => {
      this.cardThisTurn = true
      const task = this.invokeReply({ agent: this.name, kind: "card", chatId: chan(chatId), card: normalizeCard(card), correlationId })
      this.turnCallbacks.push(task.then(result => result.failed))
      return task.then(result => result.value)
    })
    this.opts.socket.onReact(({ chatId, messageId, emoji }) => { void this.invokeReply({ agent: this.name, kind: "react", chatId: chan(chatId), messageId, emoji }) })
    this.opts.socket.onEdit(({ chatId, messageId, text }) => { void this.invokeReply({ agent: this.name, kind: "edit", chatId: chan(chatId), messageId, text }) })
    this.opts.socket.onUpdate(({ chatId, card, correlationId }) => {
      this.cardThisTurn = true
      const task = this.invokeReply({ agent: this.name, kind: "update", chatId: chan(chatId), card: normalizeCard(card), correlationId })
      this.turnCallbacks.push(task.then(result => result.failed))
      return task.then(result => result.value)
    })
    this.opts.socket.onFinish(() => {
      if (this.cfg.mode === "ephemeral") { this.alive = false; try { this.proc?.kill() } catch {} }
    })
  }

  private async invokeReply(reply: AgentReply): Promise<{ value: void | SendOutcome; failed: boolean }> {
    try { return { value: await this.cb(reply), failed: false } }
    catch (error) { this.safeReport(error); return { value: { ok: false, error: "Reply handler failed" }, failed: true } }
  }

  private async emitOutcome(inbound: InboundMessage, state: AgentTurnOutcome["state"]): Promise<void> {
    if (this.terminalTurns.has(inbound.messageId)) return
    this.terminalTurns.add(inbound.messageId)
    try { await this.outcomeCb({ agent: this.name, chatId: inbound.chatId, messageId: inbound.messageId, state }) }
    catch (error) { this.safeReport(error) }
  }

  private handleExit(code: number): void {
    this.alive = false
    this.rejectPending(new Error(`Codex app-server exited with code ${code}`))
    this.failPendingTurns()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  private failPendingTurns(): void {
    for (const inbound of this.gate.reset()) void this.emitOutcome(inbound, "failed")
  }

  private readSession(): string | undefined {
    if (this.opts.readSession) return this.opts.readSession()
    if (!this.opts.sessionPath) return undefined
    try { return readFileSync(this.opts.sessionPath, "utf8").trim() || undefined } catch { return undefined }
  }
  private writeSession(id: string): void {
    if (this.opts.writeSession) this.opts.writeSession(id)
    else if (this.opts.sessionPath) try { writeFileSync(this.opts.sessionPath, id) } catch {}
  }
  private clearSession(): void {
    if (this.opts.clearSession) this.opts.clearSession()
    else if (this.opts.sessionPath) try { unlinkSync(this.opts.sessionPath) } catch {}
  }
  private safeReport(error: unknown): void {
    try { (this.opts.reportError ?? (value => process.stderr.write(`codex app-server callback failed: ${value}\n`)))(error) } catch {}
  }
}
