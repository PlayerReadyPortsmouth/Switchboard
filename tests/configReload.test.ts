import { test, expect } from "bun:test"
import { agentSpawnSignature, planReload } from "../hub/configReload"
import type { HubConfig, AgentConfig, AgentRegistry } from "../hub/types"

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    emoji: "🤖", description: "d", mode: "persistent",
    access: { roles: ["*"], consultableBy: [] },
    runtime: { cwd: "/w", model: "opus" },
    ...over,
  }
}
function hub(over: Partial<HubConfig> = {}): HubConfig {
  return { socketPath: "/s.sock", stateDir: "/st", defaultAgent: "a", ...over } as HubConfig
}
const reg = (r: AgentRegistry): AgentRegistry => r

test("agentSpawnSignature is stable across access-only changes", () => {
  const a = agent()
  const b = agent({ access: { roles: ["*"], consultableBy: ["*"] } })
  expect(agentSpawnSignature(a)).toBe(agentSpawnSignature(b))
})

test("agentSpawnSignature changes when model/args/cwd change", () => {
  const base = agent()
  expect(agentSpawnSignature(agent({ runtime: { cwd: "/w", model: "haiku" } }))).not.toBe(agentSpawnSignature(base))
  expect(agentSpawnSignature(agent({ runtime: { cwd: "/w", model: "opus", claudeArgs: ["-x"] } }))).not.toBe(agentSpawnSignature(base))
  expect(agentSpawnSignature(agent({ runtime: { cwd: "/other", model: "opus" } }))).not.toBe(agentSpawnSignature(base))
  expect(agentSpawnSignature(agent({ runtime: { cwd: "/w", model: "opus", provider: "codex" } }))).not.toBe(agentSpawnSignature(base))
  expect(agentSpawnSignature(agent({ runtime: { cwd: "/w", model: "opus", codexSandbox: "workspace-write" } }))).not.toBe(agentSpawnSignature(base))
  expect(agentSpawnSignature(agent({ runtime: { cwd: "/w", model: "opus", codexArgs: ["--search"] } }))).not.toBe(agentSpawnSignature(base))
})

test("access-only change needs no proc restart and no full restart", () => {
  const prev = { hub: hub(), agents: reg({ a: agent() }) }
  const next = { hub: hub(), agents: reg({ a: agent({ access: { roles: ["*"], consultableBy: ["*"] } }) }) }
  const plan = planReload(prev, next)
  expect(plan.restartAgents).toEqual([])
  expect(plan.fullRestart).toEqual([])
})

test("a persistent agent whose model changed needs a hard restart", () => {
  const prev = { hub: hub(), agents: reg({ a: agent() }) }
  const next = { hub: hub(), agents: reg({ a: agent({ runtime: { cwd: "/w", model: "haiku" } }) }) }
  const plan = planReload(prev, next)
  expect(plan.restartAgents).toEqual(["a"])
  expect(plan.fullRestart).toEqual([])
})

test("an ephemeral agent's spawn change never lands in restartAgents", () => {
  const prev = { hub: hub(), agents: reg({ e: agent({ mode: "ephemeral" }) }) }
  const next = { hub: hub(), agents: reg({ e: agent({ mode: "ephemeral", runtime: { cwd: "/w", model: "haiku" } }) }) }
  expect(planReload(prev, next).restartAgents).toEqual([])
})

test("changing an agent's mode needs a full restart", () => {
  const prev = { hub: hub(), agents: reg({ a: agent({ mode: "persistent" }) }) }
  const next = { hub: hub(), agents: reg({ a: agent({ mode: "ephemeral" }) }) }
  const plan = planReload(prev, next)
  expect(plan.restartAgents).toEqual([])
  expect(plan.fullRestart).toEqual(["agent-mode:a"])
})

test("a pooled persistent agent's spawn change needs a full restart, not a hard reload", () => {
  const pooled = agent({ runtime: { cwd: "/w", model: "opus", pool: { min: 1, max: 3 } as any } })
  const changed = agent({ runtime: { cwd: "/w", model: "haiku", pool: { min: 1, max: 3 } as any } })
  const plan = planReload({ hub: hub(), agents: reg({ p: pooled }) }, { hub: hub(), agents: reg({ p: changed }) })
  expect(plan.restartAgents).toEqual([])
  expect(plan.fullRestart).toEqual(["agent-pool:p"])
})

test("adding or removing an agent needs a full restart", () => {
  const prev = { hub: hub(), agents: reg({ a: agent() }) }
  const next = { hub: hub(), agents: reg({ a: agent(), b: agent() }) }
  expect(planReload(prev, next).fullRestart).toEqual(["+agent:b"])
  expect(planReload(next, prev).fullRestart).toEqual(["-agent:b"])
})

test("port / socket / stateDir / defaultAgent changes need a full restart", () => {
  const prev = { hub: hub(), agents: reg({ a: agent() }) }
  const next = { hub: hub({ metricsPort: 9000, defaultAgent: "b" }), agents: reg({ a: agent() }) }
  const plan = planReload(prev, next)
  expect(plan.fullRestart).toContain("metricsPort")
  expect(plan.fullRestart).toContain("defaultAgent")
})
