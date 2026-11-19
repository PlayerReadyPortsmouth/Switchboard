import { describe, expect, test } from "bun:test"
import { GatewayActions, agentScope, gwCustomId, parseGwCustomId, scopeAllows } from "./gatewayActions"
import { GatewayError } from "./hubGateway"
import type { CardSpec } from "./types"

const AURORA = "186188409499418628"
const STEPHEN = "425368343789305865"
const NOTE = "ticket.note.add"

function rig(over: Partial<Record<"catalog" | "read" | "propose" | "confirm" | "cancel" | "status", (...a: any[]) => any>> = {}, opts: { dmFails?: boolean } = {}) {
  let now = 1_700_000_000_000
  const calls: { op: string; args: any[] }[] = []
  const cards: { chatId: string; id: string; card: CardSpec }[] = []
  const edits: { chatId: string; id: string; card: CardSpec }[] = []
  const notes: string[] = []
  const audits: any[] = []
  const op = (name: string, dflt: (...a: any[]) => any) => async (...args: any[]) => { calls.push({ op: name, args }); return (over as any)[name] ? (over as any)[name](...args) : dflt(...args) }
  const client = {
    catalog: op("catalog", () => ({ version: "v", reads: [{ name: "tickets", description: "Your tickets" }], actions: [{ kind: NOTE, description: "Add a note", targetType: "ticket", schema: { properties: { body: { type: "string" } }, required: ["body"] } }] })),
    read: op("read", () => ({ name: "tickets", count: 1, items: [{ id: "T1", title: "Ticket", url: "https://ra/t/T1" }], truncated: false })),
    propose: op("propose", () => ({ cardId: "card1", expiresAt: new Date(now + 15 * 60_000).toISOString(), risk: "confirm", external: false, title: "Add a note to a ticket", preview: [{ label: "Note", value: "Checked." }], changes: [{ field: "Stage", before: "Open", after: "Waiting" }], warnings: ["Mentions a concern"], editable: [], readyAppUrl: "https://ra/t/T1" })),
    confirm: op("confirm", () => ({ status: "done", message: "Note added", url: "https://ra/t/T1" })),
    cancel: op("cancel", () => ({ status: "cancelled" })),
    status: op("status", () => ({ cardId: "card1", status: "pending" })),
  }
  let n = 0
  const ga = new GatewayActions({ baseUrl: "https://ra", clientId: "hub:skippy-4", secretEnv: "K" }, {
    client: client as any,
    sendCard: async (chatId, card) => { const id = `m${++n}`; cards.push({ chatId, id, card }); return id },
    sendCardDM: async (userId, card) => { if (opts.dmFails) return null; const id = `m${++n}`; cards.push({ chatId: `dm-${userId}`, id, card }); return { chatId: `dm-${userId}`, messageId: id } },
    editCard: async (chatId, id, card) => { edits.push({ chatId, id, card }) },
    notify: async (_c, t) => { notes.push(t) },
    audit: (e) => audits.push(e),
    now: () => now, genId: () => "abc",
  })
  const propose = (o: Partial<Parameters<GatewayActions["propose"]>[0]> = {}) => ga.propose({
    agent: "Assistant", action: NOTE, params: { target: { type: "ticket", id: "T1" }, payload: { body: "Checked." } },
    chatId: "900000", isDM: true, people: [{ userId: AURORA }], ...o,
  })
  return { ga, calls, cards, edits, notes, audits, propose, tick: (ms: number) => { now += ms }, ops: (name: string) => calls.filter(c => c.op === name) }
}

describe("custom ids", () => {
  test("round trip, and nothing else parses", () => {
    expect(parseGwCustomId(gwCustomId("confirm", "abc1"))).toEqual({ verb: "confirm", id: "abc1" })
    expect(parseGwCustomId("act:confirm:abc1")).toBeNull()
    expect(parseGwCustomId("gwa:confirm:ABC")).toBeNull()
  })
})

describe("read", () => {
  test("fetches for the sole speaker and reports it for private delivery", async () => {
    const h = rig()
    const got: string[] = []
    const out = await h.ga.read({ agent: "Assistant", tool: "tickets", query: "portal", people: [{ userId: AURORA }], onFetched: u => got.push(u) })
    expect(JSON.parse(out).items[0].id).toBe("T1")
    expect(h.ops("read")[0]!.args.slice(0, 3)).toEqual([AURORA, "tickets", "portal"])
    expect(got).toEqual([AURORA])
    expect(JSON.stringify(h.audits)).not.toContain("portal")
  })
  test("nobody, or two people, behind the turn: no call at all", async () => {
    const h = rig()
    expect(await h.ga.read({ agent: "A", tool: "tickets", people: [] })).toContain("refused")
    expect(await h.ga.read({ agent: "A", tool: "tickets", people: [{ userId: AURORA }, { userId: STEPHEN }] })).toContain("refused")
    expect(h.calls.length).toBe(0)
  })
  test("catalog is rendered for the agent and refetched each time it is asked for", async () => {
    const h = rig()
    const out = await h.ga.read({ agent: "A", tool: "catalog", people: [{ userId: AURORA }] })
    expect(out).toContain("- ticket.note.add: Add a note [target: a ticket id] {body* (string)}")
    await h.ga.read({ agent: "A", tool: "catalog", people: [{ userId: AURORA }] })
    expect(h.ops("catalog").length).toBe(2)
  })
  test("a refusal is passed on in ReadyApp's words and marks nothing private", async () => {
    const h = rig({ read: () => { throw new GatewayError("hub_disabled", 403, "This assistant isn't switched on for you in ReadyApp yet.") } })
    const got: string[] = []
    const out = await h.ga.read({ agent: "A", tool: "tickets", people: [{ userId: AURORA }], onFetched: u => got.push(u) })
    expect(out).toContain("isn't switched on for you")
    expect(got).toEqual([])
  })
})

describe("propose", () => {
  test("in a DM: ReadyApp's preview on a card in that DM, speaker and surface set by the hub", async () => {
    const h = rig()
    const out = await h.propose()
    expect(out).toContain("NOTHING HAS CHANGED YET")
    expect(h.ops("propose")[0]!.args).toEqual([AURORA, { kind: NOTE, target: { type: "ticket", id: "T1" }, payload: { body: "Checked." }, surface: { kind: "discord", channelId: "900000", isDM: true } }])
    const card = h.cards[0]!
    expect(card.chatId).toBe("900000")
    expect(card.card.title).toBe("Add a note to a ticket")
    expect(card.card.fields).toEqual([
      { name: "Note", value: "Checked.", inline: false },
      { name: "Stage", value: "Open → Waiting", inline: false },
      { name: "⚠️ Check before confirming", value: "• Mentions a concern", inline: false },
    ])
    expect(card.card.buttons.map(b => b.label)).toEqual(["Confirm", "Cancel"])
    // The ledger holds the kind and target, never the note.
    expect(JSON.stringify(h.audits)).not.toContain("Checked.")
    expect(h.audits.at(-1)).toMatchObject({ action: "propose", outcome: "pending", userId: AURORA, detail: { kind: NOTE, cardId: "card1", payloadFields: ["body"] } })
  })
  test("in a shared channel: the card goes by DM and the channel gets a pointer only", async () => {
    const h = rig()
    await h.propose({ isDM: false })
    expect(h.cards[0]!.chatId).toBe(`dm-${AURORA}`)
    expect(h.notes).toEqual([]) // the Assistant's own reply is the pointer; the hub adds no second one
    expect(await h.propose({ isDM: false })).toContain("in their DMs")
    expect(h.ops("propose")[0]!.args[1].surface).toEqual({ kind: "discord", channelId: "900000", isDM: false })
  })
  test("DM could not be delivered: the ReadyApp card is withdrawn, nothing left open", async () => {
    const h = rig({}, { dmFails: true })
    const out = await h.propose({ isDM: false })
    await h.ga.idle()
    expect(out).toContain("withdrawn")
    expect(h.ops("cancel")[0]!.args.slice(0, 2)).toEqual([AURORA, "card1"])
    expect(h.ga.openCount()).toBe(0)
  })
  test("a kind not in this person's catalog never reaches propose", async () => {
    const h = rig()
    const out = await h.propose({ action: "ticket.reply" })
    expect(out).toContain("not something this person can do")
    expect(h.ops("propose").length).toBe(0)
  })
  test("flat params are treated as the payload; the model cannot set the identity", async () => {
    const h = rig()
    await h.propose({ params: { target: { type: "ticket", id: 7 }, body: "x", discordId: STEPHEN } })
    const [who, body] = h.ops("propose")[0]!.args
    expect(who).toBe(AURORA)
    expect(body.target).toEqual({ type: "ticket", id: "7" })
    expect(body.payload).toEqual({ body: "x", discordId: STEPHEN }) // ReadyApp rejects extra fields; identity is the first argument
  })
  test("an action on the person's own things is sent with ReadyApp's self target", async () => {
    const h = rig({ catalog: () => ({ reads: [], actions: [{ kind: "myday.task.create", description: "Create a task", targetType: "self", targetTypes: ["self"] }] }) })
    await h.propose({ action: "myday.task.create", params: { payload: { title: "x" } } })
    expect(h.ops("propose")[0]!.args[1].target).toEqual({ type: "self", id: "self" })
  })
  test("nobody behind the turn, or no chat: refused before any call", async () => {
    const h = rig()
    expect(await h.propose({ people: [] })).toContain("refused")
    expect(await h.propose({ chatId: undefined })).toContain("nowhere to show")
    expect(h.calls.length).toBe(0)
  })
  test("ReadyApp's refusal is relayed and no card is shown", async () => {
    const h = rig({ propose: () => { throw new GatewayError("invalid_payload", 400, "body is required.") } })
    const out = await h.propose()
    expect(out).toContain("body is required.")
    expect(h.cards.length).toBe(0)
  })
  test("an external proposal is marked as leaving Player Ready", async () => {
    const h = rig({ propose: () => ({ cardId: "c9", title: "Reply to the customer", external: true, preview: [], editable: [{ field: "text", maxLength: 4000 }], readyAppUrl: "https://ra/x" }) })
    await h.propose()
    expect(h.cards[0]!.card.title).toBe("📤 Reply to the customer")
    expect(h.cards[0]!.card.body).toContain("goes outside Player Ready")
    expect(h.cards[0]!.card.body).toContain("[edit it in ReadyApp](https://ra/x)")
  })
})

describe("an outside-going card ReadyApp has hidden", () => {
  const hiddenReply = { cardId: "c10", title: "Sensitive details: open ReadyApp.", external: true, readyAppUrl: "https://ra/x", editable: [{ field: "text" }],
    preview: [{ label: "Recipient", value: "[email in ReadyApp]" }, { label: "Reply", value: "Sensitive details: open ReadyApp." }] }
  test("has no Confirm button and says why", async () => {
    const h = rig({ propose: () => hiddenReply })
    const out = await h.propose()
    const card = h.cards[0]!.card
    expect(card.buttons.map(b => b.label)).toEqual(["Cancel"])
    expect(card.body).toContain("cannot be confirmed from Discord")
    expect(card.body).toContain("(https://ra/x)")
    expect(card.body).not.toContain("To change the wording")
    expect(out).toContain("CANNOT confirm it from Discord")
  })
  test("a readable outside-going card, and a hidden internal one, keep Confirm", async () => {
    const a = rig({ propose: () => ({ ...hiddenReply, title: "Reply to Lee", preview: [{ label: "Reply", value: "Hi Lee, 12pm works." }] }) })
    await a.propose()
    expect(a.cards[0]!.card.buttons.map(b => b.label)).toEqual(["Confirm", "Cancel"])
    const b = rig({ propose: () => ({ ...hiddenReply, external: false }) })
    await b.propose()
    expect(b.cards[0]!.card.buttons.map(b => b.label)).toEqual(["Confirm", "Cancel"])
  })
})

describe("how a card reads", () => {
  test("no 'Target: You', readable labels, and a new value is not shown twice", async () => {
    const h = rig({ propose: () => ({ cardId: "c2", title: "Create My Day task: You", preview: [{ label: "Target", value: "You" }, { label: "title", value: "test from discord" }, { label: "dueAt", value: "Fri" }], changes: [{ field: "title", before: null, after: "test from discord" }, { field: "stage", before: "Open", after: "Closed" }, { field: "notes", before: null, after: "n" }], warnings: [], editable: [], readyAppUrl: "https://ra/m" }) })
    await h.propose()
    expect(h.cards[0]!.card.fields).toEqual([
      { name: "Title", value: "test from discord", inline: false },
      { name: "Due at", value: "Fri", inline: false },
      { name: "Stage", value: "Open → Closed", inline: false },
      { name: "Notes", value: "n", inline: false },
    ])
    expect(h.cards[0]!.card.body).toContain("[Open in ReadyApp](https://ra/m)")
    h.ga.click(gwCustomId("confirm", "abc1"), AURORA); await h.ga.idle()
    expect(h.edits.at(-1)!.card.body).toContain("Note added\n[Open in ReadyApp](https://ra/t/T1)")
  })
})

describe("confirm and cancel", () => {
  const CONFIRM = gwCustomId("confirm", "abc1"), CANCEL = gwCustomId("cancel", "abc1")
  test("only the owner may press", async () => {
    const h = rig(); await h.propose()
    expect(h.ga.ownedBy(CONFIRM, AURORA)).toBe(true)
    expect(h.ga.ownedBy(CONFIRM, STEPHEN)).toBe(false)
    expect(h.ga.click(CONFIRM, STEPHEN)).toContain("Only the person")
    await h.ga.idle()
    expect(h.ops("confirm").length).toBe(0)
  })
  test("confirm: one call with the idempotency key, then Done with ReadyApp's message", async () => {
    const h = rig(); await h.propose()
    expect(h.ga.click(CONFIRM, AURORA)).toBeUndefined()
    expect(h.ga.click(CONFIRM, AURORA)).toContain("already")
    await h.ga.idle()
    expect(h.ops("confirm").map(c => c.args)).toEqual([[AURORA, "card1", "abc1"]])
    const last = h.edits.at(-1)!.card
    expect(last.body).toContain("✅ Done")
    expect(last.body).toContain("Note added")
    expect(last.buttons).toEqual([])
    expect(h.audits.at(-1)).toMatchObject({ action: "confirm", outcome: "ok", userId: AURORA })
    expect(h.ga.click(CONFIRM, AURORA)).toContain("no longer waiting")
  })
  test("cancel tells ReadyApp, then shows Cancelled", async () => {
    const h = rig(); await h.propose()
    h.ga.click(CANCEL, AURORA); await h.ga.idle()
    expect(h.ops("cancel")[0]!.args).toEqual([AURORA, "card1", "abc1-c"])
    expect(h.edits.at(-1)!.card.body).toContain("Cancelled")
    expect(h.ops("confirm").length).toBe(0)
  })
  test("a refusal at confirm shows ReadyApp's reason", async () => {
    const h = rig({ confirm: () => { throw new GatewayError("card_changed", 409, "The ticket changed after this was proposed.") } })
    await h.propose(); h.ga.click(CONFIRM, AURORA); await h.ga.idle()
    expect(h.edits.at(-1)!.card.body).toContain("❌ Not done. The ticket changed after this was proposed. Nothing was changed.")
  })
  test("no answer at confirm: ask for the status, never confirm again", async () => {
    const h = rig({ confirm: () => { throw new GatewayError("timeout", 0, "ReadyApp didn't answer in time.") }, status: () => ({ status: "done", message: "Note added" }) })
    await h.propose(); h.ga.click(CONFIRM, AURORA); await h.ga.idle()
    expect(h.ops("confirm").length).toBe(1)
    expect(h.edits.at(-1)!.card.body).toContain("✅ Done")
  })
  test("no answer and no status: says so, and does not claim either way", async () => {
    const h = rig({ confirm: () => { throw new GatewayError("idempotency_pending", 409, "x") }, status: () => { throw new GatewayError("timeout", 0, "x") } })
    await h.propose(); h.ga.click(CONFIRM, AURORA); await h.ga.idle()
    expect(h.edits.at(-1)!.card.body).toContain("didn't say whether this went through")
  })
  test("a press after expiry lapses the card without calling ReadyApp", async () => {
    const h = rig(); await h.propose(); h.tick(16 * 60_000)
    expect(h.ga.click(CONFIRM, AURORA)).toContain("lapsed")
    await h.ga.idle()
    expect(h.ops("confirm").length).toBe(0)
    expect(h.edits.at(-1)!.card.body).toContain("not confirmed in time")
  })
})

describe("staying in step with ReadyApp", () => {
  test("poll: a card confirmed in ReadyApp is updated here; an open one is left alone", async () => {
    let status = "pending"
    const h = rig({ status: () => ({ status, message: "Note added" }) }); await h.propose()
    await h.ga.poll()
    expect(h.edits.length).toBe(0)
    status = "done"
    await h.ga.poll()
    expect(h.edits.at(-1)!.card.body).toContain("✅ Done")
    expect(h.ga.openCount()).toBe(0)
  })
  test("poll: a card cancelled in ReadyApp loses its buttons", async () => {
    const h = rig({ status: () => ({ status: "cancelled" }) }); await h.propose(); await h.ga.poll()
    expect(h.edits.at(-1)!.card.buttons).toEqual([])
    expect(h.edits.at(-1)!.card.body).toContain("Cancelled")
  })
  test("webhook event for a known card settles it; an unknown card is ignored", async () => {
    const h = rig(); await h.propose()
    expect(await h.ga.onStatus("nope", "done")).toBe(false)
    expect(await h.ga.onStatus("card1", "expired")).toBe(true)
    expect(h.edits.at(-1)!.card.body).toContain("not confirmed in time")
  })
})

describe("per-agent scope", () => {
  const two = () => ({ version: "v", reads: [{ name: "tickets", description: "Your tickets" }, { name: "deals", description: "Your deals" }], actions: [{ kind: NOTE, description: "Add a note", targetType: "ticket" }, { kind: "deal.note.add", description: "Deal note", targetType: "deal" }, { kind: "deal.stage.set", description: "Stage", targetType: "deal" }] })

  test("scopeAllows: exact, family, star, and a per-person extra on this agent only", () => {
    expect(scopeAllows(undefined, "reads", "anything")).toBe(true)
    expect(scopeAllows({}, "reads", "tickets")).toBe(false)
    expect(scopeAllows({ actions: ["deal.*"] }, "actions", "deal.stage.set")).toBe(true)
    expect(scopeAllows({ actions: ["deal.*"] }, "actions", "dealx.set")).toBe(false)
    expect(scopeAllows({ actions: ["deal.*"] }, "actions", NOTE)).toBe(false)
    expect(scopeAllows({ reads: ["*"] }, "reads", "finance")).toBe(true)
    const s = { reads: ["deals"], users: { [AURORA]: { reads: ["finance"] } } }
    expect(scopeAllows(s, "reads", "finance", AURORA)).toBe(true)
    expect(scopeAllows(s, "reads", "finance", STEPHEN)).toBe(false)
    expect(agentScope(true)).toBeUndefined()
    expect(agentScope(undefined)).toBeNull()
  })

  test("a read outside the agent's list never reaches ReadyApp", async () => {
    const h = rig({ catalog: two })
    const out = await h.ga.read({ agent: "Sales", tool: "tickets", people: [{ userId: AURORA }], scope: { reads: ["deals"] } })
    expect(out).toContain("not one of your tools")
    expect(h.ops("read").length).toBe(0)
    expect(h.audits.at(-1)).toMatchObject({ outcome: "deny", detail: { reason: "not_in_agent_scope" } })
  })

  test("the catalog an agent sees is the person's catalog narrowed to its list", async () => {
    const h = rig({ catalog: two })
    const out = await h.ga.read({ agent: "Sales", tool: "catalog", people: [{ userId: AURORA }], scope: { reads: ["deals"], actions: ["deal.*"] } })
    expect(out).toContain("- deals:")
    expect(out).not.toContain("- tickets:")
    expect(out).toContain("deal.stage.set")
    expect(out).not.toContain(NOTE)
  })

  test("an action outside the agent's list is refused before any proposal", async () => {
    const h = rig({ catalog: two })
    const out = await h.propose({ agent: "Sales", scope: { actions: ["deal.*"] } })
    expect(out).toContain("refused")
    expect(out).not.toContain(`Their actions: ${NOTE}`)
    expect(h.ops("propose").length).toBe(0)
    expect(h.cards.length).toBe(0)
  })

  test("a scope cannot widen what ReadyApp gives the person", async () => {
    const h = rig()   // ReadyApp catalog has only ticket.note.add
    const out = await h.propose({ agent: "Sales", action: "deal.stage.set", scope: { actions: ["*"] } })
    expect(out).toContain("refused")
    expect(h.ops("propose").length).toBe(0)
  })

  test("no scope behaves exactly as before", async () => {
    const h = rig()
    expect(await h.propose()).toContain("proposed")
    expect(h.ops("propose").length).toBe(1)
  })
})
