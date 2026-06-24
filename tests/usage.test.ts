import { test, expect } from "bun:test"
import {
  parseUsage, contextTokens, contextWindow, fillPct, DEFAULT_CONTEXT_WINDOW,
} from "../hub/usage"
import { parseStreamEvent } from "../hub/transports/streamJsonFraming"

const resultEvent = {
  type: "result", subtype: "success", result: "done",
  num_turns: 7, duration_ms: 1234, total_cost_usd: 0.0456,
  usage: {
    input_tokens: 1200, cache_read_input_tokens: 90000,
    cache_creation_input_tokens: 800, output_tokens: 350,
  },
}

test("parseUsage extracts token + turn + cost fields", () => {
  expect(parseUsage(resultEvent)).toEqual({
    inputTokens: 1200, cacheReadTokens: 90000, cacheCreationTokens: 800,
    outputTokens: 350, numTurns: 7, durationMs: 1234, costUsd: 0.0456,
  })
})

test("parseUsage returns undefined when there is no usage object", () => {
  expect(parseUsage({ type: "result", result: "hi" })).toBeUndefined()
  expect(parseUsage({ type: "result", result: "hi", usage: null })).toBeUndefined()
  expect(parseUsage(undefined)).toBeUndefined()
})

test("parseUsage is defensive about missing/odd fields", () => {
  const u = parseUsage({ usage: { input_tokens: 10, output_tokens: "nope" } })
  expect(u).toEqual({
    inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
    numTurns: undefined, durationMs: undefined, costUsd: undefined,
  })
})

test("contextTokens sums fresh + cache-read + cache-creation prompt tokens", () => {
  expect(contextTokens(parseUsage(resultEvent)!)).toBe(1200 + 90000 + 800)
})

test("contextWindow resolves model override, then default entry, then hard default", () => {
  const windows = { "claude-opus-4-8": 200000, default: 150000 }
  expect(contextWindow("claude-opus-4-8", windows)).toBe(200000)
  expect(contextWindow("unknown-model", windows)).toBe(150000)
  expect(contextWindow("anything", undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
  expect(contextWindow(undefined, undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
})

test("fillPct divides context tokens by the resolved window", () => {
  const u = parseUsage(resultEvent)! // 92000 context tokens
  expect(fillPct(u, "m", { default: 200000 })).toBeCloseTo(0.46, 5)
  expect(fillPct(u, "m", { default: 0 })).toBe(0) // guard against /0
})

test("parseStreamEvent attaches usage to a result event when present", () => {
  const ev = parseStreamEvent(JSON.stringify(resultEvent))
  expect(ev?.kind).toBe("result")
  expect((ev as any).text).toBe("done")
  expect((ev as any).usage.cacheReadTokens).toBe(90000)
})

test("parseStreamEvent omits usage entirely when the result has none", () => {
  const ev = parseStreamEvent(JSON.stringify({ type: "result", result: "plain" }))
  expect(ev).toEqual({ kind: "result", text: "plain" })
})
