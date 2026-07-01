import { DASHBOARD_HTML, renderDashboardJson, type WebInput } from "./web"
import type { ChannelEvent } from "./channelStream"
import type { TraceRecord } from "./turnTrace"

export interface ChannelInfo { channelId: string; name?: string; agent: string }

export interface WebDeps {
  collect: () => WebInput
  requireUser: (req: Request) => string | null
  resolveApproval: (id: string, decision: "grant" | "deny", actor: string) => Promise<"granted" | "denied" | "not_found">
  listChannels: () => ChannelInfo[]
  fetchChannelHistory: (channelId: string) => Promise<ChannelEvent[]>
  fetchChannelTimeline: (channelId: string) => Promise<TraceRecord[]>
  subscribeChannel: (channelId: string, cb: (evt: ChannelEvent) => void) => () => void
  sendChannelMessage: (channelId: string, email: string, text: string) => Promise<void>
  runCommand: (name: string, channelId: string) => Promise<string | null>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

function sseResponse(subscribe: (cb: (evt: ChannelEvent) => void) => () => void): Response {
  let unsubscribe: () => void = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      unsubscribe = subscribe((evt) => controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`)))
    },
    cancel() { unsubscribe() },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

/** Route a dashboard/API request. `GET /` and `GET /api/status` are unauthenticated
 *  (dashboard shell + poll payload); every other route requires the
 *  X-Switchboard-User identity header (via `deps.requireUser`) and is otherwise
 *  404 (unknown path) or 405 (known path, wrong method). Async — several routes
 *  await injected deps (approval resolution, channel I/O, command execution). */
export async function handleWebRequest(req: Request, deps: WebDeps): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (method === "GET" && path === "/api/status") {
    return json(renderDashboardJson(deps.collect()))
  }
  // `/` and `/api/status` only support GET above — any other method on those
  // exact paths is a known route used wrong (405), not an unknown route (404).
  if (path === "/" || path === "/api/status") return new Response("method", { status: 405 })

  // Every route below requires the identity header the ReadyApp proxy sets.
  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path)
  const channelHistoryMatch = /^\/api\/channel\/([^/]+)\/history$/.exec(path)
  const channelTimelineMatch = /^\/api\/channel\/([^/]+)\/timeline$/.exec(path)
  const channelStreamMatch = /^\/api\/channel\/([^/]+)\/stream$/.exec(path)
  const channelMessageMatch = /^\/api\/channel\/([^/]+)\/message$/.exec(path)
  const commandMatch = /^\/api\/command\/([^/]+)$/.exec(path)
  const isGuardedRoute = path === "/api/channels" || approvalMatch || channelHistoryMatch ||
    channelTimelineMatch || channelStreamMatch || channelMessageMatch || commandMatch

  if (isGuardedRoute) {
    // Auth runs before method dispatch below, so a wrong-method request without
    // the identity header returns 400 (missing_identity) rather than 405 — intentional,
    // so an unauthenticated caller can't probe which methods/routes exist.
    const email = deps.requireUser(req)
    if (!email) return json({ error: "missing_identity" }, 400)

    if (method === "GET" && path === "/api/channels") return json(deps.listChannels())

    if (method === "POST" && approvalMatch) {
      const body = (await req.json().catch(() => null)) as { decision?: "grant" | "deny" } | null
      if (body?.decision !== "grant" && body?.decision !== "deny") return json({ error: "bad_decision" }, 400)
      const state = await deps.resolveApproval(approvalMatch[1], body.decision, email)
      return state === "not_found" ? json({ state }, 409) : json({ state })
    }

    if (method === "GET" && channelHistoryMatch) {
      return json(await deps.fetchChannelHistory(channelHistoryMatch[1]))
    }

    if (method === "GET" && channelTimelineMatch) {
      return json(await deps.fetchChannelTimeline(channelTimelineMatch[1]))
    }

    if (method === "GET" && channelStreamMatch) {
      return sseResponse((cb) => deps.subscribeChannel(channelStreamMatch[1], cb))
    }

    if (method === "POST" && channelMessageMatch) {
      const body = (await req.json().catch(() => null)) as { text?: string } | null
      if (!body?.text) return json({ error: "missing_text" }, 400)
      await deps.sendChannelMessage(channelMessageMatch[1], email, body.text)
      return json({ ok: true })
    }

    if (method === "POST" && commandMatch) {
      const body = (await req.json().catch(() => null)) as { channelId?: string } | null
      if (!body?.channelId) return json({ error: "missing_channelId" }, 400)
      const text = await deps.runCommand(commandMatch[1], body.channelId)
      return text === null ? json({ error: "unknown_command" }, 404) : json({ text })
    }

    // Known guarded path, but wrong method for it.
    return new Response("method", { status: 405 })
  }

  return new Response("not found", { status: 404 })
}

/** Start the dashboard/API listener on `port`; returns a stop fn, or null (no-op)
 *  when `port` is unset — off by default. Binds `host` (default 127.0.0.1 —
 *  loopback-only unless an operator opts in). */
export function startWebServer(port: number, deps: WebDeps, host = "127.0.0.1"): { stop: () => void } | null {
  if (!port) return null
  const server = Bun.serve({ port, hostname: host, fetch: (req) => handleWebRequest(req, deps) })
  return { stop: () => server.stop(true) }
}
