import { test, expect } from "bun:test"
import { createHmac } from "node:crypto"
import { matchOutbound, renderBody, signBody, backoffMs, hostAllowed, redact } from "../hub/outbound"
import type { OutboundRoute } from "../hub/types"
import { verifySignature } from "../hub/webhookListener"

const route = (p: Partial<OutboundRoute>): OutboundRoute => ({ id: "r", url: "https://x.test/h", ...p })

test("matchOutbound returns each text-triggered route with its capture groups", () => {
  const routes = [
    route({ id: "deploy", pattern: "DEPLOYED\\s+(\\S+)" }),
    route({ id: "noPattern" }),                       // not text-triggered
    route({ id: "bad", pattern: "(" }),               // invalid regex → skipped
    route({ id: "ping", pattern: "PING" }),
  ]
  const m = matchOutbound("DEPLOYED abc123", routes)
  expect(m.map(x => x.route.id)).toEqual(["deploy"])
  expect(m[0]!.groups).toEqual(["DEPLOYED abc123", "abc123"])
  expect(matchOutbound("nothing here", routes)).toEqual([])
})

test("renderBody interpolates $n from groups, falls back to body then whole match", () => {
  expect(renderBody('{"ref":"$1"}', { groups: ["DEPLOYED abc", "abc"] })).toBe('{"ref":"abc"}')
  expect(renderBody(undefined, { body: "raw body" })).toBe("raw body")
  expect(renderBody(undefined, { groups: ["whole"] })).toBe("whole")
  expect(renderBody("$0", { groups: ["whole", "g1"] })).toBe("whole")
})

test("signBody produces a sha256= HMAC over <ts>.<body> that re-verifies", () => {
  const body = '{"event":"deploy"}'
  const { signature, timestamp } = signBody(body, "s3cret", 1000)
  expect(timestamp).toBe("1000")
  // Receiver reconstructs "<ts>.<body>" and checks with the inbound verifier shape.
  expect(verifySignature(`${timestamp}.${body}`, signature, "s3cret")).toBe(true)
  const expected = "sha256=" + createHmac("sha256", "s3cret").update("1000." + body).digest("hex")
  expect(signature).toBe(expected)
})

test("backoffMs grows exponentially and caps", () => {
  expect([1, 2, 3, 4].map(n => backoffMs(n, 500))).toEqual([500, 1000, 2000, 4000])
  expect(backoffMs(20, 500, 30_000)).toBe(30_000)
})

test("hostAllowed enforces the allowlist, allows all when empty, rejects bad urls", () => {
  expect(hostAllowed("https://api.example.com/x", ["api.example.com"])).toBe(true)
  expect(hostAllowed("https://evil.com/x", ["api.example.com"])).toBe(false)
  expect(hostAllowed("https://anything/x", [])).toBe(true)
  expect(hostAllowed("not a url", ["api.example.com"])).toBe(false)
})

test("redact masks header values containing a secret", () => {
  expect(redact({ Authorization: "Bearer tok123", "X-A": "plain" }, ["tok123"]))
    .toEqual({ Authorization: "***", "X-A": "plain" })
})
