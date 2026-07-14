import { expect, test } from "bun:test"
import { join } from "path"
import { agentProvider, sessionPathFor } from "./provider"

test("legacy runtimes remain Claude-backed and Codex is opt-in", () => {
  expect(agentProvider({ cwd: "C:\\work" })).toBe("claude")
  expect(agentProvider({ cwd: "C:\\work", provider: "claude" })).toBe("claude")
  expect(agentProvider({ cwd: "C:\\work", provider: "codex" })).toBe("codex")
})

test("Claude sessions and Codex threads use distinct files", () => {
  expect(sessionPathFor("C:\\state", "dev", "claude")).toBe(join("C:\\state", "dev.session"))
  expect(sessionPathFor("C:\\state", "dev", "codex")).toBe(join("C:\\state", "dev.codex-thread"))
})
