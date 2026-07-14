import { expect, test } from "bun:test"
import { HeldApprovalRegistry } from "./heldApprovalRegistry"

test("activation is unique and consume is single-shot", () => {
  const held = new HeldApprovalRegistry()
  const fire = async () => ({ outcome: "succeeded" as const })
  held.activate("approval-1", "fingerprint-1", fire)
  expect(() => held.activate("approval-1", "fingerprint-2", fire)).toThrow("held_effect_exists")
  expect(held.consume("approval-1")).toMatchObject({ fingerprint: "fingerprint-1", fire })
  expect(held.consume("approval-1")).toBeNull()
})

test("discard never invokes the closure", () => {
  const held = new HeldApprovalRegistry()
  let calls = 0
  held.activate("approval-1", "fingerprint-1", async () => { calls++; return { outcome: "succeeded" } })
  expect(held.discard("approval-1")).toBe(true)
  expect(held.discard("approval-1")).toBe(false)
  expect(calls).toBe(0)
})

test("has reflects activation, consumption, and discard", async () => {
  const held = new HeldApprovalRegistry()
  const fire = async () => ({ outcome: "succeeded" as const })
  expect(held.has("approval-1")).toBe(false)
  held.activate("approval-1", "fingerprint-1", fire)
  expect(held.has("approval-1")).toBe(true)
  const entry = held.consume("approval-1")
  expect(held.has("approval-1")).toBe(false)
  expect(await entry?.fire("approval-1")).toEqual({ outcome: "succeeded" })
  held.activate("approval-2", "fingerprint-2", fire)
  held.discard("approval-2")
  expect(held.has("approval-2")).toBe(false)
})
