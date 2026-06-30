import { expect, test } from "bun:test"
import { parseTarget, signPeerBody, verifyPeerBody, resolvePeer, PeerDedupe, freshTs, PeerRateLimiter } from "./peering"
import type { PeeringConfig } from "./types"

const cfg: PeeringConfig = {
  selfName: "a", selfBaseUrl: "http://127.0.0.1:1", peers: [
    { name: "hub-b", baseUrl: "http://127.0.0.1:8788", secretEnv: "S" },
  ],
}

test("parseTarget splits peer:agent, rejects malformed", () => {
  expect(parseTarget("hub-b:agent-b")).toEqual({ peer: "hub-b", agent: "agent-b" })
  expect(parseTarget("noColon")).toBeNull()
  expect(parseTarget(":agent-b")).toBeNull()
  expect(parseTarget("peer:")).toBeNull()
})

test("sign/verify roundtrip; reject tampered body and wrong secret", () => {
  const body = JSON.stringify({ hello: "world" })
  const sig = signPeerBody(body, "s3cr3t")
  expect(sig.startsWith("sha256=")).toBe(true)
  expect(verifyPeerBody(body, sig, "s3cr3t")).toBe(true)
  expect(verifyPeerBody(body + "x", sig, "s3cr3t")).toBe(false)
  expect(verifyPeerBody(body, sig, "other")).toBe(false)
})

test("resolvePeer finds by name", () => {
  expect(resolvePeer(cfg, "hub-b")?.baseUrl).toBe("http://127.0.0.1:8788")
  expect(resolvePeer(cfg, "nope")).toBeUndefined()
})

test("PeerDedupe flags repeats inside the window only", () => {
  let t = 1000
  const d = new PeerDedupe(() => t, 500)
  expect(d.seen("c1")).toBe(false)  // first sight
  expect(d.seen("c1")).toBe(true)   // duplicate
  t = 1600                          // past window
  expect(d.seen("c1")).toBe(false)  // pruned → fresh again
})

test("freshTs rejects stale/future beyond skew", () => {
  expect(freshTs(1000, 1000, 100)).toBe(true)
  expect(freshTs(1000, 1201, 100)).toBe(false) // too old
  expect(freshTs(1300, 1000, 100)).toBe(false) // too far future
})

test("PeerRateLimiter caps per peer per minute; 0 = unlimited", () => {
  let t = 0
  const rl = new PeerRateLimiter(() => t, 2)
  expect(rl.ok("p")).toBe(true)
  expect(rl.ok("p")).toBe(true)
  expect(rl.ok("p")).toBe(false)      // 3rd within the minute
  expect(rl.ok("q")).toBe(true)       // other peer independent
  t = 61_000
  expect(rl.ok("p")).toBe(true)       // window rolled
  const off = new PeerRateLimiter(() => 0, 0)
  for (let i = 0; i < 100; i++) expect(off.ok("p")).toBe(true)
})
