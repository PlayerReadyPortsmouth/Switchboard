import { test, expect } from "bun:test"
import { buildAgentArgv } from "../scripts/start-agent"
import type { AgentConfig } from "../hub/types"

const SHIM = "bun run /repo/shim/server.ts"

function cfg(runtime: Partial<AgentConfig["runtime"]>): AgentConfig {
  return {
    emoji: "x", description: "d", mode: "persistent",
    access: { roles: [] },
    runtime: { cwd: "/w", ...runtime },
  }
}

test("base argv connects the shim as the channel command", () => {
  expect(buildAgentArgv(SHIM, cfg({}), [])).toEqual(["--channels", `command:${SHIM}`])
})

test("model is applied", () => {
  expect(buildAgentArgv(SHIM, cfg({ model: "claude-sonnet-4-6" }), [])).toEqual(
    ["--channels", `command:${SHIM}`, "--model", "claude-sonnet-4-6"],
  )
})

test("configured appendSystemPrompt is passed through verbatim (multi-line)", () => {
  const prompt = "You are the triage agent.\n\n## Rules\n- be terse"
  const argv = buildAgentArgv(SHIM, cfg({ appendSystemPrompt: prompt }), [])
  const i = argv.indexOf("--append-system-prompt")
  expect(i).toBeGreaterThan(-1)
  expect(argv[i + 1]).toBe(prompt)
})

test("claudeArgs and passthrough args are appended in order", () => {
  const argv = buildAgentArgv(
    SHIM,
    cfg({ model: "m", claudeArgs: ["--add-dir", "/extra"] }),
    ["--verbose"],
  )
  expect(argv).toEqual([
    "--channels", `command:${SHIM}`, "--model", "m", "--add-dir", "/extra", "--verbose",
  ])
})

test("a missing agent config yields just the channels flag (no crash)", () => {
  expect(buildAgentArgv(SHIM, undefined, [])).toEqual(["--channels", `command:${SHIM}`])
})
