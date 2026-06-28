// hub/memoryCard.test.ts
import { test, expect } from "bun:test"
import { encodeMemId, parseMemArg, renderListCard, renderDetailCard, renderConfirmCard, type NoteSummary } from "./memoryCard"

test("encodeMemId / parseMemArg round-trip (with and without idx)", () => {
  expect(encodeMemId("view", "m3f", 4)).toBe("mem:view:m3f:4")
  expect(encodeMemId("next", "m3f")).toBe("mem:next:m3f")
  expect(parseMemArg("m3f:4")).toEqual({ corrId: "m3f", idx: 4 })
  expect(parseMemArg("m3f")).toEqual({ corrId: "m3f" })
})

const note = (t: string): NoteSummary => ({ path: `/v/global/${t}.md`, scope: "global", title: t, tags: ["a"], source: "agent:ada", updated: "2026-06-20T00:00:00Z" })

test("renderListCard: a View + Forget button per note, gated by Discord's 25-component cap", () => {
  const notes = [note("one"), note("two")]
  const card = renderListCard(notes, "m1", 0, 3, "global", 5)
  expect(card.title).toContain("global")
  // one field per note
  expect(card.fields!.length).toBe(2)
  // buttons: 2 per note (view+forget) + prev/next on a multi-page set
  const ids = card.buttons.map(b => b.customId)
  expect(ids).toContain("mem:view:m1:0")
  expect(ids).toContain("mem:forget:m1:1")
  expect(ids).toContain("mem:prev:m1")
  expect(ids).toContain("mem:next:m1")
  // never exceed Discord's 25-component limit
  expect(card.buttons.length).toBeLessThanOrEqual(25)
})

test("renderListCard: empty notes → a placeholder, no per-note buttons", () => {
  const card = renderListCard([], "m1", 0, 1, "global", 5)
  expect(card.fields!.length).toBe(1)
  expect(card.fields![0].value).toContain("no notes")
  expect(card.buttons.every(b => !b.customId.startsWith("mem:view"))).toBe(true)
})

test("renderDetailCard shows the body + Forget and Delete-permanently buttons", () => {
  const card = renderDetailCard({ title: "one", scope: "global", tags: ["a"], source: "agent:ada", updated: "x", body: "the body" }, "m1", 0)
  expect(card.body).toContain("the body")
  const ids = card.buttons.map(b => b.customId)
  expect(ids).toContain("mem:forget:m1:0")
  expect(ids).toContain("mem:del:m1:0")
})

test("renderConfirmCard wording + action differ for archive vs permanent delete", () => {
  const f = renderConfirmCard("forget", "one", "m1", 0)
  expect(f.body.toLowerCase()).toContain("archive")
  expect(f.buttons.map(b => b.customId)).toContain("mem:confirm:m1:0")     // archive → confirm
  expect(f.buttons.map(b => b.customId)).toContain("mem:cancel:m1:0")
  const d = renderConfirmCard("del", "one", "m1", 0)
  expect(d.body.toLowerCase()).toContain("permanently")
  expect(d.buttons.map(b => b.customId)).toContain("mem:confirmdel:m1:0")  // delete → confirmdel (kind explicit)
})

test("renderListCard encodes ABSOLUTE note indices (page drift safety)", () => {
  const card = renderListCard([note("x")], "m1", 1, 3, "global", 5)   // page 1, pageSize 5
  const ids = card.buttons.map(b => b.customId)
  expect(ids).toContain("mem:view:m1:5")     // abs = 1*5 + 0
  expect(ids).toContain("mem:forget:m1:5")
})
