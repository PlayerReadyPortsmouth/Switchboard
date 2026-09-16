import { test, expect } from "bun:test"
import { isAddressed } from "./addressGate"

test("mention or reply always counts as addressed", () => {
  expect(isAddressed("anything", true, false, [])).toBe(true)
  expect(isAddressed("anything", false, true, ["CFO"])).toBe(true)
})

test("keyword matches whole-word, case-insensitive", () => {
  expect(isAddressed("hey ops can you check", false, false, ["Ops"])).toBe(true)
  expect(isAddressed("OPS!", false, false, ["Ops"])).toBe(true)
  expect(isAddressed("CFO please pull the numbers", false, false, ["CFO"])).toBe(true)
})

test("keyword does not match as a substring of another word", () => {
  expect(isAddressed("the operations team stops here", false, false, ["Ops"])).toBe(false)
})

test("no mention, no reply, no keyword ⇒ not addressed", () => {
  expect(isAddressed("just chatting in the channel", false, false, ["Ops"])).toBe(false)
  expect(isAddressed("just chatting", false, false, [])).toBe(false)
})
