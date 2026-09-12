import { test, expect } from "bun:test"
import { buildClaudeArgv } from "./streamJsonFraming"

const base = { mcpConfigPath: "/mcp.json" }

test("no tool limits leaves argv as it was", () => {
  const argv = buildClaudeArgv(base)
  expect(argv).not.toContain("--allowed-tools")
  expect(argv).not.toContain("--disallowed-tools")
})

test("allowedTools is emitted as one comma-joined flag", () => {
  const argv = buildClaudeArgv({ ...base, allowedTools: ["Read", "Grep", "Glob"] })
  const i = argv.indexOf("--allowed-tools")
  expect(i).toBeGreaterThan(-1)
  expect(argv[i + 1]).toBe("Read,Grep,Glob")
})

test("disallowedTools is emitted the same way and both can appear together", () => {
  const argv = buildClaudeArgv({ ...base, allowedTools: ["Read"], disallowedTools: ["Bash", "WebFetch"] })
  expect(argv[argv.indexOf("--allowed-tools") + 1]).toBe("Read")
  expect(argv[argv.indexOf("--disallowed-tools") + 1]).toBe("Bash,WebFetch")
})

test("empty arrays are ignored rather than emitting an empty flag", () => {
  const argv = buildClaudeArgv({ ...base, allowedTools: [], disallowedTools: [] })
  expect(argv).not.toContain("--allowed-tools")
  expect(argv).not.toContain("--disallowed-tools")
})

test("claudeArgs still come last, so an operator can override the generated flags", () => {
  const argv = buildClaudeArgv({ ...base, allowedTools: ["Read"], claudeArgs: ["--allowed-tools", "Read,Bash"] })
  expect(argv.lastIndexOf("--allowed-tools")).toBeGreaterThan(argv.indexOf("--allowed-tools"))
  expect(argv[argv.length - 1]).toBe("Read,Bash")
})

test("tool limits sit after the system prompt so the prompt pairing is never broken", () => {
  const argv = buildClaudeArgv({ ...base, appendSystemPrompt: "hello", allowedTools: ["Read"] })
  expect(argv.indexOf("--allowed-tools")).toBeGreaterThan(argv.indexOf("--append-system-prompt") + 1)
})
