import { test, expect } from "bun:test"
import { classifyAgentChange } from "./agentConfigDraft"
import type { AgentConfig, AgentRuntime, HubConfig } from "./types"

const hub = { defaultAgent: "qa" } as HubConfig

const base: AgentConfig = {
  emoji: "🤖", description: "test agent", mode: "persistent",
  access: { roles: ["*"] },
  runtime: { cwd: "~", model: "claude-haiku-4-5" },
}

test("access-only change classifies as safe", () => {
  const after: AgentConfig = { ...base, access: { roles: ["dev"] } }
  expect(classifyAgentChange("a", base, after, hub)).toEqual({ tier: "safe", fullRestart: [] })
})

test("spawn-signature change on a persistent non-pooled agent classifies as hard", () => {
  const after: AgentConfig = { ...base, runtime: { ...base.runtime, model: "claude-sonnet-4-6" } }
  expect(classifyAgentChange("a", base, after, hub)).toEqual({ tier: "hard", fullRestart: [] })
})

test.each<[string, Partial<AgentRuntime>]>([
  ["provider", { provider: "codex" }],
  ["codex sandbox", { codexSandbox: "workspace-write" }],
  ["codex args", { codexArgs: ["--search"] }],
])("a %s change classifies as hard", (_field, runtime) => {
  const after: AgentConfig = { ...base, runtime: { ...base.runtime, ...runtime } }
  expect(classifyAgentChange("a", base, after, hub)).toEqual({ tier: "hard", fullRestart: [] })
})

test("adding a new agent classifies as restart, labeled +agent:<name>", () => {
  const result = classifyAgentChange("a", null, base, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["+agent:a"])
})

test("removing an agent classifies as restart, labeled -agent:<name>", () => {
  const result = classifyAgentChange("a", base, null, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["-agent:a"])
})

test("mode change classifies as restart", () => {
  const after: AgentConfig = { ...base, mode: "ephemeral" }
  const result = classifyAgentChange("a", base, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["agent-mode:a"])
})

test("pooled-agent spawn change classifies as restart, not hard", () => {
  const pooled: AgentConfig = { ...base, runtime: { ...base.runtime, pool: { min: 1, max: 3 } } }
  const after: AgentConfig = { ...pooled, runtime: { ...pooled.runtime, model: "claude-sonnet-4-6" } }
  const result = classifyAgentChange("a", pooled, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["agent-pool:a"])
})

test("an emoji-only change is NOT silently 'safe' — classifies as restart, labeled unapplied:emoji", () => {
  const after: AgentConfig = { ...base, emoji: "🎉" }
  const result = classifyAgentChange("a", base, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["unapplied:emoji"])
})

test("a runtime.pool value change on an otherwise-safe agent is flagged unapplied, not silently dropped", () => {
  const after: AgentConfig = { ...base, runtime: { ...base.runtime, pool: { min: 1, max: 2 } } }
  const result = classifyAgentChange("a", base, after, hub)
  expect(result.tier).toBe("restart")
  expect(result.fullRestart).toEqual(["unapplied:runtime.pool"])
})

test("no change at all classifies as safe with an empty fullRestart", () => {
  expect(classifyAgentChange("a", base, { ...base }, hub)).toEqual({ tier: "safe", fullRestart: [] })
})
