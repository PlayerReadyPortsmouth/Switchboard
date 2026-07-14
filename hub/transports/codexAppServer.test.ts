import { describe, expect, test } from "bun:test"
import type { AgentConfig, AgentReply, AgentTurnOutcome, CardSpec, InboundMessage } from "../types"
import type { AgentProcessHandle, ShimSocketLike } from "./streamJson"
import { CodexAppServerTransport } from "./codexAppServer"

class FakeProcess implements AgentProcessHandle {
  writes: string[] = []
  killed = 0
  private stdout: (line: string) => void = () => {}
  private exited: (code: number) => void = () => {}
  writeStdin(s: string): void { this.writes.push(s) }
  onStdoutLine(cb: (line: string) => void): void { this.stdout = cb }
  onExit(cb: (code: number) => void): void { this.exited = cb }
  kill(): void { this.killed++ }
  emit(value: unknown): void { this.stdout(JSON.stringify(value)) }
  exit(code = 1): void { this.exited(code) }
  messages(): any[] { return this.writes.map(line => JSON.parse(line)) }
  last(method: string): any { return this.messages().findLast(message => message.method === method) }
}

class FakeSocket implements ShimSocketLike {
  listened = 0
  closed = 0
  notify: (n: { chatId: string; card: CardSpec; correlationId: string }) => any = () => {}
  react: (r: { chatId: string; messageId: string; emoji: string }) => void = () => {}
  edit: (e: { chatId: string; messageId: string; text: string }) => void = () => {}
  update: (u: { chatId: string; card: CardSpec; correlationId: string }) => any = () => {}
  finish: () => void = () => {}
  async listen(): Promise<void> { this.listened++ }
  onRegister(_cb: () => void): void {}
  onNotify(cb: typeof this.notify): void { this.notify = cb }
  onReact(cb: typeof this.react): void { this.react = cb }
  onEdit(cb: typeof this.edit): void { this.edit = cb }
  onUpdate(cb: typeof this.update): void { this.update = cb }
  onFinish(cb: typeof this.finish): void { this.finish = cb }
  async close(): Promise<void> { this.closed++ }
}

const cfg = (runtime: Partial<AgentConfig["runtime"]> = {}): AgentConfig => ({
  emoji: "🧭", description: "codex", mode: "persistent", access: { roles: ["*"] },
  runtime: { cwd: "C:\\work", provider: "codex", model: "gpt-test", ...runtime },
})
const inbound = (id: string, content = id): InboundMessage => ({
  chatId: "12345678901234567", messageId: id, userId: "u1", user: "User",
  content, ts: "2026-07-14T00:00:00.000Z", isDM: false,
})
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function harness(runtime: Partial<AgentConfig["runtime"]> = {}, seams: Record<string, unknown> = {}) {
  const proc = new FakeProcess()
  const socket = new FakeSocket()
  const saved: string[] = []
  const cleared: string[] = []
  const errors: unknown[] = []
  const transport = new CodexAppServerTransport("worker", cfg(runtime), {
    spawner: () => proc, socket, shimPath: "C:\\switchboard\\shim.ts", socketPath: "C:\\run\\hub.sock",
    resumable: true, readSession: () => undefined, writeSession: id => saved.push(id), clearSession: () => cleared.push("yes"),
    requestTimeoutMs: 1000, reportError: error => errors.push(error), ...seams,
  })
  return { proc, socket, saved, cleared, errors, transport }
}

async function initialize(h: ReturnType<typeof harness>, threadId = "thr-1", sandbox = "dangerFullAccess") {
  const starting = h.transport.start()
  await tick()
  const init = h.proc.last("initialize")
  expect(init).toMatchObject({ id: 1, method: "initialize" })
  h.proc.emit({ id: init.id, result: { userAgent: "codex" } })
  await tick()
  expect(h.proc.last("initialized")).toEqual({ method: "initialized", params: {} })
  const start = h.proc.last("thread/start")
  expect(start.params).toMatchObject({ cwd: "C:\\work", model: "gpt-test", approvalPolicy: "never", sandbox })
  h.proc.emit({ id: start.id, result: { thread: { id: threadId } } })
  await starting
}

describe("Codex app-server lifecycle", () => {
  test("initializes, starts and persists a thread before becoming available", async () => {
    const h = harness()
    const starting = h.transport.start()
    await tick()
    expect(h.transport.isAvailable()).toBe(false)
    h.proc.emit({ id: 1, result: {} })
    await tick()
    const start = h.proc.last("thread/start")
    h.proc.emit({ id: start.id, result: { thread: { id: "thr-new" } } })
    await starting
    expect(h.saved).toEqual(["thr-new"])
    expect(h.transport.isAvailable()).toBe(true)
  })

  test("resumes a saved thread and falls back once when it is stale", async () => {
    const h = harness({}, { readSession: () => "thr-old" })
    const starting = h.transport.start()
    await tick(); h.proc.emit({ id: 1, result: {} }); await tick()
    const resume = h.proc.last("thread/resume")
    expect(resume.params.threadId).toBe("thr-old")
    h.proc.emit({ id: resume.id, error: { code: -32000, message: "missing thread" } })
    await tick()
    expect(h.cleared).toEqual(["yes"])
    const start = h.proc.last("thread/start")
    h.proc.emit({ id: start.id, result: { thread: { id: "thr-fresh" } } })
    await starting
    expect(h.saved).toEqual(["thr-fresh"])
  })

  test("rejects startup and pending requests on process exit, and closes idempotently", async () => {
    const h = harness()
    const starting = h.transport.start()
    await tick(); h.proc.exit(9)
    await expect(starting).rejects.toThrow(/exited/i)
    expect(h.transport.isAvailable()).toBe(false)
    await h.transport.close(); await h.transport.close()
    expect(h.proc.killed).toBe(1)
    expect(h.socket.closed).toBe(1)
  })
})

describe("Codex app-server turns", () => {
  test("serializes turns, prefers completed text, records usage, tools, and exact outcomes", async () => {
    const h = harness({ codexSandbox: "workspace-write", maxQueueDepth: 2 })
    await initialize(h, "thr-1", "workspaceWrite")
    const replies: AgentReply[] = [], outcomes: AgentTurnOutcome[] = [], uses: any[] = [], results: any[] = []
    h.transport.onReply(reply => { replies.push(reply) })
    h.transport.onTurnOutcome(outcome => { outcomes.push(outcome) })
    h.transport.onToolUse(value => uses.push(value))
    h.transport.onToolResult(value => results.push(value))

    expect(h.transport.deliver("a", inbound("m1", "first"))).toBe(true)
    expect(h.transport.deliver("a", inbound("m2", "second"))).toBe(true)
    expect(h.transport.isBusy()).toBe(true)
    expect(h.transport.queueDepth()).toBe(1)
    const turn = h.proc.last("turn/start")
    expect(turn.params).toEqual({ threadId: "thr-1", input: [{ type: "text", text: "first" }] })
    h.proc.emit({ id: turn.id, result: { turn: { id: "turn-1" } } })
    h.proc.emit({ method: "item/agentMessage/delta", params: { delta: "draft" } })
    h.proc.emit({ method: "item/started", params: { item: { type: "mcpToolCall", id: "tool-1", server: "switchboard-shim", tool: "post_card" } } })
    h.proc.emit({ method: "item/completed", params: { item: { type: "mcpToolCall", id: "tool-1", status: "failed" } } })
    h.proc.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "final" } } })
    h.proc.emit({ method: "thread/tokenUsage/updated", params: { tokenUsage: { current: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 } } } })
    h.proc.emit({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } })
    await tick(); await tick()

    expect(replies).toEqual([expect.objectContaining({ kind: "reply", chatId: inbound("m1").chatId, messageId: "m1", text: "final" })])
    expect(outcomes).toEqual([{ agent: "worker", chatId: inbound("m1").chatId, messageId: "m1", state: "completed" }])
    expect(uses).toEqual([[{ id: "tool-1", name: "switchboard-shim/post_card" }]])
    expect(results).toEqual([[{ id: "tool-1", isError: true }]])
    expect(h.transport.lastUsageInfo()).toEqual({ inputTokens: 10, cacheReadTokens: 4, cacheCreationTokens: 0, outputTokens: 2 })
    expect(h.proc.last("turn/start").params.input[0].text).toBe("second")
  })

  test("suppresses text after a card, declines approvals, queues interactions, and reports overflow", async () => {
    const overflow: string[] = []
    const h = harness({ maxQueueDepth: 1 }, { onOverflow: (msg: InboundMessage) => overflow.push(msg.messageId) })
    await initialize(h)
    const replies: AgentReply[] = []
    h.transport.onReply(reply => { replies.push(reply) })
    h.transport.deliver("a", inbound("m1"))
    h.transport.deliver("a", inbound("m2"))
    expect(h.transport.deliver("a", inbound("m3"))).toBe(false)
    expect(overflow).toEqual(["m3"])
    await h.socket.notify({ chatId: "$CHANNEL", card: { title: "Card", body: "Body", buttons: [] }, correlationId: "c1" })
    h.proc.emit({ id: h.proc.last("turn/start").id, result: {} })
    h.proc.emit({ id: 77, method: "item/commandExecution/requestApproval", params: {} })
    expect(h.proc.messages().find(message => message.id === 77)).toEqual({ id: 77, result: { decision: "decline" } })
    h.proc.emit({ method: "item/completed", params: { item: { type: "agentMessage", text: "duplicate" } } })
    h.proc.emit({ method: "turn/completed", params: { turn: { status: "completed" } } })
    await tick(); await tick()
    expect(replies.map(reply => reply.kind)).toEqual(["card"])
    h.transport.sendInteraction("approve:1", "u2", { reason: "yes" })
    expect(h.transport.queueDepth()).toBe(1)
  })

  test("terminal failures and reply callback failures mark the inbound turn failed once", async () => {
    const h = harness()
    await initialize(h)
    const outcomes: AgentTurnOutcome[] = []
    h.transport.onReply(() => { throw new Error("send failed") })
    h.transport.onTurnOutcome(outcome => { outcomes.push(outcome) })
    h.transport.deliver("a", inbound("m1"))
    h.proc.emit({ id: h.proc.last("turn/start").id, result: {} })
    h.proc.emit({ method: "item/agentMessage/delta", params: { delta: "text" } })
    h.proc.emit({ method: "turn/completed", params: { turn: { status: "completed" } } })
    await tick(); await tick()
    expect(outcomes).toEqual([{ agent: "worker", chatId: inbound("m1").chatId, messageId: "m1", state: "failed" }])
    expect(h.errors).toHaveLength(1)
  })
})
