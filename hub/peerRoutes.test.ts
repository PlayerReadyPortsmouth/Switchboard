// hub/peerRoutes.test.ts
import { expect, test } from "bun:test"
import { handlePeerRequest, type PeerRouteDeps } from "./peerRoutes"
import { signPeerBody, PeerDedupe, type PeerEnvelope } from "./peering"
import type { PeeringConfig } from "./types"

const cfg: PeeringConfig = {
  enabled: true, listenPath: "/peer", selfName: "self", selfBaseUrl: "http://127.0.0.1:1",
  peers: [{ name: "p", baseUrl: "http://x", secretEnv: "S" }],
}
const SECRET = "sekret"

function deps(over: Partial<PeerRouteDeps> = {}): PeerRouteDeps & { calls: any } {
  const calls: any = { notify: [], ask: [], reply: [], rejected: [] }
  return {
    cfg, secretFor: () => SECRET, dedupe: new PeerDedupe(() => 0, 1000), now: () => 0,
    rateOk: () => true,
    onNotify: (e) => calls.notify.push(e), onAsk: (e) => calls.ask.push(e),
    onReply: (e) => calls.reply.push(e), onRejected: (n, r) => calls.rejected.push([n, r]),
    calls, ...over,
  }
}

function req(path: string, body: PeerEnvelope, secret = SECRET, peer = "p", method = "POST"): Request {
  const raw = JSON.stringify(body)
  return new Request("http://h" + path, {
    method, body: raw,
    headers: { "X-Switchboard-Peer": peer, "X-Switchboard-Signature": signPeerBody(raw, secret) },
  })
}
const env = (kind: PeerEnvelope["kind"], corrId = "c1"): PeerEnvelope =>
  ({ from: "p", to: "self:agent-a", corrId, kind, text: "hi", ts: 0, replyTo: "http://p/peer/reply" })

test("valid notify → 200 + onNotify", async () => {
  const d = deps()
  const r = await handlePeerRequest(req("/peer/notify", env("notify")), d)
  expect(r.status).toBe(200)
  expect(d.calls.notify.length).toBe(1)
})

test("valid ask → 202 + onAsk", async () => {
  const d = deps()
  const r = await handlePeerRequest(req("/peer/ask", env("ask")), d)
  expect(r.status).toBe(202)
  expect(d.calls.ask.length).toBe(1)
})

test("unknown path → 404", async () => {
  expect((await handlePeerRequest(req("/peer/nope", env("notify")), deps())).status).toBe(404)
})

test("non-POST → 405", async () => {
  expect((await handlePeerRequest(req("/peer/notify", env("notify"), SECRET, "p", "GET"), deps())).status).toBe(405)
})

test("bad signature → 401 + onRejected", async () => {
  const d = deps()
  const r = await handlePeerRequest(req("/peer/notify", env("notify"), "wrong"), d)
  expect(r.status).toBe(401)
  expect(d.calls.rejected[0][1]).toContain("sig")
})

test("unknown peer (no secret) → 401", async () => {
  const d = deps({ secretFor: () => undefined })
  expect((await handlePeerRequest(req("/peer/notify", env("notify")), d)).status).toBe(401)
})

test("duplicate corrId → 409", async () => {
  const d = deps()
  await handlePeerRequest(req("/peer/notify", env("notify", "dup")), d)
  const r = await handlePeerRequest(req("/peer/notify", env("notify", "dup")), d)
  expect(r.status).toBe(409)
})

test("over rate → 429", async () => {
  const d = deps({ rateOk: () => false })
  expect((await handlePeerRequest(req("/peer/notify", env("notify")), d)).status).toBe(429)
})

test("stale ts → 400", async () => {
  const d = deps({ now: () => 10_000_000 }) // far from ts:0
  const r = await handlePeerRequest(req("/peer/notify", env("notify")), d)
  expect(r.status).toBe(400)
})
