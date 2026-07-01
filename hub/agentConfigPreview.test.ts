// hub/agentConfigPreview.test.ts
import { test, expect } from "bun:test"
import { AgentConfigPreviewRegistry } from "./agentConfigPreview"
import type { AgentConfig } from "./types"

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new AgentConfigPreviewRegistry(() => now, () => `prev-${++n}`, ttl)
  return { r, at: (v: number) => { now = v }, advance: (d: number) => { now += d } }
}

const cfg: AgentConfig = {
  emoji: "🤖", description: "d", mode: "persistent",
  access: { roles: ["*"] }, runtime: { cwd: "~" },
}
const classification = { tier: "safe" as const, fullRestart: [] }

test("create returns a preview with a generated id and computed expiry", () => {
  const h = harness()
  const p = h.r.create("qa", null, cfg, classification)
  expect(p.id).toBe("prev-1")
  expect(p.agentName).toBe("qa")
  expect(p.before).toBeNull()
  expect(p.after).toEqual(cfg)
  expect(p.expiresAt).toBe(p.createdAt + 1000)
})

test("get returns the stored preview by id, undefined for unknown", () => {
  const h = harness()
  const p = h.r.create("qa", null, cfg, classification)
  expect(h.r.get(p.id)).toBe(p)
  expect(h.r.get("nope")).toBeUndefined()
})

test("consume is single-shot: second consume returns null", () => {
  const h = harness()
  const p = h.r.create("qa", null, cfg, classification)
  expect(h.r.consume(p.id)).toBe(p)
  expect(h.r.consume(p.id)).toBeNull()
})

test("consume past expiresAt returns null even if never swept", () => {
  const h = harness(1000)
  const p = h.r.create("qa", null, cfg, classification)
  h.advance(1001)
  expect(h.r.consume(p.id)).toBeNull()
})

test("sweepExpired removes and returns only expired entries", () => {
  const h = harness(1000)
  const p1 = h.r.create("a", null, cfg, classification)
  h.advance(500)
  const p2 = h.r.create("b", null, cfg, classification)
  h.advance(600)   // p1 (expires at 1000) is now expired, p2 (expires at 1500) is not
  const swept = h.r.sweepExpired()
  expect(swept).toEqual([p1])
  expect(h.r.get(p1.id)).toBeUndefined()
  expect(h.r.get(p2.id)).toBe(p2)
})
