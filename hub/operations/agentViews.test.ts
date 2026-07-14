import { expect, test } from "bun:test"
import type { AgentStatus, OverseerStatus } from "../statusRegistry"
import type { AgentConfig } from "../types"
import { agentConfigVersion, projectAgentViews } from "./agentViews"

const config: AgentConfig = {
  emoji: "🧪",
  description: "Checks releases",
  mode: "persistent",
  access: { roles: ["engineering"] },
  runtime: {
    cwd: "~",
    model: "claude-sonnet-4-5",
    claudeArgs: ["--permission-prompt-tool", "secret-looking-value"],
    appendSystemPrompt: "private operator instructions",
  },
}

const status: AgentStatus = {
  name: "qa",
  emoji: "🧪",
  mode: "persistent",
  alive: true,
  busy: true,
  queueDepth: 2,
  fillPct: 0.4,
  costUsd: 1.25,
  replicas: 2,
  lastActivityMs: 123,
  currentTool: "Bash",
  lastTool: { name: "Read", error: false },
}

test("viewer projections expose operational state and a redacted config", () => {
  const [view] = projectAgentViews({ qa: config }, [status], [], "viewer")

  expect(view).toMatchObject({ name: "qa", status: "busy", queueDepth: 2, contextFill: 0.4 })
  expect(view.config.runtime.cwd).toBe("[redacted]")
  expect(view.config.runtime).not.toHaveProperty("claudeArgs")
  expect(view.config.runtime).not.toHaveProperty("appendSystemPrompt")
  expect(view.permissions).toEqual({ configure: false, reset: false, restart: false, remove: false })
})

test("operator projections retain editable non-secret config without revealing secrets", () => {
  const [view] = projectAgentViews({ qa: config }, [status], [], "operator")

  expect(view.config.runtime.cwd).toBe("~")
  expect(view.config.runtime.claudeArgs).toEqual({ redacted: true, configured: true })
  expect(view.config.runtime.appendSystemPrompt).toEqual({ redacted: true, configured: true })
  expect(view.permissions.configure).toBe(true)
  expect(view.version).toBe(agentConfigVersion(config))
})

test("projections are name-sorted and combine defaults with overseer state", () => {
  const ephemeral: AgentConfig = {
    emoji: "⚡",
    description: "One-shot worker",
    mode: "ephemeral",
    access: { roles: ["*"] },
    runtime: { cwd: "/tmp", model: "fast" },
  }
  const overseer: OverseerStatus = { agent: "qa", goal: "verify", round: 2, max: 4, state: "prodding" }
  const views = projectAgentViews({ qa: config, adhoc: ephemeral }, [status], [overseer], "operator")

  expect(views.map(view => view.name)).toEqual(["adhoc", "qa"])
  expect(views[0]).toMatchObject({ status: "idle", model: "fast", replicas: 1, currentWork: null })
  expect(views[0].permissions).toMatchObject({ reset: false, restart: false })
  expect(views[1].currentWork).toEqual({ goal: "verify", round: 2, max: 4, state: "prodding" })
})

test("an absent persistent runtime is projected offline", () => {
  const [view] = projectAgentViews({ qa: config }, [], [], "operator")

  expect(view).toMatchObject({ status: "offline", queueDepth: 0, contextFill: 0, costUsd: 0 })
  expect(view.currentTool).toBeNull()
  expect(view.lastTool).toBeNull()
})

test("projected editable config does not expose mutable source or shared references", () => {
  const source = structuredClone(config)
  const sourceStatus = structuredClone(status)
  const [view] = projectAgentViews({ qa: source }, [sourceStatus], [], "operator")
  const [secondView] = projectAgentViews({ qa: source }, [sourceStatus], [], "operator")

  view.config.access.roles.push("mutated")
  view.lastTool!.error = true

  expect(source.access.roles).toEqual(["engineering"])
  expect(sourceStatus.lastTool).toEqual({ name: "Read", error: false })
  expect(view.config.runtime.claudeArgs).not.toBe(secondView.config.runtime.claudeArgs)
})

test("pooled agents never advertise single-process reset or restart controls", () => {
  const pooled = structuredClone(config)
  pooled.runtime.pool = { min: 1, max: 3 }
  const view = projectAgentViews({ qa: pooled }, [], [], "operator")[0]!
  expect(view.permissions.reset).toBe(false)
  expect(view.permissions.restart).toBe(false)
})
