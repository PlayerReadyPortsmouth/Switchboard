import { signPeerBody } from "./peering"
import type { PeerDef } from "./types"

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>

export async function postPeer(
  self: string, def: PeerDef, secret: string, path: string, body: object, fetchImpl: FetchLike,
): Promise<{ ok: boolean; status: number }> {
  const raw = JSON.stringify(body)
  try {
    const res = await fetchImpl(def.baseUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Switchboard-Peer": self,
        "X-Switchboard-Signature": signPeerBody(raw, secret),
      },
      body: raw,
    })
    return { ok: res.status >= 200 && res.status < 300, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}
