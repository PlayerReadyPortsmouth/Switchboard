import { test, expect } from "bun:test"
import { chatKey, decideAgent } from "../hub/bindings"

test("chatKey is per-user in DMs", () => {
  expect(chatKey("user", true, "chan", "u1")).toBe("dm:u1")
})

test("chatKey is per-channel+user in guilds (user scope)", () => {
  expect(chatKey("user", false, "chan", "u1")).toBe("guild:chan:u1")
})

test("chatKey is per-channel in guilds (channel scope)", () => {
  expect(chatKey("channel", false, "chan", "u1")).toBe("guild:chan")
})

test("no current binding → take the router's pick", () => {
  const a = decideAgent({ current: null, permitted: ["research", "qa"],
    decision: { agent: "research", confidence: 0.4, switch: false },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("sticky: stays with current on low-confidence different pick", () => {
  const a = decideAgent({ current: "research", permitted: ["research", "deploy"],
    decision: { agent: "deploy", confidence: 0.5, switch: true },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("auto-switch: switches on high-confidence different pick", () => {
  const a = decideAgent({ current: "research", permitted: ["research", "deploy"],
    decision: { agent: "deploy", confidence: 0.9, switch: true },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("deploy")
})

test("current agent no longer permitted → route fresh", () => {
  const a = decideAgent({ current: "deploy", permitted: ["research", "qa"],
    decision: { agent: "research", confidence: 0.3, switch: false },
    threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("router failed (null) → keep current if still permitted", () => {
  const a = decideAgent({ current: "research", permitted: ["research", "qa"],
    decision: null, threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})

test("router failed and no current → defaultAgent", () => {
  const a = decideAgent({ current: null, permitted: ["research", "qa"],
    decision: null, threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("qa")
})

test("router failed, no current, default not permitted → first permitted", () => {
  const a = decideAgent({ current: null, permitted: ["research"],
    decision: null, threshold: 0.7, defaultAgent: "qa" })
  expect(a).toBe("research")
})
