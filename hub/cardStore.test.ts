import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteCardStore } from "./cardStore"
import { CardRegistry } from "./cardRegistry"
import { NotifyRouter } from "./notifyRouter"
import {
  routeCardInteraction, UNKNOWN_BUTTON_MESSAGE, orphanedAgentMessage, type InteractionTarget,
} from "./cardRouting"
import type { CardSpec } from "./types"

const HOUR = 3_600_000
const TTL = 168 * HOUR   // the shipped default: 7 days

const card = (id: string): CardSpec => ({
  title: "Deploy PR #99",
  body: "Ready to ship?",
  buttons: [
    { customId: `deploy:go:${id}`, label: "Go", style: "success" },
    { customId: `deploy:no:${id}`, label: "Cancel", style: "danger" },
  ],
})

/** One hub lifetime: a store bound to `db`, plus the three registries wired to it.
 *  Dropping the returned object and calling `boot(db)` again with the SAME db is a
 *  simulated hub restart — new objects, empty Maps, same disk. */
function boot(db: Database, now: () => number = Date.now, ttlMs = TTL) {
  const store = new SqliteCardStore(db, ttlMs, now)
  const registry = new CardRegistry(store)
  const router = new NotifyRouter(store)
  const modals = new Map<string, unknown>()
  const restore = () => {
    const all = store.loadAll()
    registry.restore(all.cards)
    router.restore(all.buttons)
    for (const m of all.modals) modals.set(m.customId, m.modal)
    return all
  }
  return { store, registry, router, modals, restore }
}

test("card routing state survives a simulated hub restart", () => {
  const db = new Database(":memory:")

  // --- hub lifetime 1: an agent posts a card ---
  const first = boot(db)
  first.router.register(card("a").buttons.map((b) => b.customId), "triage")
  first.registry.set("corr-a", "chan-1", "msg-1", card("a"))
  expect(first.router.agentFor("deploy:go:a")).toBe("triage")

  // --- restart: every Map is gone, only the DB remains ---
  const second = boot(db)
  expect(second.router.agentFor("deploy:go:a")).toBeUndefined()
  expect(second.registry.get("corr-a")).toBeUndefined()

  second.restore()

  expect(second.router.agentFor("deploy:go:a")).toBe("triage")
  expect(second.registry.correlationFor("deploy:no:a")).toBe("corr-a")
  const loc = second.registry.get("corr-a")
  expect(loc?.chatId).toBe("chan-1")
  expect(loc?.messageId).toBe("msg-1")
  expect(loc?.card.buttons.map((b) => b.label)).toEqual(["Go", "Cancel"])
})

test("modal specs survive a restart, so a modal button still opens its modal", () => {
  const db = new Database(":memory:")
  const modal = {
    title: "Reason", inputs: [{ id: "why", label: "Why?", style: "paragraph" as const, required: true }],
  }

  const first = boot(db)
  first.store.putModal("deploy:no:a", modal)

  const second = boot(db)
  expect(second.modals.get("deploy:no:a")).toBeUndefined()
  second.restore()
  expect(second.modals.get("deploy:no:a")).toEqual(modal)
})

test("an entry past the TTL is not restorable and is swept away", () => {
  const db = new Database(":memory:")
  let clock = 1_000_000_000_000

  const first = boot(db, () => clock)
  first.router.register(["deploy:go:old"], "triage")
  first.registry.set("corr-old", "chan-1", "msg-1", card("old"))

  // 8 days later — past the 7-day retention window.
  clock += 8 * 24 * HOUR

  const second = boot(db, () => clock)
  const loaded = second.restore()
  expect(loaded.cards).toEqual([])
  expect(loaded.buttons).toEqual([])
  expect(second.router.agentFor("deploy:go:old")).toBeUndefined()
  expect(second.registry.get("corr-old")).toBeUndefined()

  // ...and the click reports honestly rather than freezing on "Working".
  expect(routeCardInteraction("deploy:go:old", "u1", undefined, {
    agentFor: (id) => second.router.agentFor(id),
    transportFor: () => undefined,
    persistenceOn: true,
  })).toBe(UNKNOWN_BUTTON_MESSAGE)

  expect(second.store.sweep()).toBeGreaterThan(0)
  expect(second.store.loadAll().cards).toEqual([])
})

test("an entry just inside the TTL still restores", () => {
  const db = new Database(":memory:")
  let clock = 1_000_000_000_000

  boot(db, () => clock).router.register(["deploy:go:fresh"], "triage")
  clock += 6 * 24 * HOUR   // 6 days — inside the 7-day window

  const second = boot(db, () => clock)
  second.restore()
  expect(second.router.agentFor("deploy:go:fresh")).toBe("triage")
})

test("re-writing a card refreshes its retention clock", () => {
  const db = new Database(":memory:")
  let clock = 1_000_000_000_000

  const first = boot(db, () => clock)
  first.registry.set("corr-a", "chan-1", "msg-1", card("a"))
  first.router.register(["deploy:go:a"], "triage")

  // The agent edits the card 6 days later — it is a live card, not a stale one.
  clock += 6 * 24 * HOUR
  first.registry.set("corr-a", "chan-1", "msg-1", card("a"))
  first.router.register(["deploy:go:a"], "triage")

  // Another 6 days on: 12 days since first post, but only 6 since the last write.
  clock += 6 * 24 * HOUR
  const second = boot(db, () => clock)
  second.restore()
  expect(second.registry.get("corr-a")).toBeDefined()
  expect(second.router.agentFor("deploy:go:a")).toBe("triage")
})

test("forgotten buttons are dropped from the store, not resurrected", () => {
  const db = new Database(":memory:")
  const first = boot(db)
  first.router.register(["deploy:go:a", "deploy:no:a"], "triage")
  first.router.forget(["deploy:no:a"])

  const second = boot(db)
  second.restore()
  expect(second.router.agentFor("deploy:go:a")).toBe("triage")
  expect(second.router.agentFor("deploy:no:a")).toBeUndefined()
})

test("an orphaned agent key fails legibly instead of freezing", () => {
  const db = new Database(":memory:")
  const first = boot(db)
  // A one-off spawned worker keyed by jobId posts a card, then the hub restarts —
  // the routing row survives but the transport does not.
  first.router.register(["job:done:xyz"], "job-4417")

  const second = boot(db)
  second.restore()
  expect(second.router.agentFor("job:done:xyz")).toBe("job-4417")

  const reason = routeCardInteraction("job:done:xyz", "u1", undefined, {
    agentFor: (id) => second.router.agentFor(id),
    transportFor: () => undefined,   // agent renamed / removed / worker ended
    persistenceOn: true,
  })
  expect(reason).toBe(orphanedAgentMessage("job-4417"))
  expect(reason).toContain("Nothing ran")
  expect(reason).toContain("job-4417")
})

test("a routable click still delivers and reports no failure", () => {
  const sent: Array<[string, string, Record<string, string> | undefined]> = []
  const target: InteractionTarget = { sendInteraction: (c, u, f) => { sent.push([c, u, f]) } }

  const reason = routeCardInteraction("deploy:go:a", "u1", { why: "ship it" }, {
    agentFor: () => "triage",
    transportFor: () => target,
    persistenceOn: true,
  })
  expect(reason).toBeUndefined()
  expect(sent).toEqual([["deploy:go:a", "u1", { why: "ship it" }]])
})

test("flag off: no store, nothing persisted, and every failure stays a silent no-op", () => {
  const db = new Database(":memory:")

  // Registries constructed exactly as index.ts builds them when the flag is off.
  const registry = new CardRegistry(null)
  const router = new NotifyRouter(null)
  router.register(["deploy:go:a"], "triage")
  registry.set("corr-a", "chan-1", "msg-1", card("a"))

  // In-memory lookups behave exactly as before.
  expect(router.agentFor("deploy:go:a")).toBe("triage")
  expect(registry.correlationFor("deploy:no:a")).toBe("corr-a")
  expect(registry.supersededCustomIds("corr-a", ["deploy:go:a"])).toEqual(["deploy:no:a"])

  // Nothing reached the database — a store opened over the same file sees no rows.
  const store = new SqliteCardStore(db, TTL)
  const all = store.loadAll()
  expect(all).toEqual({ cards: [], buttons: [], modals: [] })

  // ...and both unroutable branches stay silent, as they were pre-fix.
  const deps = { agentFor: () => undefined, transportFor: () => undefined, persistenceOn: false }
  expect(routeCardInteraction("deploy:go:a", "u1", undefined, deps)).toBeUndefined()
  expect(routeCardInteraction("deploy:go:a", "u1", undefined, {
    ...deps, agentFor: () => "gone",
  })).toBeUndefined()
})

test("a malformed persisted card is dropped rather than restored into the hot path", () => {
  const db = new Database(":memory:")
  const store = new SqliteCardStore(db, TTL)
  store.putCard("corr-ok", "c", "m", card("ok"))
  // Corrupt one row the way a bad hand-edit or a truncated write would.
  db.query("UPDATE card_locations SET card_json = ? WHERE correlation_id = ?").run("{not json", "corr-ok")
  db.query("INSERT INTO card_locations(correlation_id, chat_id, message_id, card_json, updated_at) VALUES (?,?,?,?,?)")
    .run("corr-nobuttons", "c", "m", JSON.stringify({ title: "t", body: "b" }), Date.now())

  expect(store.loadAll().cards).toEqual([])
})

test("store failures never throw on the card hot path", () => {
  const db = new Database(":memory:")
  const store = new SqliteCardStore(db, TTL)
  db.close()   // the DB dies underneath a live hub
  const registry = new CardRegistry(store)
  const router = new NotifyRouter(store)

  // The in-memory path must still work; persistence just degrades to today's behaviour.
  expect(() => registry.set("corr-a", "c", "m", card("a"))).not.toThrow()
  expect(() => router.register(["deploy:go:a"], "triage")).not.toThrow()
  expect(() => router.forget(["deploy:go:a"])).not.toThrow()
  expect(() => store.sweep()).not.toThrow()
  expect(store.loadAll()).toEqual({ cards: [], buttons: [], modals: [] })
  expect(registry.get("corr-a")?.chatId).toBe("c")
})
