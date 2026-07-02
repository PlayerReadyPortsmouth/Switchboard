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

import { resolveThreadAgent } from "./channelPin"
import type { ThreadAgentsConfig } from "./types"

const threadedPins: ChannelAgent[] = [
  { channelId: "chanA", agent: "dev-agent", threaded: true, threadWorktreeRepo: "readyapp" },
  { channelId: "chanB", agent: "other" }, // not threaded
]
const cfgOn: ThreadAgentsConfig = { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 }
const cfgOff: ThreadAgentsConfig = { ...cfgOn, enabled: false }

test("resolveThreadAgent returns the agent + threadWorktreeRepo when the parent channel is pinned+threaded and the feature is on", () => {
  expect(resolveThreadAgent("chanA", threadedPins, cfgOn)).toEqual({ agent: "dev-agent", threadWorktreeRepo: "readyapp" })
})
test("resolveThreadAgent returns null when the parent channel isn't threaded", () => {
  expect(resolveThreadAgent("chanB", threadedPins, cfgOn)).toBeNull()
})
test("resolveThreadAgent returns null when hub-wide threadAgents is off, even if the pin is threaded", () => {
  expect(resolveThreadAgent("chanA", threadedPins, cfgOff)).toBeNull()
})
test("resolveThreadAgent returns null when threadCfg is absent", () => {
  expect(resolveThreadAgent("chanA", threadedPins, undefined)).toBeNull()
})
test("resolveThreadAgent returns null when threadParentId is undefined (not a thread message)", () => {
  expect(resolveThreadAgent(undefined, threadedPins, cfgOn)).toBeNull()
})
test("resolveThreadAgent omits threadWorktreeRepo when the pin doesn't set one", () => {
  const pins: ChannelAgent[] = [{ channelId: "chanC", agent: "solo-agent", threaded: true }]
  expect(resolveThreadAgent("chanC", pins, cfgOn)).toEqual({ agent: "solo-agent", threadWorktreeRepo: undefined })
})
