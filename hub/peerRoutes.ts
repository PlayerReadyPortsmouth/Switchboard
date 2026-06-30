import { verifyPeerBody, freshTs, type PeerDedupe, type PeerEnvelope } from "./peering"
import type { PeeringConfig } from "./types"

export interface PeerRouteDeps {
  cfg: PeeringConfig
  secretFor: (peerName: string) => string | undefined
  dedupe: PeerDedupe
  now: () => number
  onNotify: (e: PeerEnvelope) => void
  onAsk: (e: PeerEnvelope) => void
  onReply: (e: PeerEnvelope) => void
  rateOk: (peerName: string) => boolean
  onRejected: (peerName: string, reason: string) => void
}

export async function handlePeerRequest(req: Request, deps: PeerRouteDeps): Promise<Response> {
  const base = deps.cfg.listenPath ?? "/peer"
  const url = new URL(req.url)
  const kind = url.pathname === `${base}/notify` ? "notify"
    : url.pathname === `${base}/ask` ? "ask"
    : url.pathname === `${base}/reply` ? "reply" : null
  if (!kind) return new Response("not found", { status: 404 })
  if (req.method !== "POST") return new Response("method", { status: 405 })

  const raw = await req.text()
  const peerName = req.headers.get("X-Switchboard-Peer") ?? ""
  const sig = req.headers.get("X-Switchboard-Signature") ?? ""
  const secret = deps.secretFor(peerName)
  if (!secret || !verifyPeerBody(raw, sig, secret)) {
    deps.onRejected(peerName, "bad sig / unknown peer")
    return new Response("unauthorized", { status: 401 })
  }
  if (!deps.rateOk(peerName)) {
    deps.onRejected(peerName, "rate")
    return new Response("rate", { status: 429 })
  }
  let e: PeerEnvelope
  try { e = JSON.parse(raw) as PeerEnvelope } catch {
    deps.onRejected(peerName, "bad json"); return new Response("bad json", { status: 400 })
  }
  const skew = deps.cfg.maxClockSkewMs ?? 120000
  if (!freshTs(e.ts, deps.now(), skew)) {
    deps.onRejected(peerName, "stale ts"); return new Response("stale", { status: 400 })
  }
  if (deps.dedupe.seen(e.corrId)) {
    deps.onRejected(peerName, "duplicate"); return new Response("duplicate", { status: 409 })
  }
  if (kind === "notify") { deps.onNotify(e); return new Response("ok", { status: 200 }) }
  if (kind === "reply")  { deps.onReply(e);  return new Response("ok", { status: 200 }) }
  deps.onAsk(e)
  return new Response("accepted", { status: 202 })
}
