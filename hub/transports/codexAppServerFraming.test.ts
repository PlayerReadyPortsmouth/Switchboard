import { describe, expect, test } from "bun:test"
import {
  buildCodexAppServerArgv,
  codexUsage,
  parseCodexMessage,
  rpcNotification,
  rpcRequest,
} from "./codexAppServerFraming"
import { INTERACTION_GUIDANCE } from "./streamJsonFraming"

describe("Codex app-server JSONL framing", () => {
  test("builds newline-terminated requests and notifications", () => {
    expect(rpcRequest(7, "thread/start", { cwd: "C:\\work" })).toBe(
      '{"id":7,"method":"thread/start","params":{"cwd":"C:\\\\work"}}\n',
    )
    expect(rpcNotification("initialized", {})).toBe('{"method":"initialized","params":{}}\n')
  })

  test("parses responses, errors, requests, and representative notifications", () => {
    expect(parseCodexMessage('{"id":1,"result":{"thread":{"id":"thr-1"}}}')).toEqual({
      kind: "response", id: 1, result: { thread: { id: "thr-1" } },
    })
    expect(parseCodexMessage('{"id":2,"error":{"code":-1,"message":"nope"}}')).toEqual({
      kind: "response", id: 2, error: { code: -1, message: "nope" },
    })
    expect(parseCodexMessage('{"id":3,"method":"item/commandExecution/requestApproval","params":{"command":"rm"}}')).toEqual({
      kind: "request", id: 3, method: "item/commandExecution/requestApproval", params: { command: "rm" },
    })
    for (const [method, params] of [
      ["item/agentMessage/delta", { delta: "hello" }],
      ["item/completed", { item: { type: "agentMessage", text: "hello" } }],
      ["item/started", { item: { type: "mcpToolCall", id: "t1", server: "switchboard-shim", tool: "post_card" } }],
      ["item/completed", { item: { type: "commandExecution", id: "t2", status: "completed" } }],
      ["turn/completed", { turn: { id: "turn-1", status: "completed" } }],
    ] as const) {
      expect(parseCodexMessage(JSON.stringify({ method, params }))).toEqual({ kind: "notification", method, params })
    }
  })

  test("ignores empty, malformed, and structurally irrelevant lines", () => {
    expect(parseCodexMessage(" ")).toBeNull()
    expect(parseCodexMessage("not json")).toBeNull()
    expect(parseCodexMessage('{"id":"one","result":{}}')).toBeNull()
    expect(parseCodexMessage('{"hello":"world"}')).toBeNull()
  })
})

test("maps current or cumulative Codex token usage defensively", () => {
  expect(codexUsage({ tokenUsage: { current: { inputTokens: 12, cachedInputTokens: 5, outputTokens: 3 } } })).toEqual({
    inputTokens: 12, cacheReadTokens: 5, cacheCreationTokens: 0, outputTokens: 3,
  })
  expect(codexUsage({ usage: { total: { input_tokens: 8, cached_input_tokens: 2, output_tokens: 4 } } })).toEqual({
    inputTokens: 8, cacheReadTokens: 2, cacheCreationTokens: 0, outputTokens: 4,
  })
  expect(codexUsage({ tokenUsage: { current: { inputTokens: "bad" } } })).toEqual({
    inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
  })
  expect(codexUsage({ nope: true })).toBeUndefined()
})

test("builds TOML-safe Codex argv with feature gates and user args before app-server", () => {
  const argv = buildCodexAppServerArgv({
    shimPath: 'C:\\switch "board"\\shim.ts',
    socketPath: 'C:\\run\\worker\nnext.sock',
    agentName: 'worker"one',
    appendSystemPrompt: "Agent-specific\ninstructions",
    codexArgs: ["--search"],
    consultEnabled: true,
    receiptsEnabled: true,
  })
  expect(argv).toEqual([
    "-c", `mcp_servers.switchboard-shim.command=${JSON.stringify("bun")}`,
    "-c", `mcp_servers.switchboard-shim.args=${JSON.stringify(["run", 'C:\\switch "board"\\shim.ts'])}`,
    "-c", "mcp_servers.switchboard-shim.required=true",
    "-c", `mcp_servers.switchboard-shim.env.HUB_SOCKET=${JSON.stringify('C:\\run\\worker\nnext.sock')}`,
    "-c", `mcp_servers.switchboard-shim.env.AGENT_NAME=${JSON.stringify('worker"one')}`,
    "-c", `mcp_servers.switchboard-shim.env.CONSULT=${JSON.stringify("1")}`,
    "-c", `mcp_servers.switchboard-shim.env.RECEIPTS=${JSON.stringify("1")}`,
    "-c", `developer_instructions=${JSON.stringify(`${INTERACTION_GUIDANCE}\n\nAgent-specific\ninstructions`)}`,
    "--search",
    "app-server", "--listen", "stdio://",
  ])
  expect(argv.join(" ")).not.toContain("ATTACH_FILES")
})
