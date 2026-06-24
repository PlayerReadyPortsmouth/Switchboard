import { renderHealth, renderPrometheus, type MetricsInput } from "./metrics"

/** Route a metrics request: `GET /metrics` → Prometheus text; `GET /health` |
 *  `/healthz` → health JSON (200 ok / 503 degraded); non-GET → 405; else 404.
 *  Pure — the live data is supplied by the injected `collect`. */
export function handleMetricsRequest(req: Request, collect: () => MetricsInput): Response {
  if (req.method !== "GET") return new Response("method", { status: 405 })
  const path = new URL(req.url).pathname
  if (path === "/metrics") {
    return new Response(renderPrometheus(collect()), {
      status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    })
  }
  if (path === "/health" || path === "/healthz") {
    const { ok, body } = renderHealth(collect())
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 503, headers: { "content-type": "application/json" },
    })
  }
  return new Response("not found", { status: 404 })
}

/** Start the metrics/health listener on `port`; returns a stop fn, or null
 *  (no-op) when `port` is unset — off by default. Binds `host` (default
 *  127.0.0.1 — loopback-only unless an operator opts into a wider interface),
 *  since the endpoint is unauthenticated. */
export function startMetricsServer(port: number, collect: () => MetricsInput, host = "127.0.0.1"): { stop: () => void } | null {
  if (!port) return null
  const server = Bun.serve({ port, hostname: host, fetch: (req) => handleMetricsRequest(req, collect) })
  return { stop: () => server.stop(true) }
}
