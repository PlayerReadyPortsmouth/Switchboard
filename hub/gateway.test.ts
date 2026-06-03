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
  expect(row.components.length).toBe(2)
  expect((row.components[0].data as any).custom_id).toBe("action:retry:B-1")
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
