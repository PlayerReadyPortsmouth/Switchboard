import { test, expect } from "bun:test"
import { StreamJsonTransport, splitLines } from "../hub/transports/streamJson"
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
    writeMcpConfig: () => {},
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

test("the end-of-turn result is suppressed when a card was posted that turn", async () => {
  const { t, fp, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => replies.push(r))
  fs.fireNotify({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  fp.emitStdout(JSON.stringify({ type: "result", subtype: "success", result: "verbose summary" }))
  // only the card reply — no redundant text reply underneath it
  expect(replies.map((r) => r.kind)).toEqual(["card"])
})

test("a later card-less turn still posts its result text", async () => {
  const { t, fp, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => replies.push(r))
  // turn 1: card → result suppressed
  fs.fireNotify({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  fp.emitStdout(JSON.stringify({ type: "result", result: "summary" }))
  // turn 2 (e.g. a button action): no card → result posted
  t.deliver("c1", { chatId: "c1", messageId: "m2", userId: "u", user: "x", content: "[interaction] …", ts: "t", isDM: false })
  fp.emitStdout(JSON.stringify({ type: "result", result: "📋 Backlogged" }))
  expect(replies.map((r) => r.kind)).toEqual(["card", "reply"])
  expect(replies[1].text).toBe("📋 Backlogged")
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

test("splitLines yields complete lines and buffers a partial remainder", () => {
  const acc = { buf: "" }
  expect(splitLines(acc, "a\nb\nc")).toEqual(["a", "b"])
  expect(acc.buf).toBe("c")
  expect(splitLines(acc, "-more\n")).toEqual(["c-more"])
  expect(acc.buf).toBe("")
})
