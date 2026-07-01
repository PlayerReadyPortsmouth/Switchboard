import { test, expect } from "bun:test"
import { escalatedRuntime, countErrors, RateCap } from "../hub/escalation"
import type { AgentRuntime } from "../hub/types"

const base: AgentRuntime = { cwd: "/w", model: "sonnet", claudeArgs: ["--foo"], resumable: true, useMemory: true, injectContext: "always" }

test("escalatedRuntime swaps in the escalation model and appends its args", () => {
  const r = escalatedRuntime(base, { model: "opus", claudeArgs: ["--think-hard"] })
  expect(r.model).toBe("opus")
  expect(r.claudeArgs).toEqual(["--foo", "--think-hard"])
})

test("escalatedRuntime keeps the base model when no override is given", () => {
  expect(escalatedRuntime(base, {}).model).toBe("sonnet")
  expect(escalatedRuntime(base, {}).claudeArgs).toEqual(["--foo"])
})

test("escalatedRuntime forces a clean, non-resumable, context-free run", () => {
  const r = escalatedRuntime(base, { model: "opus" })
  expect(r.resumable).toBe(false)
  expect(r.useMemory).toBe(false)
  expect(r.injectContext).toBeUndefined()
  expect(r.cwd).toBe("/w")   // preserved
})

test("countErrors counts only isError results", () => {
  expect(countErrors([{ isError: true }, { isError: false }, { isError: true }])).toBe(2)
  expect(countErrors([])).toBe(0)
})

test("RateCap allows up to max within the window, then blocks", () => {
  let t = 0
  const cap = new RateCap(() => t, 2, 1000)
  expect(cap.tryTake()).toBe(true)
  expect(cap.tryTake()).toBe(true)
  expect(cap.tryTake()).toBe(false)   // 3rd within window
})

test("RateCap frees a slot once the window rolls past", () => {
  let t = 0
  const cap = new RateCap(() => t, 1, 1000)
  expect(cap.tryTake()).toBe(true)
  t = 500; expect(cap.tryTake()).toBe(false)
  t = 1001; expect(cap.tryTake()).toBe(true)
})

test("RateCap with max<=0 never allows", () => {
  const cap = new RateCap(() => 0, 0)
  expect(cap.tryTake()).toBe(false)
})
