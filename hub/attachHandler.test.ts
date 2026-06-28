// hub/attachHandler.test.ts
import { test, expect } from "bun:test"
import { makeAttachHandler, type AttachDeps } from "./attachHandler"

function spyDeps(over: Partial<AttachDeps> = {}) {
  const sent: any[] = [], notes: any[] = [], audits: any[] = []
  const deps: AttachDeps = {
    enabled: true,
    resolve: () => ({ ok: true, absPath: "/out/ada/report.pdf", filename: "report.pdf", size: 5 }),
    sendFiles: (chatId, paths, caption, filename) => sent.push({ chatId, paths, caption, filename }),
    note: (chatId, text) => notes.push({ chatId, text }),
    audit: (ok, chatId, detail) => audits.push({ ok, chatId, detail }),
    ...over,
  }
  return { deps, sent, notes, audits }
}

test("disabled handler ignores the frame entirely (double-gate)", () => {
  const { deps, sent, audits } = spyDeps({ enabled: false })
  makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf" })
  expect(sent).toEqual([]); expect(audits).toEqual([])
})

test("a valid file is sent and audited ok", () => {
  const { deps, sent, notes, audits } = spyDeps()
  makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf", caption: "done" })
  expect(sent).toEqual([{ chatId: "C1", paths: ["/out/ada/report.pdf"], caption: "done", filename: "report.pdf" }])
  expect(notes).toEqual([])
  expect(audits[0].ok).toBe(true)
})

test("an explicit filename overrides the validator's basename", () => {
  const { deps, sent } = spyDeps()
  makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf", filename: "Weekly.pdf" })
  expect(sent[0].filename).toBe("Weekly.pdf")
})

test("a rejection posts a channel note, audits deny, and sends nothing", () => {
  const { deps, sent, notes, audits } = spyDeps({ resolve: () => ({ ok: false, reason: "escape" }) })
  makeAttachHandler(deps)({ chatId: "C1", path: "../secret" })
  expect(sent).toEqual([])
  expect(notes[0].text).toContain("outside your outbox")
  expect(audits[0]).toMatchObject({ ok: false, chatId: "C1", detail: { reason: "escape" } })
})
