// hub/memoryBrowseSessions.test.ts
import { test, expect } from "bun:test"
import { BrowseSessions } from "./memoryBrowseSessions"
import type { NoteSummary } from "./memoryCard"

const note = (t: string): NoteSummary => ({ path: `/v/${t}.md`, scope: "global", title: t, tags: [], source: "x", updated: "y" })

test("create returns a usable corrId and stores the session", () => {
  const s = new BrowseSessions()
  const id = s.create({ chatId: "C1", scopes: ["global"], label: "global", notes: [note("a")], pageSize: 5 })
  expect(typeof id).toBe("string")
  expect(s.get(id)!.notes[0].title).toBe("a")
  expect(s.get(id)!.page).toBe(0)
})

test("corrIds are unique and contain no ':' (so they don't break the customId codec)", () => {
  const s = new BrowseSessions()
  const a = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  const b = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  expect(a).not.toBe(b)
  expect(a.includes(":")).toBe(false)
})

test("setPage updates the page; get on unknown id → undefined", () => {
  const s = new BrowseSessions()
  const id = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  s.setPage(id, 2)
  expect(s.get(id)!.page).toBe(2)
  expect(s.get("nope")).toBeUndefined()
})

test("bounded: oldest sessions evicted past the cap", () => {
  const s = new BrowseSessions(2)
  const a = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  const b = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  const c = s.create({ chatId: "C1", scopes: [], label: "x", notes: [], pageSize: 5 })
  expect(s.get(a)).toBeUndefined()   // evicted
  expect(s.get(b)).toBeDefined()
  expect(s.get(c)).toBeDefined()
})
