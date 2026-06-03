import { test, expect } from "bun:test"
import {
  parseStreamEvent, userMessageFrame, interactionFrame,
  buildClaudeArgv, buildShimMcpConfig,
} from "../hub/transports/streamJsonFraming"

test("parseStreamEvent extracts a result reply", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", result: "hello" })
  expect(parseStreamEvent(line)).toEqual({ kind: "result", text: "hello" })
})

test("parseStreamEvent tags assistant turns and ignores other/noise", () => {
  expect(parseStreamEvent(JSON.stringify({ type: "assistant" }))).toEqual({ kind: "assistant" })
  expect(parseStreamEvent(JSON.stringify({ type: "system", subtype: "x" }))).toBeNull()
  expect(parseStreamEvent("not json")).toBeNull()
  expect(parseStreamEvent("")).toBeNull()
})

test("userMessageFrame produces a single-line stream-json user message", () => {
  const s = userMessageFrame("ping")
  expect(s.endsWith("\n")).toBe(true)
  expect(JSON.parse(s)).toEqual({
    type: "user", message: { role: "user", content: [{ type: "text", text: "ping" }] },
  })
})

test("interactionFrame embeds custom_id and user_id as a tagged user message", () => {
  const parsed = JSON.parse(interactionFrame("deploy:go:job-1", "u9"))
  const text = parsed.message.content[0].text
  expect(text).toContain("[interaction]")
  expect(text).toContain("custom_id=deploy:go:job-1")
  expect(text).toContain("user_id=u9")
})

test("buildClaudeArgv assembles the proven flags", () => {
  const argv = buildClaudeArgv({
    mcpConfigPath: "/tmp/m.json", model: "claude-haiku-4-5",
    appendSystemPrompt: "be terse", claudeArgs: ["--add-dir", "/x"],
  })
  expect(argv.slice(0, 6)).toEqual([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  ])
  expect(argv).toContain("--mcp-config"); expect(argv).toContain("/tmp/m.json")
  expect(argv).toContain("--strict-mcp-config")
  expect(argv).toContain("--dangerously-skip-permissions")
  expect(argv).toContain("--model"); expect(argv).toContain("claude-haiku-4-5")
  expect(argv).toContain("--append-system-prompt"); expect(argv).toContain("be terse")
  expect(argv.slice(-2)).toEqual(["--add-dir", "/x"])
})

test("buildClaudeArgv omits optional flags when absent", () => {
  const argv = buildClaudeArgv({ mcpConfigPath: "/tmp/m.json" })
  expect(argv).not.toContain("--model")
  expect(argv).not.toContain("--append-system-prompt")
})

test("buildShimMcpConfig registers the shim with its env", () => {
  const cfg = buildShimMcpConfig("/repo/shim/server.ts", "/run/a.sock", "worker")
  expect(cfg).toEqual({
    mcpServers: {
      "switchboard-shim": {
        command: "bun", args: ["run", "/repo/shim/server.ts"],
        env: { HUB_SOCKET: "/run/a.sock", AGENT_NAME: "worker" },
      },
    },
  })
})
