// hub/toolBoard.test.ts
import { test, expect } from "bun:test"
import { renderToolBoard, formatToolLine } from "./toolBoard"
import type { AgentToolUsage } from "./toolUsageRegistry"

test("formatToolLine sorts by count desc and marks errors", () => {
  const a: AgentToolUsage = { agent: "ada", total: 20, tools: {
    Read: { count: 12, errors: 0 }, Bash: { count: 7, errors: 1 }, attach_file: { count: 1, errors: 0 } } }
  expect(formatToolLine(a)).toBe("Read ×12 · Bash ×7 (1✗) · attach_file ×1")
})

test("renderToolBoard makes one field per agent + a title", () => {
  const snap: AgentToolUsage[] = [{ agent: "ada", total: 1, tools: { Read: { count: 1, errors: 0 } } }]
  const card = renderToolBoard(snap)
  expect(card.title).toContain("Tool")
  expect(card.fields!.length).toBe(1)
  expect(card.fields![0].name).toBe("ada")
  expect(card.fields![0].value).toBe("Read ×1")
})

test("renderToolBoard empty → a single placeholder field", () => {
  const card = renderToolBoard([])
  expect(card.fields!.length).toBe(1)
  expect(card.fields![0].value).toContain("no tool activity")
})

test("formatToolLine truncates past the Discord field limit with +N more", () => {
  const tools: Record<string, { count: number; errors: number }> = {}
  for (let i = 0; i < 80; i++) tools[`tool_number_${i}`] = { count: 1, errors: 0 }
  const line = formatToolLine({ agent: "ada", total: 80, tools })
  expect(line.length).toBeLessThanOrEqual(1024)
  expect(line).toContain("more")
})
