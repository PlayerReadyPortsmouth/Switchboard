import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MessageCache } from "../hub/messageCache"

test("ring buffer keeps only the last `cap` messages", () => {
  const c = new MessageCache(3)
  for (let i = 0; i < 6; i++) c.record("chan", { role: "user", text: `m${i}`, ts: i })
  const recent = c.recent("chan")
  expect(recent.map((m) => m.text)).toEqual(["m3", "m4", "m5"])
})

test("recent(n) returns at most n most-recent", () => {
  const c = new MessageCache(10)
  for (let i = 0; i < 5; i++) c.record("chan", { role: "user", text: `m${i}`, ts: i })
  expect(c.recent("chan", 2).map((m) => m.text)).toEqual(["m3", "m4"])
})

test("render labels user vs agent turns and is empty with no history", () => {
  const c = new MessageCache(10)
  expect(c.render("empty")).toBe("")
  c.record("chan", { role: "user", text: "hello", ts: 1, user: "alice" })
  c.record("chan", { role: "agent", text: "hi there", ts: 2, agent: "research" })
  const r = c.render("chan")
  expect(r).toContain("Recent conversation:")
  expect(r).toContain("[alice] hello")
  expect(r).toContain("[research] hi there")
})

test("render collapses whitespace and truncates long text", () => {
  const c = new MessageCache(10)
  c.record("chan", { role: "user", text: "a\n\n  b   c", ts: 1, user: "u" })
  expect(c.render("chan")).toContain("[u] a b c")
  c.record("chan", { role: "user", text: "x".repeat(400), ts: 2, user: "u" })
  expect(c.render("chan")).toContain("…")
})

test("persists to JSONL and reloads in a fresh instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cache-"))
  const a = new MessageCache(5, dir)
  a.record("guild_123", { role: "user", text: "first", ts: 1, user: "u", userId: "9" })
  a.record("guild_123", { role: "agent", text: "second", ts: 2, agent: "qa" })
  // file is written (slug replaces non-filename chars)
  const raw = readFileSync(join(dir, "guild_123.jsonl"), "utf8").trim()
  expect(raw.split("\n").length).toBe(2)
  // a fresh instance reads it back
  const b = new MessageCache(5, dir)
  expect(b.recent("guild_123").map((m) => m.text)).toEqual(["first", "second"])
})
