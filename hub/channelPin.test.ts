import { test, expect } from "bun:test"
import { resolvePinnedAgent, clearReactionAgent } from "./channelPin"
import type { ChannelAgent } from "./types"

const pins: ChannelAgent[] = [
  { channelId: "chanA", agent: "dev-agent", clearReaction: "❌" },
  { channelId: "chanB", agent: "other" },
]

test("resolvePinnedAgent returns the agent for a pinned channel", () => {
  expect(resolvePinnedAgent("chanA", pins)).toBe("dev-agent")
  expect(resolvePinnedAgent("chanB", pins)).toBe("other")
  expect(resolvePinnedAgent("chanZ", pins)).toBeNull()
  expect(resolvePinnedAgent("chanA", [])).toBeNull()
})

test("clearReactionAgent matches channel + emoji, else null", () => {
  expect(clearReactionAgent("chanA", "❌", pins)).toBe("dev-agent")
  expect(clearReactionAgent("chanA", "👍", pins)).toBeNull()
  expect(clearReactionAgent("chanB", "❌", pins)).toBeNull()
  expect(clearReactionAgent("chanZ", "❌", pins)).toBeNull()
})
