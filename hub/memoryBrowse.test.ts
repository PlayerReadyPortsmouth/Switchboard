// hub/memoryBrowse.test.ts
import { test, expect } from "bun:test"
import { MemoryBrowse, type MemoryBrowseDeps } from "./memoryBrowse"
import type { NoteSummary } from "./memoryCard"

const note = (t: string): NoteSummary => ({ path: `/v/${t}.md`, scope: "global", title: t, tags: [], source: "x", updated: "y" })

function deps(over: Partial<MemoryBrowseDeps> = {}) {
  const calls: any = { archive: [], remove: [], deindex: [], audit: [] }
  const d: MemoryBrowseDeps = {
    list: () => [note("a"), note("b")],
    readBody: () => "body",
    exists: () => true,
    archive: (p) => { calls.archive.push(p); return true },
    remove: (p) => calls.remove.push(p),
    deindex: (p) => calls.deindex.push(p),
    audit: (action, actor, detail) => calls.audit.push({ action, actor, detail }),
    ...over,
  }
  return { d, calls }
}

test("forget archives + de-indexes + audits memory_forget", () => {
  const { d, calls } = deps()
  const r = new MemoryBrowse(d).forget({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r.ok).toBe(true)
  expect(calls.archive).toEqual(["/v/a.md"])
  expect(calls.deindex).toEqual(["/v/a.md"])
  expect(calls.remove).toEqual([])
  expect(calls.audit[0]).toMatchObject({ action: "memory_forget", actor: "u1", detail: { title: "a", scope: "global" } })
})

test("remove hard-deletes + de-indexes + audits memory_delete", () => {
  const { d, calls } = deps()
  const r = new MemoryBrowse(d).remove({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r.ok).toBe(true)
  expect(calls.remove).toEqual(["/v/a.md"])
  expect(calls.deindex).toEqual(["/v/a.md"])
  expect(calls.audit[0]).toMatchObject({ action: "memory_delete", actor: "u1" })
})

test("forget on a missing note → {ok:false} and does nothing", () => {
  const { d, calls } = deps({ exists: () => false })
  const r = new MemoryBrowse(d).forget({ path: "/v/gone.md", title: "g", scope: "global" }, "u1")
  expect(r).toEqual({ ok: false, reason: "missing" })
  expect(calls.archive).toEqual([])
  expect(calls.audit).toEqual([])
})

test("a de-index failure still archives + audits (de-index is best-effort)", () => {
  const { d, calls } = deps({ deindex: () => { throw new Error("qdrant down") } })
  const r = new MemoryBrowse(d).forget({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r.ok).toBe(true)
  expect(calls.archive).toEqual(["/v/a.md"])
  expect(calls.audit.length).toBe(1)
})

test("forget with archive failure → {ok:false, reason:'archive_failed'}, no de-index or audit", () => {
  const { d, calls } = deps({ archive: () => false })
  const r = new MemoryBrowse(d).forget({ path: "/v/a.md", title: "a", scope: "global" }, "u1")
  expect(r).toEqual({ ok: false, reason: "archive_failed" })
  expect(calls.deindex).toEqual([])
  expect(calls.audit).toEqual([])
})

test("list passes through the deps", () => {
  const { d } = deps()
  expect(new MemoryBrowse(d).list(["global"]).map(n => n.title)).toEqual(["a", "b"])
})
