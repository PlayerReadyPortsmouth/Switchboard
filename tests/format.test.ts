import { test, expect } from "bun:test"
import { chunk, formatOutbound } from "../hub/format"
import type { AgentConfig } from "../hub/types"

const research: AgentConfig = {
  emoji: "🔬", description: "", mode: "persistent",
  access: { roles: ["*"] }, runtime: { cwd: "." },
}

test("short text is one chunk", () => {
  expect(chunk("hello", 2000, "length")).toEqual(["hello"])
})

test("long text splits under the limit", () => {
  const parts = chunk("a".repeat(2500), 2000, "length")
  expect(parts.length).toBe(2)
  expect(parts[0].length).toBeLessThanOrEqual(2000)
})

test("newline mode prefers paragraph boundaries", () => {
  const text = "para one".padEnd(1990, ".") + "\n\n" + "para two"
  const parts = chunk(text, 2000, "newline")
  expect(parts[0].endsWith(".")).toBe(true)
  expect(parts[1]).toBe("para two")
})

test("formatOutbound tags only the first chunk", () => {
  const out = formatOutbound("a".repeat(2500), research, "prefix", 2000, "length", "research")
  expect(out[0].startsWith("**🔬 research** · ")).toBe(true)
  expect(out[1].startsWith("**🔬")).toBe(false)
})
