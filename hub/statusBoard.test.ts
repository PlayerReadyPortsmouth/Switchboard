// hub/statusBoard.test.ts
import { test, expect } from "bun:test"
import { agentLine } from "./statusBoard"
import type { AgentStatus } from "./statusRegistry"

const base: AgentStatus = {
  name: "ada", emoji: "🤖", mode: "persistent", alive: true, busy: true,
  queueDepth: 0, fillPct: 0.4, lastActivityMs: 0,
}

test("agentLine shows the current tool when busy", () => {
  expect(agentLine({ ...base, currentTool: "Bash" })).toContain("⚙ Bash")
})

test("agentLine shows a failed last tool when idle", () => {
  expect(agentLine({ ...base, busy: false, currentTool: null, lastTool: { name: "Bash", error: true } }))
    .toContain("⚠ Bash failed")
})

test("agentLine is unchanged when there is no tool info", () => {
  expect(agentLine(base)).not.toContain("⚙")
  expect(agentLine(base)).not.toContain("⚠")
})
