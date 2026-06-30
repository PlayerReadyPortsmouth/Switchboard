// hub/peerClient.test.ts
import { expect, test } from "bun:test"
import { postPeer } from "./peerClient"
import { verifyPeerBody } from "./peering"
import type { PeerDef } from "./types"

const def: PeerDef = { name: "p", baseUrl: "http://10.0.0.1:8787", secretEnv: "S" }

test("postPeer signs the body and targets baseUrl+path; ok on 2xx", async () => {
  let seen: any = null
  const fetchImpl = async (url: string, init: any) => {
    seen = { url, init }; return { status: 202 }
  }
  const r = await postPeer("self-hub", def, "sekret", "/peer/ask", { corrId: "c1" }, fetchImpl)
  expect(r).toEqual({ ok: true, status: 202 })
  expect(seen.url).toBe("http://10.0.0.1:8787/peer/ask")
  expect(seen.init.headers["X-Switchboard-Peer"]).toBe("self-hub")
  expect(verifyPeerBody(seen.init.body, seen.init.headers["X-Switchboard-Signature"], "sekret")).toBe(true)
})

test("postPeer reports not-ok on non-2xx", async () => {
  const r = await postPeer("self", def, "s", "/peer/notify", {}, async () => ({ status: 401 }))
  expect(r.ok).toBe(false)
  expect(r.status).toBe(401)
})

test("postPeer reports not-ok on throw", async () => {
  const r = await postPeer("self", def, "s", "/peer/notify", {}, async () => { throw new Error("conn refused") })
  expect(r).toEqual({ ok: false, status: 0 })
})
