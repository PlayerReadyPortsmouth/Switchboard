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

import { test as t2, expect as e2 } from "bun:test"
import { interactionFrame as iframe } from "../hub/transports/streamJsonFraming"

t2("interactionFrame without fields is a plain tagged user message", () => {
  const text = JSON.parse(iframe("deploy:go:42", "u9")).message.content[0].text
  e2(text).toBe("[interaction] custom_id=deploy:go:42 user_id=u9")
})

t2("interactionFrame with fields appends a JSON fields= suffix", () => {
  const text = JSON.parse(iframe("fix:feedback:T1", "u9", { feedback: "make it blue" })).message.content[0].text
  e2(text).toBe('[interaction] custom_id=fix:feedback:T1 user_id=u9 fields={"feedback":"make it blue"}')
})

t2("interactionFrame ignores an empty fields object", () => {
  const text = JSON.parse(iframe("a:b:c", "u", {})).message.content[0].text
  e2(text).toBe("[interaction] custom_id=a:b:c user_id=u")
})

import { test as st, expect as se } from "bun:test"
import { parseStreamEvent as pse, buildClaudeArgv as bca } from "../hub/transports/streamJsonFraming"

st("parseStreamEvent extracts session_id from the init event", () => {
  const ev = pse(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-123", tools: [] }))
  se(ev).toEqual({ kind: "init", sessionId: "sess-123" })
})

st("buildClaudeArgv appends --resume when resumeSessionId is set", () => {
  const argv = bca({ mcpConfigPath: "/m", resumeSessionId: "sess-123" })
  se(argv).toContain("--resume")
  se(argv[argv.indexOf("--resume") + 1]).toBe("sess-123")
})

st("buildClaudeArgv omits --resume when no session", () => {
  se(bca({ mcpConfigPath: "/m" })).not.toContain("--resume")
})
