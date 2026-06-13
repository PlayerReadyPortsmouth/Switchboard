import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryStore, serializeNote, parseNote, slugTitle } from "../hub/memory/store"

const newStore = () => new MemoryStore(mkdtempSync(join(tmpdir(), "sb-mem-")))

test("slugTitle is filename-safe and bounded", () => {
  expect(slugTitle("SSH tunnel: times out after 30s!")).toBe("ssh-tunnel-times-out-after-30s")
  expect(slugTitle("   ")).toBe("note")
})

test("serialize → parse round-trips front-matter and body", () => {
  const md = serializeNote({
    scope: "agents/deploy", title: 'Quote "x": y', tags: ["infra", "ssh"],
    body: "Body line one.\n[[wikilink]]", source: "distiller",
    created: "2026-06-13T11:00:00.000Z", updated: "2026-06-13T12:00:00.000Z",
  })
  const n = parseNote("/x/y.md", md)
  expect(n.title).toBe('Quote "x": y')
  expect(n.scope).toBe("agents/deploy")
  expect(n.tags).toEqual(["infra", "ssh"])
  expect(n.body).toContain("[[wikilink]]")
  expect(n.source).toBe("distiller")
  expect(n.created).toBe("2026-06-13T11:00:00.000Z")
})

test("parse degrades gracefully with no front-matter", () => {
  const n = parseNote("/x/y.md", "just a body, no front-matter")
  expect(n.scope).toBe("global")
  expect(n.title).toBe("(untitled)")
  expect(n.body).toBe("just a body, no front-matter")
})

test("write creates a scoped file and read returns it", () => {
  const s = newStore()
  const p = s.write("users/123", { title: "Alice likes terse replies", body: "Keep it short.", source: "agent:help" })
  expect(p).toContain(join("users", "123"))
  expect(p.endsWith("alice-likes-terse-replies.md")).toBe(true)
  expect(s.read(p).body).toBe("Keep it short.")
})

test("writing same title upserts (one file, preserved created, bumped updated)", () => {
  const s = newStore()
  const p1 = s.write("global", { title: "Deploy runbook", body: "v1", source: "distiller" })
  const created = s.read(p1).created
  const p2 = s.write("global", { title: "Deploy Runbook", body: "v2", source: "distiller" })
  expect(p2).toBe(p1)                       // same slug ⇒ same file
  const n = s.read(p2)
  expect(n.body).toBe("v2")
  expect(n.created).toBe(created)           // created preserved across upsert
  expect(n.updated >= created).toBe(true)
})

test("list gathers notes across multiple scopes, ignoring non-md", () => {
  const s = newStore()
  s.write("global", { title: "G one", body: "a", source: "x" })
  s.write("agents/deploy", { title: "D one", body: "b", source: "x" })
  const titles = s.list(["global", "agents/deploy", "users/none"]).map((n) => n.title).sort()
  expect(titles).toEqual(["D one", "G one"])
})

test("archive moves a note out of recall and unarchive restores it", () => {
  const s = newStore()
  const p = s.write("global", { title: "Cold note", body: "rarely used", source: "distiller" })
  s.write("global", { title: "Hot note", body: "often used", source: "distiller" })
  const arch = s.archive(p)
  expect(arch).toContain(join("global", "archive"))
  // archived note is excluded from list + allNotes (recall sources)
  expect(s.list(["global"]).map((n) => n.title).sort()).toEqual(["Hot note"])
  expect(s.allNotes().map((n) => n.title).sort()).toEqual(["Hot note"])
  expect(s.read(arch).title).toBe("Cold note")   // still readable on disk
  const back = s.unarchive(arch)
  expect(s.list(["global"]).map((n) => n.title).sort()).toEqual(["Cold note", "Hot note"])
  expect(back).toBe(p)
})
