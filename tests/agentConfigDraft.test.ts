import { test, expect } from "bun:test"
import { invalidAgentConfigShape } from "../hub/agentConfigDraft"
import type { AgentConfig } from "../hub/types"

const valid = (): AgentConfig => ({
  emoji: "🤖", description: "qa", mode: "persistent",
  access: {} as AgentConfig["access"],
  runtime: { cwd: "~/agents/qa" },
})

test("invalidAgentConfigShape: accepts a well-formed persistent/ephemeral config", () => {
  expect(invalidAgentConfigShape(valid())).toBeNull()
  expect(invalidAgentConfigShape({ ...valid(), mode: "ephemeral" })).toBeNull()
})

test("invalidAgentConfigShape: rejects a bad mode", () => {
  const cfg = { ...valid(), mode: "bogus" as AgentConfig["mode"] }
  expect(invalidAgentConfigShape(cfg)).toMatch(/mode/)
})

test("invalidAgentConfigShape: rejects a missing runtime.cwd", () => {
  const cfg = { ...valid(), runtime: {} as AgentConfig["runtime"] }
  expect(invalidAgentConfigShape(cfg)).toMatch(/runtime\.cwd/)
})

test("invalidAgentConfigShape: rejects a non-string runtime.cwd", () => {
  const cfg = { ...valid(), runtime: { cwd: 123 as unknown as string } }
  expect(invalidAgentConfigShape(cfg)).toMatch(/runtime\.cwd/)
})
