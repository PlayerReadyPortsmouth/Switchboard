import { createHmac, timingSafeEqual } from "node:crypto"

export function verifySignature(rawBody: string, header: string, secret: string): boolean {
  if (!header || !secret) return false
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** One resolved webhook route: a path, its HMAC secret, and what to do with a
 *  verified body. The hub builds these from `hub.webhooks` + `process.env`. */
export interface WebhookHandler {
  path: string
  secret: string
  onBody: (rawBody: string) => void
}

/** Handle one request against a routing table. 404 unknown paths, 405 non-POST,
 *  401 bad signature, else 202 and invoke the route's onBody with the raw body. */
export async function handleWebhookRequest(
  req: Request, routes: WebhookHandler[],
): Promise<Response> {
  const url = new URL(req.url)
  const route = routes.find((r) => r.path === url.pathname)
  if (!route) return new Response("not found", { status: 404 })
  if (req.method !== "POST") return new Response("method", { status: 405 })
  const raw = await req.text()
  const sig = req.headers.get("X-Switchboard-Signature") ?? ""
  if (!verifySignature(raw, sig, route.secret)) return new Response("bad signature", { status: 401 })
  try { route.onBody(raw) } catch (e) { process.stderr.write(`webhook onBody failed: ${e}\n`) }
  return new Response("ok", { status: 202 })
}

/** Start a single HTTP listener that serves every route. Returns a stop fn, or
 *  null (no-op) if there is no port or no usable route. */
export function startWebhookListener(
  port: number, routes: WebhookHandler[],
  extraHandler?: (req: Request) => Promise<Response | null>,
): { stop: () => void } | null {
  const usable = routes.filter((r) => r.secret)
  if (!port || (usable.length === 0 && !extraHandler)) return null
  const server = Bun.serve({
    port,
    fetch: async (req) => {
      if (extraHandler) {
        const r = await extraHandler(req)
        if (r) return r
      }
      return handleWebhookRequest(req, usable)
    },
  })
  return { stop: () => server.stop(true) }
}
