// hub/hubConfigDraft.test.ts
import { test, expect } from "bun:test"
import { classifyHubChange, invalidSafeFieldValue } from "./hubConfigDraft"
import type { HubConfig } from "./types"

const base: HubConfig = {
  botTokenEnv: "DISCORD_TOKEN", guildIds: ["123"], socketPath: "/tmp/sb.sock", stateDir: "/srv/state",
  routerModel: "claude-haiku-4-5", switchThreshold: 0.5, defaultAgent: "qa",
  ephemeralTimeoutMs: 60000, tagStyle: "prefix", chatKeyScope: "channel",
  statusRefreshMs: 15000,
}

test("changing routerModel only classifies as safe", () => {
  const after: HubConfig = { ...base, routerModel: "claude-sonnet-4-6" }
  expect(classifyHubChange(base, after)).toEqual({ tier: "safe", fullRestart: [] })
})

test("changing contextWindows only classifies as safe", () => {
  const after: HubConfig = { ...base, contextWindows: { default: 100000 } }
  expect(classifyHubChange(base, after)).toEqual({ tier: "safe", fullRestart: [] })
})

test("changing a generic unlisted field (statusRefreshMs) classifies as restart, labeled with the field name", () => {
  const after: HubConfig = { ...base, statusRefreshMs: 30000 }
  expect(classifyHubChange(base, after)).toEqual({ tier: "restart", fullRestart: ["statusRefreshMs"] })
})

test("changing a planReload-tracked full-restart field (webPort) classifies as restart, identically to any other unsafe field", () => {
  const after: HubConfig = { ...base, webPort: 9090 }
  expect(classifyHubChange(base, after)).toEqual({ tier: "restart", fullRestart: ["webPort"] })
})

test("a mixed change (one safe field + one unsafe field) classifies as restart, listing only the unsafe field", () => {
  const after: HubConfig = { ...base, routerModel: "claude-sonnet-4-6", defaultAgent: "triage" }
  expect(classifyHubChange(base, after)).toEqual({ tier: "restart", fullRestart: ["defaultAgent"] })
})

test("no change at all classifies as safe with an empty fullRestart", () => {
  expect(classifyHubChange(base, { ...base })).toEqual({ tier: "safe", fullRestart: [] })
})

test("invalidSafeFieldValue rejects an empty-string routerModel change", () => {
  const after: HubConfig = { ...base, routerModel: "" }
  expect(invalidSafeFieldValue(base, after)).toBe("routerModel must be a non-empty string")
})

test("invalidSafeFieldValue rejects a non-array commands change", () => {
  const before: HubConfig = { ...base, commands: [{ match: "!ping", agent: "qa", channelId: "1", message: "ping" }] }
  const after: HubConfig = { ...before, commands: "!reload" as unknown as HubConfig["commands"] }
  expect(invalidSafeFieldValue(before, after)).toBe("commands must be an array")
})

test("invalidSafeFieldValue allows a legitimate routerModel change", () => {
  const after: HubConfig = { ...base, routerModel: "claude-sonnet-4-6" }
  expect(invalidSafeFieldValue(base, after)).toBeNull()
})

test("invalidSafeFieldValue does not flag an already-empty field the operator left unchanged", () => {
  const before: HubConfig = { ...base, routerModel: "" }
  const after: HubConfig = { ...before, defaultAgent: "triage" }
  expect(invalidSafeFieldValue(before, after)).toBeNull()
})
