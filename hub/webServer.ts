import { DASHBOARD_HTML, renderDashboardJson, type WebInput } from "./web"

/** Route a dashboard request: `GET /` → the page; `GET /api/status` → the JSON
 *  payload; non-GET → 405; else 404. Pure — live data via the injected `collect`. */
export function handleWebRequest(req: Request, collect: () => WebInput): Response {
  if (req.method !== "GET") return new Response("method", { status: 405 })
  const path = new URL(req.url).pathname
  if (path === "/" || path === "/index.html") {
    return new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (path === "/api/status") {
    return new Response(JSON.stringify(renderDashboardJson(collect())), {
      status: 200, headers: { "content-type": "application/json" },
    })
  }
  return new Response("not found", { status: 404 })
}

/** Start the dashboard listener on `port`; returns a stop fn, or null (no-op)
 *  when `port` is unset — off by default. Binds `host` (default 127.0.0.1 —
 *  loopback-only unless an operator opts in), since the page is unauthenticated. */
export function startWebServer(port: number, collect: () => WebInput, host = "127.0.0.1"): { stop: () => void } | null {
  if (!port) return null
  const server = Bun.serve({ port, hostname: host, fetch: (req) => handleWebRequest(req, collect) })
  return { stop: () => server.stop(true) }
}
