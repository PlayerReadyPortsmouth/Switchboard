import { test, expect } from "bun:test"
import { parseUsageObj, blendUsage, contextTokens, fillPct } from "./usage"
import type { TurnUsage } from "./types"

test("parseUsageObj reads token counts from a raw usage object", () => {
  expect(parseUsageObj({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 }))
    .toEqual({ inputTokens: 10, cacheReadTokens: 100, cacheCreationTokens: 5, outputTokens: 20 })
  expect(parseUsageObj(undefined)).toBeUndefined()
  expect(parseUsageObj("nope")).toBeUndefined()
})

test("blendUsage takes context fields from the assistant call, cost from the result", () => {
  const ctx: TurnUsage = { inputTokens: 4000, cacheReadTokens: 400_000, cacheCreationTokens: 0, outputTokens: 50 }
  const cost: TurnUsage = { inputTokens: 9000, cacheReadTokens: 2_700_000, cacheCreationTokens: 0, outputTokens: 9999, costUsd: 1.23, numTurns: 12, durationMs: 5000 }
  const b = blendUsage(ctx, cost)!
  expect(contextTokens(b)).toBe(404_000)   // live prompt size, NOT the cumulative 2.7M
  expect(b.costUsd).toBe(1.23)             // cost stays cumulative
  expect(b.numTurns).toBe(12)
})

test("the 270% bug: fill must come from the live prompt, not cumulative turn usage", () => {
  // A tool/sub-agent-heavy turn: result.usage sums every internal call → 2.7M cache_read.
  const cumulative: TurnUsage = { inputTokens: 0, cacheReadTokens: 2_700_000, cacheCreationTokens: 0, outputTokens: 0 }
  const lastCall: TurnUsage = { inputTokens: 0, cacheReadTokens: 400_000, cacheCreationTokens: 0, outputTokens: 0 }
  const windows = { "claude-opus-4-8": 1_000_000 }
  // Old (buggy) behaviour: cumulative / 1M = 270%
  expect(Math.round(fillPct(cumulative, "claude-opus-4-8", windows) * 100)).toBe(270)
  // Fixed: blended fill uses the final call's context = 40%
  const blended = blendUsage(lastCall, cumulative)!
  expect(Math.round(fillPct(blended, "claude-opus-4-8", windows) * 100)).toBe(40)
})

test("blendUsage falls back when one side is absent", () => {
  const only: TurnUsage = { inputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3, outputTokens: 4, costUsd: 0.5 }
  expect(blendUsage(only, undefined)).toEqual(only)
  expect(blendUsage(undefined, only)).toEqual(only)
  expect(blendUsage(undefined, undefined)).toBeUndefined()
})
