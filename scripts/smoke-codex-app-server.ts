#!/usr/bin/env bun
// Authenticated real-CLI smoke: app-server handshake plus two turns on one thread.
// Usage: bun run scripts/smoke-codex-app-server.ts
import { makeBunProcessSpawner } from "../hub/transports/streamJson"
import { parseCodexMessage, rpcNotification, rpcRequest } from "../hub/transports/codexAppServerFraming"

const proc = makeBunProcessSpawner("codex")(["app-server", "--listen", "stdio://"], process.cwd(), process.env as Record<string, string>)
let nextId = 1
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let turnText = ""
let turnDone: ((status: string) => void) | undefined
let fatal: Error | undefined

proc.onStdoutLine(line => {
  const message = parseCodexMessage(line)
  if (!message) return
  if (message.kind === "response") {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
    return
  }
  if (message.kind === "request") {
    const result = message.method === "mcpServer/elicitation/request" ? { action: "decline", content: null } : { decision: "decline" }
    proc.writeStdin(JSON.stringify({ id: message.id, result }) + "\n")
    return
  }
  const params = message.params as any
  if (message.method === "item/agentMessage/delta" && typeof params?.delta === "string") turnText += params.delta
  if (message.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") turnText = params.item.text
  if (message.method === "turn/completed") turnDone?.(String(params?.turn?.status ?? "unknown"))
})
proc.onExit(code => {
  fatal = new Error(`codex app-server exited with code ${code}`)
  for (const request of pending.values()) request.reject(fatal)
  pending.clear()
  turnDone?.("exited")
})

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.writeStdin(rpcRequest(id, method, params))
  })
}

async function turn(threadId: string, prompt: string): Promise<string> {
  turnText = ""
  const terminal = new Promise<string>(resolve => { turnDone = resolve })
  await request("turn/start", { threadId, input: [{ type: "text", text: prompt }] })
  const status = await terminal
  turnDone = undefined
  if (status !== "completed") throw fatal ?? new Error(`turn ended with status ${status}`)
  return turnText.trim()
}

const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Codex smoke timed out after 180 seconds")), 180_000))
try {
  await Promise.race([(async () => {
    await request("initialize", { clientInfo: { name: "switchboard-smoke", title: "Switchboard smoke", version: "1" } })
    proc.writeStdin(rpcNotification("initialized", {}))
    const started = await request("thread/start", { cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only" }) as any
    const threadId = started?.thread?.id
    if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no thread id")

    const first = await turn(threadId, "Remember the continuity marker BLUEBIRD, then reply with exactly SWITCHBOARD_CODEX_OK and nothing else.")
    if (first !== "SWITCHBOARD_CODEX_OK") throw new Error(`unexpected first reply: ${JSON.stringify(first)}`)
    const second = await turn(threadId, "Using what you remember from the prior turn, reply with exactly SWITCHBOARD_CODEX_RESUME_OK:BLUEBIRD and nothing else.")
    if (second !== "SWITCHBOARD_CODEX_RESUME_OK:BLUEBIRD") throw new Error(`unexpected continuity reply: ${JSON.stringify(second)}`)
    process.stdout.write(`Codex app-server smoke OK: thread ${threadId}; resumed second turn completed\n`)
  })(), timeout])
} catch (error) {
  process.stderr.write(`Codex app-server smoke FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  try { proc.kill() } catch {}
}
