import { test, expect } from "bun:test"
import { HubConfigPreviewRegistry } from "./hubConfigPreview"
import type { HubConfig } from "./types"

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new HubConfigPreviewRegistry(() => now, () => `hubprev-${++n}`, ttl)
  return { r, at: (v: number) => { now = v }, advance: (d: number) => { now += d } }
}

const cfg = (routerModel: string): HubConfig => ({
  botTokenEnv: "DISCORD_TOKEN", guildIds: [], socketPath: "/tmp/x", stateDir: "/srv/x",
  routerModel, switchThreshold: 0.5, defaultAgent: "qa",
  ephemeralTimeoutMs: 60000, tagStyle: "prefix", chatKeyScope: "channel",
})
const classification = { tier: "safe" as const, fullRestart: [] }

test("create returns a preview with a generated id and computed expiry", () => {
  const h = harness()
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  expect(p.id).toBe("hubprev-1")
  expect(p.before).toEqual(cfg("a"))
  expect(p.after).toEqual(cfg("b"))
  expect(p.expiresAt).toBe(p.createdAt + 1000)
})

test("get returns the stored preview by id, undefined for unknown", () => {
  const h = harness()
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  expect(h.r.get(p.id)).toBe(p)
  expect(h.r.get("nope")).toBeUndefined()
})

test("consume is single-shot: second consume returns null", () => {
  const h = harness()
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  expect(h.r.consume(p.id)).toBe(p)
  expect(h.r.consume(p.id)).toBeNull()
})

test("consume past expiresAt returns null even if never swept", () => {
  const h = harness(1000)
  const p = h.r.create(cfg("a"), cfg("b"), classification)
  h.advance(1001)
  expect(h.r.consume(p.id)).toBeNull()
})

test("sweepExpired removes and returns only expired entries", () => {
  const h = harness(1000)
  const p1 = h.r.create(cfg("a"), cfg("b"), classification)
  h.advance(500)
  const p2 = h.r.create(cfg("c"), cfg("d"), classification)
  h.advance(600)   // p1 (expires at 1000) is now expired, p2 (expires at 1500) is not
  const swept = h.r.sweepExpired()
  expect(swept).toEqual([p1])
  expect(h.r.get(p1.id)).toBeUndefined()
  expect(h.r.get(p2.id)).toBe(p2)
})
