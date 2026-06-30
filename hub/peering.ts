import { createHmac } from "node:crypto"
import { verifySignature } from "./webhookListener"
import type { PeeringConfig, PeerDef } from "./types"

export interface PeerEnvelope {
  from: string
  to: string
  corrId: string
  kind: "notify" | "ask" | "reply"
  text: string
  ts: number
  replyTo?: string
}

export function parseTarget(s: string): { peer: string; agent: string } | null {
  const i = s.indexOf(":")
  if (i <= 0 || i === s.length - 1) return null
  return { peer: s.slice(0, i), agent: s.slice(i + 1) }
}

export function signPeerBody(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")
}

export function verifyPeerBody(rawBody: string, header: string, secret: string): boolean {
  return verifySignature(rawBody, header, secret)
}

export function resolvePeer(cfg: PeeringConfig, name: string): PeerDef | undefined {
  return cfg.peers.find((p) => p.name === name)
}

export function peerSecret(env: NodeJS.ProcessEnv, def: PeerDef): string | undefined {
  const v = env[def.secretEnv]
  return v && v.length > 0 ? v : undefined
}

export function freshTs(ts: number, now: number, skewMs: number): boolean {
  return Math.abs(now - ts) <= skewMs
}

/** Remembers seen corrIds for `windowMs`; `seen` returns true if already seen. */
export class PeerDedupe {
  private at = new Map<string, number>()
  constructor(private now: () => number, private windowMs: number) {}
  seen(corrId: string): boolean {
    const t = this.now()
    for (const [k, when] of this.at) if (t - when > this.windowMs) this.at.delete(k)
    if (this.at.has(corrId)) return true
    this.at.set(corrId, t)
    return false
  }
}
