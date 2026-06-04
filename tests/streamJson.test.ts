import { test, expect } from "bun:test"
import { StreamJsonTransport, splitLines, normalizeCard } from "../hub/transports/streamJson"
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
      onUpdate: () => {}, onFinish: () => {},
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
  fs.fireNotify({ chatId: "1511807891881853139", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  expect(replies[0]).toMatchObject({ agent: "worker", kind: "card", chatId: "1511807891881853139", correlationId: "k" })
})

test("card chatId falls back to the conversation channel when not a snowflake", async () => {
  const { t, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => replies.push(r))
  t.deliver("1511807891881853139", { chatId: "1511807891881853139", messageId: "m", userId: "u", user: "x", content: "hi", ts: "t", isDM: false })
  fs.fireNotify({ chatId: "$TRIAGE_CHANNEL", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  expect(replies.find((r) => r.kind === "card").chatId).toBe("1511807891881853139")
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

test("normalizeCard fills missing buttons/title/body so the card pipeline can't crash", () => {
  expect(normalizeCard({ title: "T" })).toEqual({ title: "T", body: "", buttons: [] })
  expect(normalizeCard(undefined)).toEqual({ title: "(untitled)", body: "", buttons: [] })
  const full = { title: "x", body: "y", buttons: [{ customId: "a:b:c", label: "L" }], footer: "f" }
  expect(normalizeCard(full)).toEqual(full)
})

import { test as jt, expect as je } from "bun:test"
import { StreamJsonTransport as SJT } from "../hub/transports/streamJson"
import type { AgentConfig as AC } from "../hub/types"

function fakeSocket2() {
  let notify: any = () => {}, update: any = () => {}, finish: any = () => {}
  return {
    sock: {
      listen: async () => {}, onRegister: () => {},
      onNotify: (cb: any) => { notify = cb }, onReact: () => {}, onEdit: () => {},
      onUpdate: (cb: any) => { update = cb }, onFinish: (cb: any) => { finish = cb },
      close: async () => {},
    },
    fireUpdate: (u: any) => update(u), fireFinish: () => finish(),
  }
}
function fakeProc2() {
  let exitCb: (c: number) => void = () => {}
  const writes: string[] = []; let killed = false
  return {
    handle: { writeStdin: (s: string) => writes.push(s), onStdoutLine: () => {},
      onExit: (cb: any) => { exitCb = cb }, kill: () => { killed = true } },
    writes, killed: () => killed,
  }
}
function make2(mode: "persistent" | "ephemeral") {
  const fp = fakeProc2(); const fs = fakeSocket2()
  const cfg: AC = { emoji: "x", description: "d", mode, access: { roles: [] }, runtime: { cwd: "/w" } }
  const t = new SJT("worker", cfg, {
    spawner: () => fp.handle, socket: fs.sock as any,
    shimPath: "/s", socketPath: "/run/w.sock", mcpConfigPath: "/run/w.mcp.json", writeMcpConfig: () => {},
  })
  return { t, fp, fs }
}

jt("a socket update becomes an update reply", async () => {
  const { t, fs } = make2("ephemeral"); await t.start()
  const replies: any[] = []; t.onReply((r) => replies.push(r))
  fs.fireUpdate({ chatId: "1511807891881853139", correlationId: "T1", card: { title: "T", body: "b", buttons: [] } })
  je(replies[0]).toMatchObject({ kind: "update", correlationId: "T1", chatId: "1511807891881853139" })
})

jt("finish kills an ephemeral process", async () => {
  const { t, fp, fs } = make2("ephemeral"); await t.start()
  fs.fireFinish()
  je(fp.killed()).toBe(true)
  je(t.isAvailable()).toBe(false)
})

jt("finish is a no-op for a persistent process", async () => {
  const { t, fp, fs } = make2("persistent"); await t.start()
  fs.fireFinish()
  je(fp.killed()).toBe(false)
  je(t.isAvailable()).toBe(true)
})

jt("sendInteraction forwards modal fields", async () => {
  const { t, fp } = make2("ephemeral"); await t.start()
  t.sendInteraction("fix:feedback:T1", "u9", { feedback: "go blue" })
  // The frame is a JSON-encoded stream-json user message; parse the text payload
  // and verify the fields= suffix was serialized into it.
  const text = JSON.parse(fp.writes[0]).message.content[0].text as string
  je(text).toContain('fields={"feedback":"go blue"}')
})

jt("lastActivityMs advances on deliver", async () => {
  const { t } = make2("ephemeral"); await t.start()
  const before = t.lastActivityMs()
  await Bun.sleep(5)
  t.deliver("c", { chatId: "c", messageId: "m", userId: "u", user: "x", content: "hi", ts: "t", isDM: false })
  je(t.lastActivityMs()).toBeGreaterThan(before)
})

import { test as zt, expect as ze } from "bun:test"
import { StreamJsonTransport as SJT2 } from "../hub/transports/streamJson"
import type { AgentConfig as AC2 } from "../hub/types"

function fakeProcZ() {
  let line: (l: string) => void = () => {}
  return { handle: { writeStdin() {}, onStdoutLine(cb: any){ line = cb }, onExit(){}, kill(){} },
           emit: (l: string) => line(l) }
}
function fakeSockZ() {
  return { listen: async()=>{}, onRegister(){}, onNotify(){}, onReact(){}, onEdit(){}, onUpdate(){}, onFinish(){}, close: async()=>{} }
}
const cfgZ: AC2 = { emoji:"x", description:"d", mode:"persistent", access:{roles:[]}, runtime:{ cwd:"/w" } }

zt("init event persists the session id when resumable (via writeSession seam)", async () => {
  const fp = fakeProcZ(); let saved = ""
  const t = new SJT2("dev", cfgZ, {
    spawner: () => fp.handle as any, socket: fakeSockZ() as any,
    shimPath:"/s", socketPath:"/r.sock", mcpConfigPath:"/r.mcp.json", writeMcpConfig: () => {},
    resumable: true, writeSession: (id) => { saved = id },
  })
  await t.start()
  fp.emit(JSON.stringify({ type:"system", subtype:"init", session_id:"sess-9" }))
  ze(saved).toBe("sess-9")
})

zt("start() passes --resume from readSession when resumable", async () => {
  let argv: string[] = []
  const t = new SJT2("dev", cfgZ, {
    spawner: (a: string[]) => { argv = a; return { writeStdin(){}, onStdoutLine(){}, onExit(){}, kill(){} } as any },
    socket: fakeSockZ() as any,
    shimPath:"/s", socketPath:"/r.sock", mcpConfigPath:"/r.mcp.json", writeMcpConfig: () => {},
    resumable: true, readSession: () => "sess-7",
  })
  await t.start()
  ze(argv).toContain("--resume")
  ze(argv[argv.indexOf("--resume")+1]).toBe("sess-7")
})

zt("not resumable → no --resume even if a session would resolve", async () => {
  let argv: string[] = []
  const t = new SJT2("dev", cfgZ, {
    spawner: (a: string[]) => { argv = a; return { writeStdin(){}, onStdoutLine(){}, onExit(){}, kill(){} } as any },
    socket: fakeSockZ() as any,
    shimPath:"/s", socketPath:"/r.sock", mcpConfigPath:"/r.mcp.json", writeMcpConfig: () => {},
    readSession: () => "sess-7",   // resumable not set
  })
  await t.start()
  ze(argv).not.toContain("--resume")
})
