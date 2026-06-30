import { test, expect } from "bun:test"
import { buildCardComponents, parseNotifyCustomId } from "./gateway"
import { isDeployAuthorized } from "./deployGate"

test("buildCardComponents maps CardSpec buttons to an embed + action row", () => {
  const { embed, row } = buildCardComponents({
    title: "Build failed", body: "logs…",
    fields: [{ name: "Branch", value: "main" }],
    buttons: [
      { customId: "action:retry:B-1", label: "Retry", style: "success", emoji: "🔧" },
      { customId: "action:dismiss:B-1", label: "Dismiss", style: "danger" },
    ],
  })
  expect(embed.data.title).toBe("Build failed")
  expect(row!.components.length).toBe(2)
  expect((row!.components[0].data as any).custom_id).toBe("action:retry:B-1")
})

test("buildCardComponents survives a malformed card (empty body, no buttons, oversized)", () => {
  // empty body must not throw (Discord rejects an empty description)
  const a = buildCardComponents({ title: "T", body: "", buttons: [] })
  expect(a.embed.data.description).toBeUndefined()
  expect(a.row).toBeUndefined()
  // title + body both empty → a placeholder description, still no row
  const b = buildCardComponents({ title: "", body: "", buttons: [] })
  expect(b.embed.data.description).toBe("(no details)")
  // oversized body is clamped to Discord's 4096 limit
  const c = buildCardComponents({ title: "T", body: "x".repeat(5000), buttons: [] })
  expect(c.embed.data.description!.length).toBe(4096)
})

test("parseNotifyCustomId recognises ns:action:arg ids and ignores perm:", () => {
  expect(parseNotifyCustomId("action:retry:B-1")).toEqual({ ns: "action", action: "retry", arg: "B-1" })
  expect(parseNotifyCustomId("deploy:go:J1")).toEqual({ ns: "deploy", action: "go", arg: "J1" })
  expect(parseNotifyCustomId("perm:allow:abc")).toBeNull()
})

test("gateway deploy gate: isDeployAuthorized unit check", () => {
  // Direct unit test of the isDeployAuthorized function; verifies the
  // authorisation contract consulted by the interactionCreate handler.
  // Note: enforcement that a non-approver deploy:* click does NOT invoke
  // notifyButtonCb is covered by manual integration testing, not this test.
  const approver = "APPROVER_ID"
  const nonApprover = "SOMEONE_ELSE"
  // deploy:go blocked for non-approver
  expect(isDeployAuthorized("deploy:go:J1", nonApprover, approver)).toBe(false)
  // deploy:go passes for approver
  expect(isDeployAuthorized("deploy:go:J1", approver, approver)).toBe(true)
  // non-deploy buttons always pass (not governed by deploy gate)
  expect(isDeployAuthorized("action:resolve:T1", nonApprover, approver)).toBe(true)
  // empty approver = deny all deploy
  expect(isDeployAuthorized("deploy:go:J1", approver, "")).toBe(false)
})

import { test as gt, expect as ge } from "bun:test"
import { buildModal as bm } from "./modal"

gt("buildModal integrates for a feedback button (smoke)", () => {
  const m = bm("fix:feedback:T1", { title: "Feedback", inputs: [{ id: "feedback", label: "Note", style: "paragraph" }] })
  ge(m.data.custom_id).toBe("fix:feedback:T1")
})

import { buildWorkingRow } from "./gateway"

test("buildWorkingRow is a single disabled Working button", () => {
  const row = buildWorkingRow()
  expect(row.components.length).toBe(1)
  const b = row.components[0].data as any
  expect(b.label).toBe("Working")
  expect(b.disabled).toBe(true)
  expect(b.custom_id).toBe("working:noop")
})

import { buildAttachmentFiles } from "./gateway"
import { AttachmentBuilder } from "discord.js"

test("buildAttachmentFiles wraps buffers in named AttachmentBuilders and clamps to 10", () => {
  const one = buildAttachmentFiles([{ data: Buffer.from("hi"), name: "report.pdf" }])
  expect(one.length).toBe(1)
  expect(one[0]).toBeInstanceOf(AttachmentBuilder)
  expect(one[0].name).toBe("report.pdf")
  const many = buildAttachmentFiles(Array.from({ length: 15 }, (_, i) => ({ data: Buffer.from(String(i)), name: `${i}.txt` })))
  expect(many.length).toBe(10)
})
