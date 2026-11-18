import { describe, expect, test } from "bun:test"
import { SpeakerActions, actionCustomId, actionsFor, parseActionCustomId, type SpeakerActionsConfig } from "./speakerActions"
import type { CardSpec } from "./types"

const AURORA = "186188409499418628"
const STEPHEN = "425368343789305865"
const CHAT = "1521490913413824563"

const cfg: SpeakerActionsConfig = {
  baseUrl: "https://ra.example/", secretEnv: "HUB_KEY",
  actions: {
    "ticket.note.add": { path: "/hub/actions/ticket.note.add", description: "Add a note to one of your tickets",
      params: { ticket_id: "Ticket", body: "Note" }, required: ["ticket_id", "body"] },
    "reminder.create": { path: "/hub/actions/reminder.create", description: "Set yourself a reminder", params: { dueAt: "When", text: "What" }, required: ["dueAt"] },
  },
}

function harness(response: { ok?: boolean; status?: number; body?: string; throws?: boolean } = {}, over: Partial<SpeakerActionsConfig> = {}) {
  let now = 1_000_000, seq = 0
  const cards = new Map<string, CardSpec>()
  const posts: { url: string; headers: Record<string, string>; body: any }[] = []
  const audit: any[] = []
  const sa = new SpeakerActions({ ...cfg, ...over }, {
    sendCard: async (_c, card) => { const id = `m${++seq}`; cards.set(id, card); return id },
    editCard: async (_c, id, card) => { cards.set(id, card) },
    post: async (url, init) => {
      posts.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      if (response.throws) throw new Error("aborted")
      return { ok: response.ok ?? true, status: response.status ?? 200, text: async () => response.body ?? '{"message":"Note added to ticket 123"}' }
    },
    secret: (n) => (n === "HUB_KEY" ? "s3cret" : undefined),
    audit: (e) => audit.push(e),
    agentEmoji: () => "🗂️",
    now: () => now,
    genId: () => "abc",
  })
  const propose = (o: Partial<Parameters<SpeakerActions["propose"]>[0]> = {}) => sa.propose({
    agent: "Assistant", allowed: ["ticket.note.add"], action: "ticket.note.add",
    params: { ticket_id: "123", body: "Called the parent, no answer" }, chatId: CHAT, people: [{ userId: AURORA }], ...o,
  })
  return { sa, cards, posts, audit, propose, advance: (ms: number) => { now += ms } }
}
const ID = "abc1"

describe("customIds and actionsFor", () => {
  test("round-trip and rejection", () => {
    expect(parseActionCustomId(actionCustomId("confirm", "abc1"))).toEqual({ verb: "confirm", id: "abc1" })
    expect(parseActionCustomId("act:delete:abc1")).toBeNull()
    expect(parseActionCustomId("access:approve:Susie~1")).toBeNull()
  })
  test("only configured actions the agent is allowed", () => {
    expect(actionsFor(cfg.actions, ["reminder.create", "payroll.run"]).map(a => a.name)).toEqual(["reminder.create"])
    expect(actionsFor(cfg.actions, undefined)).toEqual([])
    expect(actionsFor(undefined, ["reminder.create"])).toEqual([])
  })
})

describe("SpeakerActions.propose", () => {
  test("shows a confirm card with exactly what will change, and writes nothing", async () => {
    const h = harness()
    const out = await h.propose()
    expect(out).toContain("NOTHING HAS CHANGED YET")
    const card = h.cards.get("m1")!
    expect(card.title).toBe("Confirm: Add a note to one of your tickets")
    expect(card.body).toContain(`<@${AURORA}>`)
    expect(card.fields).toEqual([{ name: "Ticket", value: "123", inline: false }, { name: "Note", value: "Called the parent, no answer", inline: false }])
    expect(card.buttons.map(b => b.customId)).toEqual([actionCustomId("confirm", ID), actionCustomId("cancel", ID)])
    expect(h.posts).toEqual([])
    expect(h.audit.at(-1)).toMatchObject({ outcome: "pending", userId: AURORA })
  })

  test("undeclared parameters from the model are dropped", async () => {
    const h = harness()
    await h.propose({ params: { ticket_id: "123", body: "x", discord_id: STEPHEN, owner: "someone" } })
    expect(h.cards.get("m1")!.fields!.map(f => f.name)).toEqual(["Ticket", "Note"])
    h.sa.click(actionCustomId("confirm", ID), AURORA); await h.sa.idle()
    expect(h.posts[0]!.body).toEqual({ discord_id: AURORA, params: { ticket_id: "123", body: "x" } })
  })

  test("refused without a card: unknown action, action not allowed to this agent, missing required parameter", async () => {
    const h = harness()
    expect(await h.propose({ action: "payroll.run", allowed: ["ticket.note.add", "payroll.run"] })).toContain("not an action you have")
    expect(await h.propose({ action: "reminder.create" })).toContain("not an action you have")
    expect(await h.propose({ params: { ticket_id: "123" } })).toContain("missing body")
    expect(h.cards.size).toBe(0)
  })

  test("refused when the hub cannot name exactly one person, or there is nowhere to confirm", async () => {
    const h = harness()
    expect(await h.propose({ people: [] })).toContain("no person behind this turn")
    expect(await h.propose({ people: [{ userId: AURORA }, { userId: STEPHEN }] })).toContain("more than one person")
    expect(await h.propose({ chatId: undefined })).toContain("nowhere to show")
    expect(h.cards.size).toBe(0)
    expect(h.posts).toEqual([])
  })
})

describe("SpeakerActions.click", () => {
  test("only the person it is for can press, or is even allowed to", async () => {
    const h = harness()
    await h.propose()
    expect(h.sa.ownedBy(actionCustomId("confirm", ID), AURORA)).toBe(true)
    expect(h.sa.ownedBy(actionCustomId("confirm", ID), STEPHEN)).toBe(false)
    expect(h.sa.click(actionCustomId("confirm", ID), STEPHEN)).toContain("Only the person")
    await h.sa.idle()
    expect(h.posts).toEqual([])
  })

  test("confirm performs the change as the speaker, with the hub's key, once", async () => {
    const h = harness()
    await h.propose()
    expect(h.sa.click(actionCustomId("confirm", ID), AURORA)).toBeUndefined()
    await h.sa.idle()
    expect(h.posts.length).toBe(1)
    expect(h.posts[0]!.url).toBe("https://ra.example/hub/actions/ticket.note.add")
    expect(h.posts[0]!.headers.authorization).toBe("Bearer s3cret")
    expect(h.posts[0]!.headers["x-speaker-discord-id"]).toBe(AURORA)
    expect(h.posts[0]!.headers["idempotency-key"]).toBe(ID)
    const card = h.cards.get("m1")!
    expect(card.title.startsWith("Done:")).toBe(true)
    expect(card.body).toContain("Note added to ticket 123")
    expect(card.buttons).toEqual([])
    expect(h.sa.click(actionCustomId("confirm", ID), AURORA)).toContain("no longer waiting")
    await h.sa.idle()
    expect(h.posts.length).toBe(1)
  })

  test("a double press while it is running does not run it twice", async () => {
    const h = harness()
    await h.propose()
    h.sa.click(actionCustomId("confirm", ID), AURORA)
    expect(h.sa.click(actionCustomId("confirm", ID), AURORA)).toContain("already been dealt with")
    await h.sa.idle()
    expect(h.posts.length).toBe(1)
  })

  test("cancel changes nothing and closes the proposal", async () => {
    const h = harness()
    await h.propose()
    expect(h.sa.click(actionCustomId("cancel", ID), AURORA)).toBeUndefined()
    await h.sa.idle()
    expect(h.posts).toEqual([])
    expect(h.cards.get("m1")!.body).toContain("Cancelled")
    expect(h.sa.click(actionCustomId("confirm", ID), AURORA)).toContain("no longer waiting")
  })

  test("a proposal lapses if it is not confirmed in time", async () => {
    const h = harness({}, { confirmTtlMs: 60_000 })
    await h.propose()
    h.advance(61_000)
    expect(h.sa.click(actionCustomId("confirm", ID), AURORA)).toContain("lapsed")
    await h.sa.idle()
    expect(h.posts).toEqual([])
    expect(h.cards.get("m1")!.body).toContain("not confirmed in time")
  })

  test("an upstream refusal is shown, with its reason, and nothing is claimed done", async () => {
    const h = harness({ ok: false, status: 403, body: '{"error":"You do not have tickets.update"}' })
    await h.propose()
    h.sa.click(actionCustomId("confirm", ID), AURORA); await h.sa.idle()
    const card = h.cards.get("m1")!
    expect(card.body).toContain("Not done")
    expect(card.body).toContain("You do not have tickets.update")
    expect(h.audit.at(-1)).toMatchObject({ outcome: "error" })
  })

  test("a timeout says the record may or may not have changed", async () => {
    const h = harness({ throws: true })
    await h.propose()
    h.sa.click(actionCustomId("confirm", ID), AURORA); await h.sa.idle()
    expect(h.cards.get("m1")!.body).toContain("may or may not have changed")
  })

  test("the ledger records which action and record, never the note text", async () => {
    const h = harness()
    await h.propose()
    h.sa.click(actionCustomId("confirm", ID), AURORA); await h.sa.idle()
    const text = JSON.stringify(h.audit)
    expect(text).toContain("ticket.note.add")
    expect(text).toContain('"ticket_id":"123"')
    expect(text).not.toContain("Called the parent")
  })

  test("a forged or foreign button is refused", () => {
    const h = harness()
    expect(h.sa.click("act:confirm:zzz9", AURORA)).toContain("no longer waiting")
    expect(h.sa.click("deploy:go:1", AURORA)).toContain("not an action button")
  })
})
