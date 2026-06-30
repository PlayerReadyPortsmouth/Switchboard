#!/usr/bin/env bun
// Loopback smoke check for the cross-VPS peering subsystem.
// Usage: bun run scripts/smoke-peer.ts   → expect "peer smoke OK"
// This is a manual check, NOT part of `bun test`.

import { signPeerBody, parseTarget, resolvePeer, PeerDedupe, PeerRateLimiter } from "../hub/peering"
import type { PeerEnvelope } from "../hub/peering"
import { postPeer } from "../hub/peerClient"
import { handlePeerRequest } from "../hub/peerRoutes"
import type { PeerRouteDeps } from "../hub/peerRoutes"
import type { PeeringConfig } from "../hub/types"

const SHARED_SECRET = "test-secret"
const PORT_A = 8787
const PORT_B = 8788
const LISTEN_PATH = "/peer"

// --- Hub A config (the caller) ---
const cfgA: PeeringConfig = {
  selfName: "hub-a",
  selfBaseUrl: `http://127.0.0.1:${PORT_A}`,
  listenPath: LISTEN_PATH,
  maxClockSkewMs: 120000,
  peers: [{ name: "hub-b", baseUrl: `http://127.0.0.1:${PORT_B}`, secretEnv: "PEER_HUB_B_SECRET" }],
}

// --- Hub B config (the target) ---
const cfgB: PeeringConfig = {
  selfName: "hub-b",
  selfBaseUrl: `http://127.0.0.1:${PORT_B}`,
  listenPath: LISTEN_PATH,
  maxClockSkewMs: 120000,
  peers: [{ name: "hub-a", baseUrl: `http://127.0.0.1:${PORT_A}`, secretEnv: "PEER_HUB_A_SECRET" }],
}

// --- Shared secret lookup (both hubs know the same test-secret for each other) ---
const secretFor = (_name: string): string => SHARED_SECRET

// --- Hub B callbacks ---
let notifyFired: PeerEnvelope | null = null
let askFired: PeerEnvelope | null = null
let replyFiredOnA: PeerEnvelope | null = null

const dedupeB = new PeerDedupe(() => Date.now(), 600000)
const rlB = new PeerRateLimiter(() => Date.now(), 0)  // 0 = unlimited

const depsB: PeerRouteDeps = {
  cfg: cfgB,
  secretFor,
  dedupe: dedupeB,
  now: () => Date.now(),
  rateOk: (peer) => rlB.ok(peer),
  onRejected: (peer, reason) => { console.error(`[hub-b] rejected from ${peer}: ${reason}`) },
  onNotify: (e) => { notifyFired = e },
  onAsk: async (e) => {
    // Fake agent on hub-b produces a reply and POSTs it back to hub-a's /peer/reply
    askFired = e
    if (!e.replyTo) return
    const replyEnv: PeerEnvelope = {
      from: "hub-b:fake-agent",
      to: e.from,
      corrId: e.corrId,
      kind: "reply",
      text: "pong from hub-b",
      ts: Date.now(),
    }
    const raw = JSON.stringify(replyEnv)
    const sig = signPeerBody(raw, SHARED_SECRET)
    await fetch(e.replyTo, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Switchboard-Peer": "hub-b",
        "X-Switchboard-Signature": sig,
      },
      body: raw,
    })
  },
  onReply: (_e) => { /* hub-b doesn't expect replies in this smoke */ },
}

// --- Hub A callbacks (receives the reply from hub-b) ---
let resolveReply: ((e: PeerEnvelope) => void) | null = null
const replyPromise = new Promise<PeerEnvelope>((res) => { resolveReply = res })

const dedupeA = new PeerDedupe(() => Date.now(), 600000)
const rlA = new PeerRateLimiter(() => Date.now(), 0)

const depsA: PeerRouteDeps = {
  cfg: cfgA,
  secretFor,
  dedupe: dedupeA,
  now: () => Date.now(),
  rateOk: (peer) => rlA.ok(peer),
  onRejected: (peer, reason) => { console.error(`[hub-a] rejected from ${peer}: ${reason}`) },
  onNotify: (_e) => {},
  onAsk: (_e) => {},
  onReply: (e) => {
    replyFiredOnA = e
    resolveReply?.(e)
  },
}

// --- Stand up two loopback servers ---
const serverB = Bun.serve({
  port: PORT_B,
  hostname: "127.0.0.1",
  fetch: (req) => handlePeerRequest(req, depsB),
})

const serverA = Bun.serve({
  port: PORT_A,
  hostname: "127.0.0.1",
  fetch: (req) => handlePeerRequest(req, depsA),
})

// Give servers a tick to bind
await new Promise((r) => setTimeout(r, 20))

let exitCode = 0

try {
  // --- Smoke 1: notify A → B ---
  const defB = resolvePeer(cfgA, "hub-b")!
  const notifyEnv: PeerEnvelope = {
    from: "hub-a:test-agent",
    to: "hub-b:fake-agent",
    corrId: `corr-notify-${Date.now()}`,
    kind: "notify",
    text: "hello from hub-a",
    ts: Date.now(),
  }
  const notifyResult = await postPeer("hub-a", defB, SHARED_SECRET, `${LISTEN_PATH}/notify`, notifyEnv, fetch)
  if (!notifyResult.ok) throw new Error(`notify POST failed: status ${notifyResult.status}`)
  if (!notifyFired) throw new Error("hub-b onNotify was not called")
  if (notifyFired.text !== "hello from hub-a") throw new Error(`notify text mismatch: ${notifyFired.text}`)
  console.log("OK: notify A→B delivered (status 200, onNotify fired, text correct)")

  // --- Smoke 2: ask A → B → reply back to A ---
  const askEnv: PeerEnvelope = {
    from: "hub-a:test-agent",
    to: "hub-b:fake-agent",
    corrId: `corr-ask-${Date.now()}`,
    kind: "ask",
    text: "ping",
    ts: Date.now(),
    replyTo: `http://127.0.0.1:${PORT_A}${LISTEN_PATH}/reply`,
  }
  const askResult = await postPeer("hub-a", defB, SHARED_SECRET, `${LISTEN_PATH}/ask`, askEnv, fetch)
  if (askResult.status !== 202) throw new Error(`ask POST expected 202, got ${askResult.status}`)
  if (!askFired) throw new Error("hub-b onAsk was not called")
  console.log("OK: ask A→B accepted (status 202, onAsk fired)")

  // Wait for hub-b to POST the reply back to hub-a (timeout 5s)
  const reply = await Promise.race([
    replyPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reply timeout after 5s")), 5000)),
  ])
  if (reply.text !== "pong from hub-b") throw new Error(`reply text mismatch: ${reply.text}`)
  if (reply.corrId !== askEnv.corrId) throw new Error(`reply corrId mismatch: ${reply.corrId}`)
  console.log("OK: reply B→A received (onReply fired, text and corrId correct)")

  // --- Smoke 3: parseTarget sanity ---
  const t = parseTarget("hub-b:agent-b")
  if (!t || t.peer !== "hub-b" || t.agent !== "agent-b") throw new Error("parseTarget failed")
  console.log("OK: parseTarget hub-b:agent-b → { peer: hub-b, agent: agent-b }")

  console.log("\npeer smoke OK")
} catch (err) {
  console.error("FAIL:", err)
  exitCode = 1
} finally {
  serverA.stop()
  serverB.stop()
  process.exit(exitCode)
}
