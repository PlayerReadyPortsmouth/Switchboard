import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { ConversationEventStream, buildAttachmentEvent, buildToolStepEvent, summariseToolInput } from "../hub/conversations"
import { SqliteConversationRepository } from "../hub/conversations/sqliteRepository"
import type { ConversationEvent } from "../hub/conversations/events"
import { StreamJsonTransport } from "../hub/transports/streamJson"
import type { AgentConfig, InboundMessage } from "../hub/types"

/** Regression suite for agent-activity attribution on web-originated turns.
 *
 *  The bug: `hub/index.ts` resolved "which chat is this agent serving?" from a
 *  module-level `lastChatByAgent` map that was only ever written on the Discord
 *  orchestrator's dispatch path (`prepareDispatch` / `dispatchThread`). Turns
 *  dispatched by `TurnCoordinator` — every web turn, and every canonical
 *  (migrated) Discord conversation — went straight to `dispatcher.dispatch`, so
 *  the map kept a stale Discord channel id or nothing at all. Three consumers
 *  read it: document publish ownership, and the tool_use/tool_result execution
 *  spine. All three silently misattributed on web turns.
 *
 *  The fix reads the chat id from the agent's own transport (`getLastChatId()`),
 *  which the turn gate stamps at delivery time for EVERY dispatch path.
 */

const SNOWFLAKE = "123456789012345678"

function fakeProc() {
  let stdoutCb: (l: string) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const writes: string[] = []
  return {
    handle: {
      writeStdin: (s: string) => writes.push(s),
      onStdoutLine: (cb: (l: string) => void) => { stdoutCb = cb },
      onExit: (cb: (c: number) => void) => { exitCb = cb },
      kill: () => {},
    },
    emit: (value: unknown) => stdoutCb(JSON.stringify(value)),
    exit: (c = 1) => exitCb(c),
    writes,
  }
}

const fakeSocket = () => ({
  listen: async () => {},
  onRegister: () => {}, onNotify: () => {}, onReact: () => {},
  onEdit: () => {}, onUpdate: () => {}, onFinish: () => {},
  close: async () => {},
})

const cfg: AgentConfig = {
  emoji: "x", description: "d", mode: "persistent",
  access: { roles: [] }, runtime: { cwd: "/w", model: "claude-haiku-4-5" },
}

const inbound = (chatId: string, messageId: string, content = "hello"): InboundMessage =>
  ({ chatId, messageId, userId: "u1", user: "User", content, ts: "2026-07-18T00:00:00.000Z", isDM: false })

/** A real transport driven by a fake `claude` process. */
async function makeTransport() {
  const proc = fakeProc()
  const t = new StreamJsonTransport("worker", cfg, {
    spawner: () => proc.handle,
    socket: fakeSocket() as never,
    shimPath: "/repo/shim/server.ts",
    socketPath: "/run/worker.sock",
    mcpConfigPath: "/run/worker.mcp.json",
    writeMcpConfig: () => {},
  })
  await t.start()
  return { t, proc }
}

/** Real claude stream-json stdout frames. */
const toolUseFrame = (id: string, name: string, input?: Record<string, unknown>) =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, ...(input ? { input } : {}) }] } })
const toolResultFrame = (id: string, isError = false) =>
  ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } })

/** Mirrors the onPublish / onToolUse / onToolResult wiring in hub/index.ts.
 *  Deliberately thin: the transport, repository, event stream and event builders
 *  it calls are all real production code — only the few lines of glue that live
 *  inline in index.ts are restated here, in the same spirit as
 *  tests/phase2CompositionSmoke.test.ts. */
function wireAgentActivity(
  t: StreamJsonTransport,
  repo: SqliteConversationRepository,
  events: ConversationEventStream,
  opts: { turnStepsOn: boolean },
) {
  const pending = new Map<string, { conversationId: string; name: string; summary?: string; startedAt: number }>()
  let clock = 1000
  const now = () => ++clock

  t.onToolUse((tools) => {
    const chat = t.getLastChatId()
    if (!opts.turnStepsOn || !chat) return
    const conversation = repo.getConversation(chat)
    if (!conversation) return
    const at = now()
    for (const tool of tools) {
      const summary = summariseToolInput(tool.input)
      pending.set(tool.id, { conversationId: conversation.id, name: tool.name, summary, startedAt: at })
      events.publish(buildToolStepEvent(conversation.id, {
        id: tool.id, name: tool.name, status: "running", ...(summary ? { summary } : {}),
      }, at))
    }
  })

  t.onToolResult((results) => {
    if (!opts.turnStepsOn) return
    const at = now()
    for (const result of results) {
      const p = pending.get(result.id)
      if (!p) continue
      pending.delete(result.id)
      events.publish(buildToolStepEvent(p.conversationId, {
        id: result.id, name: p.name, status: result.isError ? "error" : "ok",
        durationMs: Math.max(0, at - p.startedAt), ...(p.summary ? { summary: p.summary } : {}),
      }, at))
    }
  })

  /** Mirrors socket.onPublish: ownership + the inline attachment card. */
  const publish = (doc: { title: string; contentType: string; mode: string; visibility: string }) => {
    const chat = t.getLastChatId()
    const conversation = chat ? repo.getConversation(chat) : null
    const args = {
      ...doc,
      ...(conversation
        ? { ownerId: conversation.createdBy, ownerName: conversation.createdBy, conversationId: conversation.id }
        : {}),
    }
    const token = "tok-1"
    if (conversation) {
      events.publish(buildAttachmentEvent(conversation.id, {
        token, title: doc.title, contentType: doc.contentType, mode: doc.mode, visibility: doc.visibility,
      }, now()))
    }
    return args
  }

  return { publish }
}

function setup(opts: { turnStepsOn?: boolean } = {}) {
  const db = new Database(":memory:")
  const repo = new SqliteConversationRepository(db)
  const events = new ConversationEventStream((id, after, limit) => repo.listMessages(id, after, limit))
  repo.createConversation({ id: "conv-web-1", title: "Web chat", primaryAgent: "worker", createdBy: "aurora@ready.co", createdAt: 10 })
  return { db, repo, events }
}

const doc = { title: "Implementation Plan", contentType: "text/markdown", mode: "doc", visibility: "org" }

test("web turn: a publish is attributed to the conversation's owner and emits an attachment event", async () => {
  const { db, repo, events } = setup()
  const { t } = await makeTransport()
  const wired = wireAgentActivity(t, repo, events, { turnStepsOn: true })

  const seen: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { seen.push(e) })

  // A web-originated turn: TurnCoordinator dispatches with chatId = conversation id.
  t.deliver("conv-web-1", inbound("conv-web-1", "m1"))
  expect(t.getLastChatId()).toBe("conv-web-1")

  const args = wired.publish(doc)
  expect(args).toMatchObject({
    ownerId: "aurora@ready.co",
    ownerName: "aurora@ready.co",
    conversationId: "conv-web-1",
  })

  const attachments = seen.filter((e) => e.kind === "attachment")
  expect(attachments).toHaveLength(1)
  expect(attachments[0]!.attachment).toMatchObject({ token: "tok-1", title: "Implementation Plan", visibility: "org" })
  db.close()
})

test("web turn: tool_use/tool_result reach the conversation event stream as paired tool_steps", async () => {
  const { db, repo, events } = setup()
  const { t, proc } = await makeTransport()
  wireAgentActivity(t, repo, events, { turnStepsOn: true })

  const steps: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })

  t.deliver("conv-web-1", inbound("conv-web-1", "m1"))
  // Drive the REAL stream-json parser, not the callbacks directly.
  proc.emit(toolUseFrame("t1", "Read", { file_path: "/repo/plan.md" }))
  proc.emit(toolResultFrame("t1"))

  expect(steps.map((e) => [e.tool!.id, e.tool!.status])).toEqual([["t1", "running"], ["t1", "ok"]])
  expect(steps[0]!.conversationId).toBe("conv-web-1")
  expect(steps[0]!.tool!.summary).toBe("/repo/plan.md")
  expect(steps[1]!.tool!.durationMs).toBeGreaterThanOrEqual(0)
  db.close()
})

test("web turn: a failing tool reports an error step", async () => {
  const { db, repo, events } = setup()
  const { t, proc } = await makeTransport()
  wireAgentActivity(t, repo, events, { turnStepsOn: true })

  const steps: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })

  t.deliver("conv-web-1", inbound("conv-web-1", "m1"))
  proc.emit(toolUseFrame("t9", "Bash", { command: "false" }))
  proc.emit(toolResultFrame("t9", true))

  expect(steps.map((e) => e.tool!.status)).toEqual(["running", "error"])
  db.close()
})

// ---- Discord regression guards: behaviour must be byte-identical to before ----

test("discord turn: publish stays ownerless and emits no attachment event", async () => {
  const { db, repo, events } = setup()
  const { t } = await makeTransport()
  const wired = wireAgentActivity(t, repo, events, { turnStepsOn: true })

  const seen: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { seen.push(e) })

  t.deliver(SNOWFLAKE, inbound(SNOWFLAKE, "m1"))
  expect(t.getLastChatId()).toBe(SNOWFLAKE)

  const args = wired.publish(doc)
  // No conversation row for a Discord channel id → ownerless, reconciles to the
  // org-visible "discord" bucket exactly as before the fix.
  expect(args).not.toHaveProperty("ownerId")
  expect(args).not.toHaveProperty("conversationId")
  expect(seen.filter((e) => e.kind === "attachment")).toHaveLength(0)
  db.close()
})

test("discord turn: tool events publish no conversation tool_steps", async () => {
  const { db, repo, events } = setup()
  const { t, proc } = await makeTransport()
  wireAgentActivity(t, repo, events, { turnStepsOn: true })

  const steps: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })

  t.deliver(SNOWFLAKE, inbound(SNOWFLAKE, "m1"))
  proc.emit(toolUseFrame("t1", "Read", { file_path: "/repo/plan.md" }))
  proc.emit(toolResultFrame("t1"))

  expect(steps).toHaveLength(0)
  db.close()
})

test("turn steps off: a web turn publishes no tool_steps (flag-off is inert)", async () => {
  const { db, repo, events } = setup()
  const { t, proc } = await makeTransport()
  wireAgentActivity(t, repo, events, { turnStepsOn: false })

  const steps: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })

  t.deliver("conv-web-1", inbound("conv-web-1", "m1"))
  proc.emit(toolUseFrame("t1", "Read", { file_path: "/repo/plan.md" }))
  proc.emit(toolResultFrame("t1"))

  expect(steps).toHaveLength(0)
  db.close()
})

// ---- The property the old name-keyed map could not hold ----

test("attribution follows the in-flight turn, not the most recent dispatch", async () => {
  const { db, repo, events } = setup()
  const { t, proc } = await makeTransport()
  wireAgentActivity(t, repo, events, { turnStepsOn: true })

  const steps: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })

  // Web turn starts; a Discord message for the SAME agent arrives mid-turn and queues.
  t.deliver("conv-web-1", inbound("conv-web-1", "m1"))
  t.deliver(SNOWFLAKE, inbound(SNOWFLAKE, "m2"))

  // The queued Discord message must not steal attribution from the running web turn.
  expect(t.getLastChatId()).toBe("conv-web-1")
  proc.emit(toolUseFrame("t1", "Read", { file_path: "/repo/plan.md" }))
  expect(steps).toHaveLength(1)
  expect(steps[0]!.conversationId).toBe("conv-web-1")

  // Finish the web turn — the gate drains the Discord message, and attribution moves.
  proc.emit({ type: "result", result: "done" })
  expect(t.getLastChatId()).toBe(SNOWFLAKE)
  proc.emit(toolUseFrame("t2", "Read", { file_path: "/repo/other.md" }))
  expect(steps).toHaveLength(1)   // Discord turn contributes no conversation steps
  db.close()
})

// ---- Wiring guard ----
//
// The tests above prove the mechanism, but they restate index.ts's glue, so on
// their own they would still pass if index.ts regressed to a name-keyed map.
// `hub/index.ts` boots the whole hub and cannot be imported in a unit test, so
// pin the one load-bearing line per consumer at the source level instead —
// where each handler gets its chat id from.
test("hub/index.ts resolves agent activity from the transport, not a name-keyed map", () => {
  const src = readFileSync(join(import.meta.dir, "..", "hub", "index.ts"), "utf8")

  // The racy module-level map is gone: it was only ever written on the Discord
  // orchestrator path, so it could never see a web turn.
  // (asserted as booleans so a failure reports the claim, not the whole 2.6k-line file)
  expect(src.includes("lastChatByAgent")).toBe(false)

  // Each of the three consumers derives its chat id from the agent's own transport.
  for (const handler of ["socket.onPublish(", "t.onToolUse(", "t.onToolResult("]) {
    const at = src.indexOf(handler)
    expect(at, `${handler} not found in hub/index.ts`).toBeGreaterThan(-1)
    const usesTransport = src.slice(at, at + 900).includes("getLastChatId()")
    expect(usesTransport, `${handler} must resolve its chat id via getLastChatId()`).toBe(true)
  }
})

test("two replicas of one agent attribute to their own conversations independently", async () => {
  const { db, repo, events } = setup()
  repo.createConversation({ id: "conv-web-2", title: "Second", primaryAgent: "worker", createdBy: "skippy@ready.co", createdAt: 20 })
  const a = await makeTransport()
  const b = await makeTransport()
  wireAgentActivity(a.t, repo, events, { turnStepsOn: true })
  wireAgentActivity(b.t, repo, events, { turnStepsOn: true })

  const steps: ConversationEvent[] = []
  events.subscribe("conv-web-1", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })
  events.subscribe("conv-web-2", 0, (e) => { if (e.kind === "tool_step") steps.push(e) })

  a.t.deliver("conv-web-1", inbound("conv-web-1", "m1"))
  b.t.deliver("conv-web-2", inbound("conv-web-2", "m2"))

  a.proc.emit(toolUseFrame("ta", "Read", { file_path: "/a.md" }))
  b.proc.emit(toolUseFrame("tb", "Read", { file_path: "/b.md" }))

  expect(steps.map((e) => [e.conversationId, e.tool!.id])).toEqual([
    ["conv-web-1", "ta"],
    ["conv-web-2", "tb"],
  ])
  db.close()
})
