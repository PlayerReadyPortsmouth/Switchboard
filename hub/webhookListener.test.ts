import { test, expect } from "bun:test"
import { createHmac } from "node:crypto"
import { verifySignature, handleWebhookRequest, type WebhookHandler } from "./webhookListener"

const SECRET = "shh"
const sign = (b: string) => "sha256=" + createHmac("sha256", SECRET).update(b).digest("hex")

const routes = (onBody: (b: string) => void): WebhookHandler[] => [
  { path: "/hooks/example", secret: SECRET, onBody },
]

test("verifySignature accepts a correct sig and rejects a wrong one", () => {
  const body = JSON.stringify({ a: 1 })
  expect(verifySignature(body, sign(body), SECRET)).toBe(true)
  expect(verifySignature(body, "sha256=deadbeef", SECRET)).toBe(false)
  expect(verifySignature(body, "", SECRET)).toBe(false)
})

test("handleWebhookRequest 202s a valid payload and calls onBody with the raw body", async () => {
  const seen: string[] = []
  const body = JSON.stringify({ event: "thing.created", id: "T-1" })
  const req = new Request("http://h/hooks/example", {
    method: "POST", body, headers: { "X-Switchboard-Signature": sign(body) },
  })
  const res = await handleWebhookRequest(req, routes((b) => seen.push(b)))
  expect(res.status).toBe(202)
  expect(JSON.parse(seen[0]!).id).toBe("T-1")
})

test("handleWebhookRequest 401s a bad signature and does not call onBody", async () => {
  const seen: string[] = []
  const body = JSON.stringify({ event: "thing.created" })
  const req = new Request("http://h/hooks/example", {
    method: "POST", body, headers: { "X-Switchboard-Signature": "sha256=nope" },
  })
  const res = await handleWebhookRequest(req, routes((b) => seen.push(b)))
  expect(res.status).toBe(401)
  expect(seen.length).toBe(0)
})

test("handleWebhookRequest 404s an unknown path", async () => {
  const req = new Request("http://h/nope", { method: "POST", body: "{}" })
  const res = await handleWebhookRequest(req, routes(() => {}))
  expect(res.status).toBe(404)
})

test("handleWebhookRequest routes by path to the matching secret/handler", async () => {
  const seen: string[] = []
  const secondSign = (b: string) => "sha256=" + createHmac("sha256", "other").update(b).digest("hex")
  const multi: WebhookHandler[] = [
    { path: "/hooks/a", secret: SECRET, onBody: (b) => seen.push("a:" + b) },
    { path: "/hooks/b", secret: "other", onBody: (b) => seen.push("b:" + b) },
  ]
  const body = "{}"
  const req = new Request("http://h/hooks/b", {
    method: "POST", body, headers: { "X-Switchboard-Signature": secondSign(body) },
  })
  const res = await handleWebhookRequest(req, multi)
  expect(res.status).toBe(202)
  expect(seen).toEqual(["b:{}"])
})
