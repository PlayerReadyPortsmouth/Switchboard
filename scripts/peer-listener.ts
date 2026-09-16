#!/usr/bin/env bun
// Interim cross-VPS PEER ENDPOINT runner.
// Brings up ONLY the Switchboard peering listener (the real hub/peerRoutes handler)
// on webhookPort, WITHOUT the Discord gateway — so a remote hub can reach this hub
// over WireGuard and complete the HMAC handshake / notify+ask now, before the full
// hub is persistently wired (bot-token decision parked till post-1-July).
// Inbound asks are logged (no live agent to answer yet); the full hub will dispatch
// them once it runs with a token. Run under pm2: pm2 start "bun run scripts/peer-listener.ts" --name switchboard-peer
import { readFileSync } from "fs"
import { startWebhookListener } from "../hub/webhookListener"
import { handlePeerRequest, type PeerRouteDeps } from "../hub/peerRoutes"
import { resolvePeer, peerSecret, PeerDedupe, PeerRateLimiter, type PeerEnvelope } from "../hub/peering"
import type { PeeringConfig } from "../hub/types"

const cfgAll = JSON.parse(readFileSync(new URL("../config/hub.config.json", import.meta.url), "utf8"))
const peering: PeeringConfig = cfgAll.peering
if (!peering || peering.enabled === false) { console.error("[peer] hub.config.json peering missing/disabled"); process.exit(1) }
const port: number = cfgAll.webhookPort ?? 4400
const base = peering.listenPath ?? "/peer"

const dedupe = new PeerDedupe(() => Date.now(), peering.dedupeWindowMs ?? 600000)
const rl = new PeerRateLimiter(() => Date.now(), peering.ratePerPeerPerMin ?? 0)
const line = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }))

const deps: PeerRouteDeps = {
  cfg: peering,
  secretFor: (name) => { const d = resolvePeer(peering, name); return d ? peerSecret(process.env, d) : undefined },
  dedupe,
  now: () => Date.now(),
  rateOk: (peer) => rl.ok(peer),
  onRejected: (peer, reason) => line({ rejected: peer, reason }),
  onNotify: (e: PeerEnvelope) => line({ kind: "notify", from: e.from, to: e.to, text: (e.text || "").slice(0, 300) }),
  onAsk: (e: PeerEnvelope) => line({ kind: "ask", from: e.from, to: e.to, corrId: e.corrId, note: "logged — full hub will dispatch to agent post-cutover", text: (e.text || "").slice(0, 300) }),
  onReply: (e: PeerEnvelope) => line({ kind: "reply", from: e.from, to: e.to, corrId: e.corrId, text: (e.text || "").slice(0, 300) }),
}

const extraHandler = (req: Request) =>
  new URL(req.url).pathname.startsWith(base) ? handlePeerRequest(req, deps) : Promise.resolve(null)

const listener = startWebhookListener(port, [], extraHandler)
if (!listener) { console.error("[peer] failed to start listener"); process.exit(1) }
line({ up: true, port, base, selfName: peering.selfName, peers: (peering.peers || []).map((p) => p.name), mode: "interim (no gateway)" })
