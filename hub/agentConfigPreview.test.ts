// hub/agentConfigPreview.test.ts
import { test, expect } from "bun:test"
import { AgentConfigPreviewRegistry, agentConfigPreviewMissState } from "./agentConfigPreview"
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
  const p = h.r.create("ada@example.com", "qa", "v1", null, cfg, classification)
  expect(p.id).toBe("prev-1")
  expect(p.actor).toBe("ada@example.com")
  expect(p.agentName).toBe("qa")
  expect(p.beforeVersion).toBe("v1")
  expect(p.before).toBeNull()
  expect(p.after).toEqual(cfg)
  expect(p.expiresAt).toBe(p.createdAt + 1000)
})

test("get returns the stored preview by id, undefined for unknown", () => {
  const h = harness()
  const p = h.r.create("ada@example.com", "qa", "v1", null, cfg, classification)
  expect(h.r.get(p.id)).toBe(p)
  expect(h.r.get("nope")).toBeUndefined()
})

test("consume is single-shot: second consume returns null", () => {
  const h = harness()
  const p = h.r.create("ada@example.com", "qa", "v1", null, cfg, classification)
  expect(h.r.consume(p.id, "ada@example.com", "qa", "v1")).toBe(p)
  expect(h.r.consume(p.id, "ada@example.com", "qa", "v1")).toBeNull()
})

test("consume is bound to actor, agent, and resource version", () => {
  const actorMismatch = harness()
  const actorPreview = actorMismatch.r.create("ada@example.com", "qa", "v1", cfg, cfg, classification)
  expect(actorMismatch.r.consume(actorPreview.id, "mallory@example.com", "qa", "v1")).toBeNull()
  expect(actorMismatch.r.consume(actorPreview.id, "ada@example.com", "qa", "v1")).toBeNull()

  const agentMismatch = harness()
  const agentPreview = agentMismatch.r.create("ada@example.com", "qa", "v1", cfg, cfg, classification)
  expect(agentMismatch.r.consume(agentPreview.id, "ada@example.com", "ops", "v1")).toBeNull()
  expect(agentMismatch.r.consume(agentPreview.id, "ada@example.com", "qa", "v1")).toBeNull()

  const versionMismatch = harness()
  const versionPreview = versionMismatch.r.create("ada@example.com", "qa", "v1", cfg, cfg, classification)
  expect(versionMismatch.r.consume(versionPreview.id, "ada@example.com", "qa", "v2")).toBeNull()
  expect(versionMismatch.r.consume(versionPreview.id, "ada@example.com", "qa", "v1")).toBeNull()
})

test("legacy confirmation reports live-version drift as conflict and consumes the token", () => {
  const h = harness()
  const preview = h.r.create("ada@example.com", "qa", "v1", cfg, cfg, classification)
  const pending = h.r.get(preview.id)
  const consumed = h.r.consume(preview.id, "ada@example.com", "qa", "v2")

  expect(consumed).toBeNull()
  expect(agentConfigPreviewMissState(pending, "ada@example.com", "qa", "v2", 0)).toBe("conflict")
  expect(h.r.consume(preview.id, "ada@example.com", "qa", "v1")).toBeNull()
})

test("legacy confirmation does not expose drift for wrong or expired bindings", () => {
  const h = harness()
  const preview = h.r.create("ada@example.com", "qa", "v1", cfg, cfg, classification)
  expect(agentConfigPreviewMissState(preview, "mallory@example.com", "qa", "v2", 0)).toBe("not_found")
  expect(agentConfigPreviewMissState(preview, "ada@example.com", "ops", "v2", 0)).toBe("not_found")
  expect(agentConfigPreviewMissState(preview, "ada@example.com", "qa", "v2", preview.expiresAt)).toBe("not_found")
  expect(agentConfigPreviewMissState(undefined, "ada@example.com", "qa", "v2", 0)).toBe("not_found")
})

test("consume past expiresAt returns null even if never swept", () => {
  const h = harness(1000)
  const p = h.r.create("ada@example.com", "qa", "v1", null, cfg, classification)
  h.advance(1001)
  expect(h.r.consume(p.id, "ada@example.com", "qa", "v1")).toBeNull()
})

test("sweepExpired removes and returns only expired entries", () => {
  const h = harness(1000)
  const p1 = h.r.create("ada@example.com", "a", "v1", null, cfg, classification)
  h.advance(500)
  const p2 = h.r.create("ada@example.com", "b", "v1", null, cfg, classification)
  h.advance(600)   // p1 (expires at 1000) is now expired, p2 (expires at 1500) is not
  const swept = h.r.sweepExpired()
  expect(swept).toEqual([p1])
  expect(h.r.get(p1.id)).toBeUndefined()
  expect(h.r.get(p2.id)).toBe(p2)
})
