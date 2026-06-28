// hub/toolUsageRegistry.test.ts
import { test, expect } from "bun:test"
import { ToolUsageRegistry } from "./toolUsageRegistry"

test("counts tool uses per agent and exposes live current tool", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("ada", [{ id: "1", name: "Read" }, { id: "2", name: "Bash" }])
  expect(r.liveFor("ada").current).toBe("Bash")          // last in the batch
  const a = r.forAgent("ada")!
  expect(a.tools.Read.count).toBe(1)
  expect(a.tools.Bash.count).toBe(1)
  expect(a.total).toBe(2)
})

test("a tool_result error is attributed to the right tool and marks live.last", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("ada", [{ id: "1", name: "Bash" }])
  r.recordToolResult([{ id: "1", isError: true }])
  expect(r.forAgent("ada")!.tools.Bash.errors).toBe(1)
  expect(r.liveFor("ada").last).toEqual({ name: "Bash", error: true })
})

test("an unknown tool_result id is ignored", () => {
  const r = new ToolUsageRegistry()
  r.recordToolResult([{ id: "nope", isError: true }])
  expect(r.snapshot()).toEqual([])
})

test("endTurn clears the current tool but keeps last", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("ada", [{ id: "1", name: "Read" }])
  r.endTurn("ada")
  expect(r.liveFor("ada").current).toBeNull()
  expect(r.liveFor("ada").last).toEqual({ name: "Read", error: false })
})

test("snapshot sorts agents by total desc and is JSON-stable", () => {
  const r = new ToolUsageRegistry()
  r.recordToolUse("a", [{ id: "1", name: "Read" }])
  r.recordToolUse("b", [{ id: "2", name: "Read" }, { id: "3", name: "Bash" }])
  expect(r.snapshot().map(s => s.agent)).toEqual(["b", "a"])
})

test("pending id map is bounded (does not leak when results never arrive)", () => {
  const r = new ToolUsageRegistry(100)   // cap 100 for the test
  for (let i = 0; i < 250; i++) r.recordToolUse("ada", [{ id: `k${i}`, name: "Read" }])
  // Only the most recent 100 ids are still attributable.
  r.recordToolResult([{ id: "k0", isError: true }])    // evicted → ignored
  r.recordToolResult([{ id: "k249", isError: true }])  // still present → counted
  expect(r.forAgent("ada")!.tools.Read.errors).toBe(1)
})
