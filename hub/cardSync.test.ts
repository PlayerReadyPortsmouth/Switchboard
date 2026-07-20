import { test, expect } from "bun:test"
import { BUSY_REASON, CardSync, WORKING_BUTTON, workingCard } from "./cardSync"
import type { CardInFlight } from "./conversations/events"
import type { CardSpec } from "./types"

const CARD: CardSpec = {
  title: "Ticket 41", body: "Duplicate invoice",
  buttons: [{ customId: "t:fixnow:41", label: "Fix now" }, { customId: "t:close:41", label: "Close" }],
}

function harness(overrides: { enabled?: boolean; claimTtlMs?: number } = {}) {
  const published: { correlationId: string; chatId: string; card: CardSpec }[] = []
  const inFlight: { correlationId: string; inFlight: CardInFlight | null }[] = []
  const discordEdits: { correlationId: string; card: CardSpec }[] = []
  let clock = 1_000
  let current: CardSpec | undefined = CARD
  const sync = new CardSync({
    enabled: overrides.enabled ?? true,
    ...(overrides.claimTtlMs !== undefined ? { claimTtlMs: overrides.claimTtlMs } : {}),
    now: () => clock,
    publish: (correlationId, chatId, card) => published.push({ correlationId, chatId, card }),
    publishInFlight: (correlationId, value) => inFlight.push({ correlationId, inFlight: value }),
    currentCard: () => current,
    editDiscord: async (correlationId, card) => { discordEdits.push({ correlationId, card }) },
  })
  return {
    sync, published, inFlight, discordEdits,
    tick: (ms: number) => { clock += ms },
    forget: () => { current = undefined },
  }
}

test("workingCard keeps the content and replaces the controls with the one disabled button", () => {
  const working = workingCard(CARD)
  expect(working.title).toBe(CARD.title)
  expect(working.body).toBe(CARD.body)
  expect(working.buttons).toEqual([WORKING_BUTTON])
  expect(WORKING_BUTTON.disabled).toBe(true)
})

test("a Discord click surfaces as in-flight on the web WITHOUT minting a revision", () => {
  const h = harness()
  expect(h.sync.begin("T1", "discord", "t:fixnow:41")).toBe(true)
  h.sync.markInFlight("T1", "discord", "t:fixnow:41")

  expect(h.inFlight).toEqual([{ correlationId: "T1", inFlight: { surface: "discord", customId: "t:fixnow:41", at: 1_000 } }])
  // The point of the design decision: a transient Working state publishes NO content, so no
  // revision is minted and the card's history disclosure stays free of click noise.
  expect(h.published).toEqual([])
  // Discord already swapped its own row inside the interaction ack; re-editing it would be a
  // pointless API round trip against a three-second deadline.
  expect(h.discordEdits).toEqual([])
})

test("a web click marks the Discord card in-flight with the same Working treatment", () => {
  const h = harness()
  expect(h.sync.begin("T1", "web", "t:fixnow:41")).toBe(true)
  h.sync.markInFlight("T1", "web", "t:fixnow:41")

  expect(h.inFlight[0]!.inFlight).toMatchObject({ surface: "web" })
  // This is the direction that did not exist at all: without it Discord keeps offering a live
  // button for an action that is already running.
  expect(h.discordEdits).toHaveLength(1)
  expect(h.discordEdits[0]!.card.buttons).toEqual([WORKING_BUTTON])
  expect(h.discordEdits[0]!.card.title).toBe(CARD.title)
  expect(h.published).toEqual([])
})

test("the second surface to click one card is refused rather than run twice", () => {
  const h = harness()
  expect(h.sync.begin("T1", "discord", "t:fixnow:41")).toBe(true)
  // A web click landing while the Discord one is still running. The store's forward-only
  // revision rule would keep the CONTENT sane, but nothing there stops a second EXECUTION.
  expect(h.sync.begin("T1", "web", "t:close:41")).toBe(false)
  expect(BUSY_REASON).toContain("already")
  // …and the same in reverse.
  const other = harness()
  expect(other.sync.begin("T1", "web", "t:close:41")).toBe(true)
  expect(other.sync.begin("T1", "discord", "t:fixnow:41")).toBe(false)
})

test("claims are per card, so a click on one card never blocks another", () => {
  const h = harness()
  expect(h.sync.begin("T1", "discord", "t:fixnow:41")).toBe(true)
  expect(h.sync.begin("T2", "web", "t:fixnow:42")).toBe(true)
})

test("a button the hub cannot tie to a card is never refused", () => {
  const h = harness()
  expect(h.sync.begin(undefined, "web", "orphan:go:1")).toBe(true)
  expect(h.sync.begin(undefined, "discord", "orphan:go:1")).toBe(true)
  expect(h.inFlight).toEqual([])
})

test("a content revision releases the claim, so the card is clickable again afterwards", () => {
  const h = harness()
  h.sync.begin("T1", "discord", "t:fixnow:41")
  h.sync.publishState("T1", "chan", { ...CARD, body: "Fixed", buttons: [] })

  expect(h.published).toHaveLength(1)
  expect(h.published[0]!.card.body).toBe("Fixed")
  expect(h.sync.claimFor("T1")).toBeUndefined()
  expect(h.sync.begin("T1", "web", "t:close:41")).toBe(true)
})

test("a claim that never reports back expires, rather than wedging the card forever", () => {
  const h = harness({ claimTtlMs: 60_000 })
  expect(h.sync.begin("T1", "discord", "t:fixnow:41")).toBe(true)
  h.tick(59_000)
  expect(h.sync.begin("T1", "web", "t:close:41")).toBe(false)
  h.tick(2_000)
  expect(h.sync.begin("T1", "web", "t:close:41")).toBe(true)
})

test("release gives the card back on both surfaces when the click reached nothing", () => {
  const h = harness()
  h.sync.begin("T1", "web", "t:fixnow:41")
  h.sync.markInFlight("T1", "web", "t:fixnow:41")
  h.sync.release("T1")

  expect(h.inFlight.at(-1)).toEqual({ correlationId: "T1", inFlight: null })
  // The Working row is undone on Discord too — a click that never ran must stay retryable.
  expect(h.discordEdits.at(-1)!.card.buttons).toEqual(CARD.buttons)
  expect(h.sync.begin("T1", "discord", "t:fixnow:41")).toBe(true)
})

test("a card the hub has forgotten is marked in-flight on the web but not edited on Discord", () => {
  const h = harness()
  h.forget()
  h.sync.begin("T1", "web", "t:fixnow:41")
  h.sync.markInFlight("T1", "web", "t:fixnow:41")
  expect(h.inFlight).toHaveLength(1)
  expect(h.discordEdits).toEqual([])
})

test("with hub.webCards off nothing is claimed, published or mirrored", () => {
  const h = harness({ enabled: false })
  expect(h.sync.begin("T1", "discord", "t:fixnow:41")).toBe(true)
  expect(h.sync.begin("T1", "web", "t:close:41")).toBe(true)   // no claim ⇒ no refusal
  h.sync.markInFlight("T1", "web", "t:close:41")
  h.sync.publishState("T1", "chan", CARD)
  h.sync.release("T1")
  expect(h.published).toEqual([])
  expect(h.inFlight).toEqual([])
  expect(h.discordEdits).toEqual([])
})
