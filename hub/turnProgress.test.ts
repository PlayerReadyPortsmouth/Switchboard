import { describe, expect, test } from "bun:test"
import { HOLDING_INTRO, TurnProgress, isRealChat, looksBig } from "./turnProgress"

const CHAT = "1521490913413824563"
const OTHER = "1572534896629653554"

function harness(options: ConstructorParameters<typeof TurnProgress>[1] = {}) {
  const log: string[] = []
  const messages = new Map<string, string>()
  let seq = 0
  let now = 1_000_000
  const typing = new Set<string>()
  const tp = new TurnProgress({
    post: async (chatId, text) => { const id = `m${++seq}`; messages.set(id, text); log.push(`post ${chatId} ${id}`); return id },
    edit: async (_chatId, id, text) => { messages.set(id, text); log.push(`edit ${id}`) },
    remove: async (_chatId, id) => { messages.delete(id); log.push(`remove ${id}`) },
    typing: { start: (c) => { typing.add(c); log.push(`typing+ ${c}`) }, stop: (c) => { typing.delete(c); log.push(`typing- ${c}`) } },
    tag: (agent) => `**${agent}** · `,
    now: () => now,
    clock: () => "10:04",
  }, options)
  return { tp, log, messages, typing, advance: (ms: number) => { now += ms } }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe("isRealChat / looksBig", () => {
  test("only Discord snowflakes are real chats", () => {
    expect(isRealChat(CHAT)).toBe(true)
    expect(isRealChat("consult:c3")).toBe(false)
    expect(isRealChat("mission:abc")).toBe(false)
    expect(isRealChat("")).toBe(false)
  })
  test("looksBig is a length threshold", () => {
    expect(looksBig("short")).toBe(false)
    expect(looksBig("x".repeat(700))).toBe(true)
    expect(looksBig("x".repeat(50), 40)).toBe(true)
  })
})

describe("TurnProgress", () => {
  test("a small turn types but posts nothing", async () => {
    const h = harness()
    h.tp.begin(CHAT, "Bill")
    expect(h.typing.has(CHAT)).toBe(true)
    await h.tp.finish(CHAT, "Bill")
    expect(h.typing.has(CHAT)).toBe(false)
    expect(h.log.filter(l => l.startsWith("post"))).toEqual([])
    expect(h.tp.activeCount()).toBe(0)
  })

  test("a big turn posts a tagged holding reply and removes it at the end", async () => {
    const h = harness()
    h.tp.begin(CHAT, "Bill", { big: true })
    await settle()
    expect(h.messages.get("m1")).toBe(`**Bill** · ${HOLDING_INTRO}`)
    await h.tp.finish(CHAT, "Bill")
    expect(h.messages.size).toBe(0)
    expect(h.log.at(-1)).toBe("remove m1")
  })

  test("notes are appended to the holding reply in order", async () => {
    const h = harness()
    h.tp.begin(CHAT, "Bill", { big: true })
    h.tp.note("Bill", "Asking **Susie**")
    h.tp.note("Bill", "**Susie** has answered")
    await settle(); await settle()
    expect(h.messages.get("m1")).toBe(
      `**Bill** · ${HOLDING_INTRO}\n• 10:04 Asking **Susie**\n• 10:04 **Susie** has answered`)
  })

  test("a note on a small turn, or for an idle agent, does nothing", async () => {
    const h = harness()
    h.tp.note("Bill", "nobody is working")
    h.tp.begin(CHAT, "Bill")
    h.tp.note("Bill", "Asking **Susie**")
    await settle()
    expect(h.log.filter(l => l.startsWith("edit") || l.startsWith("post"))).toEqual([])
  })

  test("progress lines are capped, oldest dropped", async () => {
    const h = harness({ maxLines: 2 })
    h.tp.begin(CHAT, "Bill", { big: true })
    for (const n of ["one", "two", "three"]) h.tp.note("Bill", n)
    await settle(); await settle()
    expect(h.messages.get("m1")).toBe(`**Bill** · ${HOLDING_INTRO}\n• 10:04 two\n• 10:04 three`)
  })

  test("virtual channels get neither typing nor a holding reply", async () => {
    const h = harness()
    h.tp.begin("consult:c7", "Susie", { big: true })
    await settle()
    expect(h.log).toEqual([])
    expect(h.tp.activeCount()).toBe(0)
  })

  test("holdingReply:false keeps typing but never posts", async () => {
    const h = harness({ holdingReply: false })
    h.tp.begin(CHAT, "Bill", { big: true })
    await settle()
    expect(h.typing.has(CHAT)).toBe(true)
    expect(h.messages.size).toBe(0)
  })

  test("queued turns for one agent: notes go to the oldest, finish removes the right one", async () => {
    const h = harness()
    h.tp.begin(CHAT, "Bill", { big: true })
    h.tp.begin(OTHER, "Bill", { big: true })
    h.tp.note("Bill", "first turn progress")
    await settle(); await settle()
    expect(h.messages.get("m1")).toContain("first turn progress")
    expect(h.messages.get("m2")).not.toContain("first turn progress")
    await h.tp.finish(CHAT, "Bill")
    expect(h.messages.has("m1")).toBe(false)
    expect(h.messages.has("m2")).toBe(true)
    h.tp.note("Bill", "second turn progress")
    await settle(); await settle()
    expect(h.messages.get("m2")).toContain("second turn progress")
  })

  test("typing stays on while another agent is still working the same chat", async () => {
    const h = harness()
    h.tp.begin(CHAT, "Bill")
    h.tp.begin(CHAT, "Susie")
    await h.tp.finish(CHAT, "Bill")
    expect(h.typing.has(CHAT)).toBe(true)
    await h.tp.finish(CHAT, "Susie")
    expect(h.typing.has(CHAT)).toBe(false)
  })

  test("finish for an unknown turn still stops typing and does not throw", async () => {
    const h = harness()
    await h.tp.finish(CHAT, "Bill")
    expect(h.log).toEqual([`typing- ${CHAT}`])
  })

  test("no edit lands after finish", async () => {
    const h = harness()
    h.tp.begin(CHAT, "Bill", { big: true })
    h.tp.note("Bill", "late")
    await h.tp.finish(CHAT, "Bill")
    await settle(); await settle()
    expect(h.messages.size).toBe(0)
    expect(h.log.at(-1)).toBe("remove m1")
  })

  test("sweep closes a turn that never finished and says so", async () => {
    const h = harness({ maxMs: 60_000 })
    h.tp.begin(CHAT, "Bill", { big: true })
    await settle()
    h.advance(30_000)
    expect(h.tp.sweep()).toBe(0)
    h.advance(31_000)
    expect(h.tp.sweep()).toBe(1)
    await settle(); await settle()
    expect(h.messages.get("m1")).toContain("No answer after 1 minutes")
    expect(h.typing.has(CHAT)).toBe(false)
    expect(h.tp.activeCount()).toBe(0)
  })

  test("a failed post is survivable: notes and finish are no-ops", async () => {
    const log: string[] = []
    const tp = new TurnProgress({
      post: async () => { throw new Error("missing permissions") },
      edit: async () => { log.push("edit") },
      remove: async () => { log.push("remove") },
      tag: () => "",
    })
    tp.begin(CHAT, "Bill", { big: true })
    tp.note("Bill", "x")
    await tp.finish(CHAT, "Bill")
    expect(log).toEqual([])
  })
})
