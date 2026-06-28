import { test, expect } from "bun:test"
import { buildShimMcpConfig, parseStreamEvent } from "./streamJsonFraming"

test("parseStreamEvent extracts usage from an assistant frame (the live context size)", () => {
  const line = JSON.stringify({ type: "assistant", message: { usage: {
    input_tokens: 7, cache_read_input_tokens: 70, cache_creation_input_tokens: 0, output_tokens: 3 } } })
  expect(parseStreamEvent(line)).toEqual({ kind: "assistant", usage: {
    inputTokens: 7, cacheReadTokens: 70, cacheCreationTokens: 0, outputTokens: 3 } })
})

test("parseStreamEvent: an assistant frame without usage stays a bare assistant event", () => {
  expect(parseStreamEvent(JSON.stringify({ type: "assistant", message: {} }))).toEqual({ kind: "assistant" })
})

const env = (consult: boolean, attach: boolean) =>
  (buildShimMcpConfig("/shim.ts", "/sock", "ada", consult, attach)
    .mcpServers["switchboard-shim"].env) as Record<string, string>

test("buildShimMcpConfig always sets HUB_SOCKET + AGENT_NAME", () => {
  const e = env(false, false)
  expect(e.HUB_SOCKET).toBe("/sock")
  expect(e.AGENT_NAME).toBe("ada")
  expect(e.CONSULT).toBeUndefined()
  expect(e.ATTACH_FILES).toBeUndefined()
})

test("consultEnabled injects CONSULT=1 into the shim MCP env", () => {
  expect(env(true, false).CONSULT).toBe("1")
})

test("attachEnabled injects ATTACH_FILES=1 into the shim MCP env", () => {
  // The shim is launched by Claude as an MCP server and sees ONLY this env block,
  // not the hub's process.env — so the attach_file gate must be injected here.
  expect(env(false, true).ATTACH_FILES).toBe("1")
})

test("both flags can be set together", () => {
  const e = env(true, true)
  expect(e.CONSULT).toBe("1")
  expect(e.ATTACH_FILES).toBe("1")
})
