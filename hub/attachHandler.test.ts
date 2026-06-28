// hub/attachHandler.test.ts
import { test, expect } from "bun:test"
import { makeAttachHandler, type AttachDeps } from "./attachHandler"

function spyDeps(over: Partial<AttachDeps> = {}, sendOk = true) {
  const sent: any[] = [], notes: any[] = [], audits: any[] = []
  const deps: AttachDeps = {
    enabled: true,
    resolve: () => ({ ok: true, absPath: "/out/ada/report.pdf", filename: "report.pdf", size: 5, bytes: Buffer.from("hello") }),
    sendFiles: async (chatId, attachments, caption) => { sent.push({ chatId, attachments, caption }); return sendOk },
    note: (chatId, text) => notes.push({ chatId, text }),
    audit: (ok, chatId, detail) => audits.push({ ok, chatId, detail }),
    ...over,
  }
  return { deps, sent, notes, audits }
}

test("disabled handler ignores the frame entirely (double-gate)", async () => {
  const { deps, sent, audits } = spyDeps({ enabled: false })
  await makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf" })
  expect(sent).toEqual([]); expect(audits).toEqual([])
})

test("a valid file is sent and audited ok", async () => {
  const { deps, sent, notes, audits } = spyDeps()
  await makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf", caption: "done" })
  expect(sent[0].attachments[0].name).toBe("report.pdf")
  expect(sent[0].attachments[0].data.toString()).toBe("hello")
  expect(notes).toEqual([])
  expect(audits[0].ok).toBe(true)
})

test("an explicit filename overrides the validator's basename", async () => {
  const { deps, sent } = spyDeps()
  await makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf", filename: "Weekly.pdf" })
  expect(sent[0].attachments[0].name).toBe("Weekly.pdf")
})

test("a rejection posts a channel note, audits deny, and sends nothing", async () => {
  const { deps, sent, notes, audits } = spyDeps({ resolve: () => ({ ok: false, reason: "escape" }) })
  await makeAttachHandler(deps)({ chatId: "C1", path: "../secret" })
  expect(sent).toEqual([])
  expect(notes[0].text).toContain("outside your outbox")
  expect(audits[0]).toMatchObject({ ok: false, chatId: "C1", detail: { reason: "escape" } })
})

test("delivery failure posts a note and audits deny with reason='delivery'", async () => {
  const { deps, notes, audits } = spyDeps({}, false)
  await makeAttachHandler(deps)({ chatId: "C1", path: "report.pdf" })
  expect(notes[0].text).toContain("could not deliver")
  expect(audits[0]).toMatchObject({ ok: false, chatId: "C1", detail: { reason: "delivery" } })
})
