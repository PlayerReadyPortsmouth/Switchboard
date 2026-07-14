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

test("a result event carries the exact active inbound chat and message IDs", async () => {
  const { t, fp } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => { replies.push(r) })
  t.deliver("c9", { chatId: "c9", messageId: "m", userId: "u", user: "x", content: "hi", ts: "t", isDM: false })
  fp.emitStdout(JSON.stringify({ type: "result", subtype: "success", result: "done" }))
  expect(replies).toEqual([{ agent: "worker", kind: "reply", chatId: "c9", messageId: "m", text: "done" }])
})

test("queued turns preserve exact IDs and emit one terminal outcome each", async () => {
  const { t, fp } = make(); await t.start()
  const replies: any[] = []; const outcomes: any[] = []
  t.onReply(r => { replies.push(r) })
  ;(t as any).onTurnOutcome((outcome: any) => outcomes.push(outcome))
  t.deliver("c1", { chatId: "c1", messageId: "m1", userId: "u", user: "x", content: "one", ts: "t", isDM: false })
  t.deliver("c2", { chatId: "c2", messageId: "m2", userId: "u", user: "x", content: "two", ts: "t", isDM: false })
  fp.emitStdout(JSON.stringify({ type: "result", result: "first" }))
  await new Promise(resolve => setTimeout(resolve, 0))
  fp.emitStdout(JSON.stringify({ type: "result", result: "second" }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(replies.map(reply => [reply.chatId, reply.messageId])).toEqual([["c1", "m1"], ["c2", "m2"]])
  expect(outcomes.map(outcome => [outcome.chatId, outcome.messageId, outcome.state])).toEqual([["c1", "m1", "completed"], ["c2", "m2", "completed"]])
})

test("card-only turns still emit an exact completed outcome", async () => {
  const { t, fp, fs } = make(); await t.start()
  const outcomes: any[] = []; (t as any).onTurnOutcome((outcome: any) => outcomes.push(outcome))
  t.deliver("c1", { chatId: "c1", messageId: "card-turn", userId: "u", user: "x", content: "card", ts: "t", isDM: false })
  fs.fireNotify({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  fp.emitStdout(JSON.stringify({ type: "result", result: "summary" }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(outcomes).toEqual([{ agent: "worker", chatId: "c1", messageId: "card-turn", state: "completed" }])
})

test("overflow is synchronously rejected", async () => {
  const fp = fakeProc(); const fs = fakeSocket()
  const t = new StreamJsonTransport("worker", { ...cfg, runtime: { ...cfg.runtime, maxQueueDepth: 0 } }, {
    spawner: () => fp.handle, socket: fs.sock, shimPath: "/s", socketPath: "/r", mcpConfigPath: "/m", writeMcpConfig: () => {},
  })
  await t.start()
  expect(t.deliver("c1", { chatId: "c1", messageId: "m1", userId: "u", user: "x", content: "one", ts: "t", isDM: false })).toBe(true)
  expect(t.deliver("c1", { chatId: "c1", messageId: "m2", userId: "u", user: "x", content: "two", ts: "t", isDM: false })).toBe(false)
})

test("process exit fails the exact active and queued turns", async () => {
  const { t, fp } = make(); await t.start()
  const outcomes: any[] = []; (t as any).onTurnOutcome((outcome: any) => outcomes.push(outcome))
  t.deliver("c1", { chatId: "c1", messageId: "m1", userId: "u", user: "x", content: "one", ts: "t", isDM: false })
  t.deliver("c2", { chatId: "c2", messageId: "m2", userId: "u", user: "x", content: "two", ts: "t", isDM: false })
  fp.emitExit(1)
  expect(outcomes.map(outcome => [outcome.chatId, outcome.messageId, outcome.state])).toEqual([["c1", "m1", "failed"], ["c2", "m2", "failed"]])
})

test("async reply rejection is reported and fails the turn without an unhandled rejection", async () => {
  const fp = fakeProc(); const fs = fakeSocket(); const reported: unknown[] = []
  const t = new StreamJsonTransport("worker", cfg, {
    spawner: () => fp.handle, socket: fs.sock, shimPath: "/s", socketPath: "/r", mcpConfigPath: "/m", writeMcpConfig: () => {}, reportError: (error: unknown) => reported.push(error),
  } as any)
  await t.start()
  const outcomes: any[] = []; (t as any).onTurnOutcome((outcome: any) => outcomes.push(outcome))
  t.onReply(async () => { throw new Error("handler failed") })
  t.deliver("c1", { chatId: "c1", messageId: "m1", userId: "u", user: "x", content: "one", ts: "t", isDM: false })
  fp.emitStdout(JSON.stringify({ type: "result", result: "answer" }))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect((reported[0] as Error).message).toBe("handler failed")
  expect(outcomes[0]).toMatchObject({ messageId: "m1", state: "failed" })
})

test("a notify (card) from the socket becomes a card reply", async () => {
  const { t, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => { replies.push(r) })
  fs.fireNotify({ chatId: "1511807891881853139", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  expect(replies[0]).toMatchObject({ agent: "worker", kind: "card", chatId: "1511807891881853139", correlationId: "k" })
})

test("card chatId falls back to the conversation channel when not a snowflake", async () => {
  const { t, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => { replies.push(r) })
  t.deliver("1511807891881853139", { chatId: "1511807891881853139", messageId: "m", userId: "u", user: "x", content: "hi", ts: "t", isDM: false })
  fs.fireNotify({ chatId: "$TRIAGE_CHANNEL", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  expect(replies.find((r) => r.kind === "card").chatId).toBe("1511807891881853139")
})

test("the end-of-turn result is suppressed when a card was posted that turn", async () => {
  const { t, fp, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => { replies.push(r) })
  fs.fireNotify({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "k" })
  fp.emitStdout(JSON.stringify({ type: "result", subtype: "success", result: "verbose summary" }))
  // only the card reply — no redundant text reply underneath it
  expect(replies.map((r) => r.kind)).toEqual(["card"])
})

test("a later card-less turn still posts its result text", async () => {
  const { t, fp, fs } = make(); await t.start()
  const replies: any[] = []; t.onReply((r) => { replies.push(r) })
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
  // An empty card gets an EMPTY title (not a bare "(untitled)"), so the card
  // pipeline's own `if(!title && !body) → "(no details)"` fallback renders
  // something legible instead of a blank untitled header.
  expect(normalizeCard(undefined)).toEqual({ title: "", body: "", buttons: [] })
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
  const replies: any[] = []; t.onReply((r) => { replies.push(r) })
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

// Stale session: process exits before emitting init → hub retries as fresh session
zt("stale --resume: process exits before init → retry spawned without --resume", async () => {
  const spawns: string[][] = []
  let exitCb: (c: number) => void = () => {}
  // The spawner records each argv set and returns a handle whose onExit we capture
  const t = new SJT2("dev", cfgZ, {
    spawner: (a: string[]) => {
      spawns.push([...a])
      return {
        writeStdin() {}, kill() {},
        onStdoutLine() {},
        onExit: (cb: any) => { exitCb = cb },
      } as any
    },
    socket: fakeSockZ() as any,
    shimPath:"/s", socketPath:"/r.sock", mcpConfigPath:"/r.mcp.json", writeMcpConfig: () => {},
    resumable: true,
    readSession: () => "stale-sess",
    // deleteSession seam: track whether it was called
  })
  await t.start()
  // First spawn: should have --resume stale-sess
  ze(spawns.length).toBe(1)
  ze(spawns[0]).toContain("--resume")
  ze(spawns[0][spawns[0].indexOf("--resume") + 1]).toBe("stale-sess")
  // Process exits before any init event → stale session path
  exitCb(1)
  // Second spawn should have been triggered without --resume
  ze(spawns.length).toBe(2)
  ze(spawns[1]).not.toContain("--resume")
})

zt("stale session retry: does not retry again if fallback also exits before init", async () => {
  const spawns: string[][] = []
  const exitCbs: Array<(c: number) => void> = []
  const t = new SJT2("dev", cfgZ, {
    spawner: (a: string[]) => {
      spawns.push([...a])
      return {
        writeStdin() {}, kill() {},
        onStdoutLine() {},
        onExit: (cb: any) => { exitCbs.push(cb) },
      } as any
    },
    socket: fakeSockZ() as any,
    shimPath:"/s", socketPath:"/r.sock", mcpConfigPath:"/r.mcp.json", writeMcpConfig: () => {},
    resumable: true,
    readSession: () => "stale-sess",
  })
  await t.start()
  exitCbs[0](1)           // first spawn exits before init → triggers fallback
  ze(spawns.length).toBe(2)
  exitCbs[1](1)           // fallback also exits before init → no third spawn (isFallback guard)
  ze(spawns.length).toBe(2)
})
