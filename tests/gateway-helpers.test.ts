import { test, expect } from "bun:test"
import { parseControlCommand, renderAgentList } from "../hub/gateway"
import type { AgentRegistry } from "../hub/types"

const reg: AgentRegistry = {
  research: { emoji: "🔬", description: "deep dives", mode: "persistent",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
  qa: { emoji: "💡", description: "quick Q", mode: "ephemeral",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
}

test("parses !switch with an argument", () => {
  expect(parseControlCommand("!switch research")).toEqual({ cmd: "switch", arg: "research" })
})

test("parses bare commands", () => {
  expect(parseControlCommand("!agents")).toEqual({ cmd: "agents", arg: undefined })
  expect(parseControlCommand("!who")).toEqual({ cmd: "who", arg: undefined })
  expect(parseControlCommand("!reset")).toEqual({ cmd: "reset", arg: undefined })
})

test("non-commands return null", () => {
  expect(parseControlCommand("hello there")).toBeNull()
})

test("renderAgentList shows permitted agents and marks the bound one", () => {
  const out = renderAgentList(reg, ["research", "qa"], "qa")
  expect(out).toContain("🔬 research")
  expect(out).toContain("deep dives")
  expect(out).toContain("← current")  // marks the bound agent
})
