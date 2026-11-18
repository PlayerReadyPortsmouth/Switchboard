import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AccessGrantStore, AccessRequests, accessCustomId, parseAccessCustomId } from "./accessRequests"
import type { CardSpec } from "./types"

const AURORA = "186188409499418628"
const STEPHEN = "425368343789305865"
const OTHER = "111111111111111111"
const CHAT = "1521490913413824563"

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "sb-grants-")); dirs.push(d); return join(d, "grants.json") }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe("AccessGrantStore", () => {
  test("a grant is live until it expires", () => {
    let now = 1000
    const s = new AccessGrantStore(tmp(), () => now)
    s.grant({ userId: AURORA, agent: "Susie", grantedBy: STEPHEN, expiresAt: 5000 })
    expect(s.agentsFor(AURORA)).toEqual(["Susie"])
    expect(s.agentsFor(OTHER)).toEqual([])
    now = 5000
    expect(s.agentsFor(AURORA)).toEqual([])
    expect(s.list()).toEqual([])
  })
  test("a permanent grant has no expiry, and a new grant replaces the old one", () => {
    let now = 1000
    const s = new AccessGrantStore(tmp(), () => now)
    s.grant({ userId: AURORA, agent: "Susie", grantedBy: STEPHEN, expiresAt: 2000 })
    s.grant({ userId: AURORA, agent: "Susie", grantedBy: STEPHEN, expiresAt: null })
    now = 9_999_999
    expect(s.agentsFor(AURORA)).toEqual(["Susie"])
    expect(s.list().length).toBe(1)
  })
  test("grants survive a restart, and revoke removes one", () => {
    const p = tmp()
    new AccessGrantStore(p, () => 1000).grant({ userId: AURORA, agent: "Susie", grantedBy: STEPHEN, expiresAt: null })
    const again = new AccessGrantStore(p, () => 2000)
    expect(again.agentsFor(AURORA)).toEqual(["Susie"])
    expect(again.revoke(AURORA, "Susie")).toBe(true)
    expect(again.revoke(AURORA, "Susie")).toBe(false)
    expect(new AccessGrantStore(p, () => 3000).agentsFor(AURORA)).toEqual([])
  })
  test("a corrupt or malformed file grants nothing", () => {
    const p = tmp()
    writeFileSync(p, "{not json")
    expect(new AccessGrantStore(p).agentsFor(AURORA)).toEqual([])
    writeFileSync(p, JSON.stringify([{ userId: AURORA, agent: "Susie" }]))
    expect(new AccessGrantStore(p).agentsFor(AURORA)).toEqual([])
  })
})

describe("access customIds", () => {
  test("round-trip", () => {
    const id = accessCustomId("approveperm", "Susie", AURORA)
    expect(id).toBe(`access:approveperm:Susie~${AURORA}`)
    expect(parseAccessCustomId(id)).toEqual({ action: "approveperm", agent: "Susie", userId: AURORA })
  })
  test("anything else is rejected", () => {
    expect(parseAccessCustomId("deploy:go:42")).toBeNull()
    expect(parseAccessCustomId(`access:grantall:Susie~${AURORA}`)).toBeNull()
    expect(parseAccessCustomId("access:approve:Susie")).toBeNull()
    expect(parseAccessCustomId("access:approve:Susie~notanid")).toBeNull()
  })
})

function harness(owners: string[] = [STEPHEN], options: ConstructorParameters<typeof AccessRequests>[1] = {}) {
  let now = 1_000_000
  let seq = 0
  const cards = new Map<string, { chatId: string; card: CardSpec }>()
  const plain: { chatId: string; text: string }[] = []
  const audit: any[] = []
  const grants = new AccessGrantStore(tmp(), () => now)
  const ar = new AccessRequests({
    sendCard: async (chatId, card) => { const id = `m${++seq}`; cards.set(id, { chatId, card }); return id },
    editCard: async (chatId, id, card) => { cards.set(id, { chatId, card }) },
    sendPlain: async (chatId, text) => { plain.push({ chatId, text }) },
    ownersOf: () => owners,
    agentExists: (a) => a === "Susie",
    agentEmoji: () => "🛠️",
    grants,
    audit: (e) => audit.push(e),
    now: () => now,
  }, options)
  return { ar, cards, plain, audit, grants, advance: (ms: number) => { now += ms } }
}

describe("AccessRequests", () => {
  test("offer posts a card with one button for the refused person", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    const offer = h.cards.get("m1")!
    expect(offer.chatId).toBe(CHAT)
    expect(offer.card.buttons.map(b => b.customId)).toEqual([accessCustomId("request", "Susie", AURORA)])
    expect(offer.card.body).toContain(`<@${AURORA}>`)
  })

  test("the same offer is not repeated inside the cooldown", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    await h.ar.offer(CHAT, AURORA, "Susie")
    expect(h.cards.size).toBe(1)
    h.advance(11 * 60_000)
    await h.ar.offer(CHAT, AURORA, "Susie")
    expect(h.cards.size).toBe(2)
  })

  test("with no owners the card has no button and says so", async () => {
    const h = harness([])
    await h.ar.offer(CHAT, AURORA, "Susie")
    expect(h.cards.get("m1")!.card.buttons).toEqual([])
    expect(h.cards.get("m1")!.card.body).toContain("nobody is set up")
  })

  test("an unknown agent is never offered", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Ghost")
    expect(h.cards.size).toBe(0)
  })

  test("only the refused person can press Request", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    expect(h.ar.click(accessCustomId("request", "Susie", AURORA), OTHER)).toContain("Only the person")
    expect(h.cards.size).toBe(1)
  })

  test("request → approval card to the owners, offer card loses its button, owners are pinged", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    expect(h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA)).toBeUndefined(); await h.ar.idle()
    expect(h.cards.get("m1")!.card.buttons).toEqual([])
    const approval = h.cards.get("m2")!
    expect(approval.card.buttons.map(b => parseAccessCustomId(b.customId)!.action)).toEqual(["approve", "approveperm", "deny"])
    expect(h.plain[0]!.text).toContain(`<@${STEPHEN}>`)
    expect(h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA)).toContain("already been requested")
  })

  test("approval cards go to the configured channel when one is set", async () => {
    const h = harness([STEPHEN], { approvalChannelId: "999999999999" })
    await h.ar.offer(CHAT, AURORA, "Susie")
    h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA); await h.ar.idle()
    expect(h.cards.get("m2")!.chatId).toBe("999999999999")
  })

  test("someone who is not an owner cannot approve, and nothing is granted", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA); await h.ar.idle()
    expect(h.ar.click(accessCustomId("approve", "Susie", AURORA), OTHER)).toContain("owners")
    expect(h.ar.click(accessCustomId("approve", "Susie", AURORA), AURORA)).toContain("owners")
    expect(h.grants.agentsFor(AURORA)).toEqual([])
    expect(h.audit.filter(e => e.detail?.reason === "not_an_owner").length).toBe(2)
  })

  test("an owner cannot approve their own request", async () => {
    const h = harness([STEPHEN, AURORA])
    await h.ar.offer(CHAT, AURORA, "Susie")
    h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA); await h.ar.idle()
    expect(h.ar.click(accessCustomId("approve", "Susie", AURORA), AURORA)).toContain("your own request")
    expect(h.grants.agentsFor(AURORA)).toEqual([])
  })

  test("an owner's approval grants time-limited access and tells the requester", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA); await h.ar.idle()
    expect(h.ar.click(accessCustomId("approve", "Susie", AURORA), STEPHEN)).toBeUndefined(); await h.ar.idle()
    expect(h.grants.agentsFor(AURORA)).toEqual(["Susie"])
    expect(h.cards.get("m2")!.card.buttons).toEqual([])
    expect(h.cards.get("m2")!.card.body).toContain("Approved by")
    expect(h.plain.at(-1)!.text).toContain("for 24 hours")
    h.advance(24 * 3_600_000)
    expect(h.grants.agentsFor(AURORA)).toEqual([])
  })

  test("approve permanently grants with no expiry", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA); await h.ar.idle()
    h.ar.click(accessCustomId("approveperm", "Susie", AURORA), STEPHEN); await h.ar.idle()
    h.advance(365 * 24 * 3_600_000)
    expect(h.grants.agentsFor(AURORA)).toEqual(["Susie"])
  })

  test("deny grants nothing, tells the requester, and closes the request", async () => {
    const h = harness()
    await h.ar.offer(CHAT, AURORA, "Susie")
    h.ar.click(accessCustomId("request", "Susie", AURORA), AURORA); await h.ar.idle()
    expect(h.ar.click(accessCustomId("deny", "Susie", AURORA), STEPHEN)).toBeUndefined(); await h.ar.idle()
    expect(h.grants.agentsFor(AURORA)).toEqual([])
    expect(h.plain.at(-1)!.text).toContain("denied")
    expect(h.ar.click(accessCustomId("approve", "Susie", AURORA), STEPHEN)).toContain("no longer open")
  })

  test("a decision button with no open request does nothing (e.g. after a hub restart)", async () => {
    const h = harness()
    expect(h.ar.click(accessCustomId("approve", "Susie", AURORA), STEPHEN)).toContain("no longer open")
    expect(h.grants.agentsFor(AURORA)).toEqual([])
  })

  test("a forged or unknown button is refused", async () => {
    const h = harness()
    expect(h.ar.click("access:approve:Ghost~" + AURORA, STEPHEN)).toContain("no longer exists")
    expect(h.ar.click("deploy:go:1", STEPHEN)).toContain("not an access request")
  })
})
