# Switchboard — Read-Only Web Dashboard

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Point a browser at the hub and **watch it work** — a single self-contained web page (served on `webPort`) that polls one JSON endpoint and renders the live agent fleet, health, and a recent-activity feed, all projected from the snapshots the hub already produces (`StatusRegistry`, the audit ledger, the metrics health report). Read-only; no new data, no gateway changes.

---

## 0. Why this, why now

The hub's state is legible in Discord (`!status`, `!audit`, `!metrics`) and to machines (`/metrics`, `/health`), but there's **no human-facing web view** — nothing to leave open on a second monitor or share a link to. The data already exists; it just needs an HTML surface.

This is deliberately the **read-only** slice of "web support" (a full bidirectional web chat would mean abstracting the Discord-coupled `Gateway` — a much larger change). The dashboard reuses, verbatim, the projections built for metrics/health and the audit reader: the live `StatusSnapshot`, `AuditLog.recent()`/`summary()`, and the health readiness logic. The reply path (Discord) is untouched.

New components:

| Component | Responsibility |
| --- | --- |
| **web core** | Pure: project the snapshot + audit into the dashboard JSON; the static HTML page (a constant). |
| **web server** | A tiny `Bun.serve` on `webPort`: `GET /` → the page, `GET /api/status` → the JSON; pure request handler, injected collector. |

No new dependency (a vanilla-JS page, no build step), no new secret, off by default (no `webPort`, no listener). Mirrors the `metricsServer` shape exactly.

---

## 1. What it shows

A single page that fetches `/api/status` every few seconds and renders:

- **Header** — hub health (`ok`/`degraded`), uptime, route rate (10 m), pending approvals, live ephemeral count.
- **Agents table** — one row per persistent agent: alive ● / busy ◐, context-fill bar (0–100 %), queue depth, cumulative cost, replicas.
- **Activity feed** — the most recent audit events (time · kind · actor · action · target · outcome), the same metadata-only rows `!audit` shows.
- **Ledger summary** — counts by kind & outcome, total cost, distinct actors (from `AuditSummary`).

## 2. Web core (pure, unit-tested)

```ts
// hub/web.ts
export interface WebInput {
  now: number
  startedAt: number
  status: StatusSnapshot
  audit: AuditSummary
  recent: AuditEvent[]      // recent ledger rows for the feed
  pendingApprovals: number
}
renderDashboardJson(input: WebInput): DashboardJson    // the /api/status payload
export const DASHBOARD_HTML: string                    // the static page (polls /api/status)
```

```ts
interface DashboardJson {
  status: "ok" | "degraded"; uptimeSec: number; routeRate10m: number; pendingApprovals: number
  agents: { name: string; alive: boolean; busy: boolean; contextFill: number; queueDepth: number; costUsd: number; replicas: number }[]
  ephemerals: { jobId: string; agent: string; task: string }[]
  audit: AuditSummary
  recent: { ts: number; kind: string; actor: string; action: string; target?: string; outcome: string }[]
}
```

- `renderDashboardJson` reuses `renderHealth`'s readiness rule for `status` (degraded when agents exist but none alive) so the web view and `/health` never disagree.
- The payload is **metadata only** — it carries exactly what `!status`/`!audit` already expose (no message content, no secrets); the `recent` rows are the already-redacted ledger events.
- `DASHBOARD_HTML` is a constant string (inline CSS + a small poll-and-render script) — pure, so a test can assert it references `/api/status` and the expected anchors.

## 3. Web server (pure handler + listener)

```ts
// hub/webServer.ts
handleWebRequest(req: Request, collect: () => WebInput): Response
startWebServer(port: number, collect: () => WebInput): { stop: () => void } | null
```

- `GET /` → `DASHBOARD_HTML` (`text/html`).
- `GET /api/status` → `renderDashboardJson(collect())` (`application/json`).
- Non-GET → `405`; unknown path → `404`. Mirrors `handleWebRequest`/`handleMetricsRequest`, unit-tested without a socket.
- `startWebServer` returns `null` when `webPort` is unset — off by default.

## 4. Wiring

1. A `collectWeb()` closure: refresh board rows (as `!status`/metrics do) → `{ now, startedAt, status: snapshot, audit: audit.summary({}), recent: audit.recent({ limit: 30 }), pendingApprovals: approvalRegistry.pendingCount() }`.
2. `startWebServer(hub.webPort, collectWeb)`.

(`collectMetrics` and `collectWeb` share the same refresh; the only addition is the `recent` audit slice for the feed.)

## 5. Config & exposure

```jsonc
"webPort": 8080     // omit ⇒ no dashboard
```

One optional `HubConfig` field. The dashboard is **read-only and unauthenticated** (like `/metrics`), serving only the already-public status/audit metadata — no secrets, no message content, no write actions. Documented to bind on a private network / behind the same boundary as the metrics scrape; a bearer-token guard is a trivial later add.

## 6. From OK to must-have — what this seeds

- **A console.** Once there's a page and a JSON endpoint, drilling in (per-agent history, an audit filter UI, a cost graph) is additive front-end work over the same data.
- **The shell for write actions later.** If the full web-chat scope is ever taken on, this page is where it lands — the read-only view first, interactivity behind auth second.

## 7. Testing

- **core:** `renderDashboardJson` projects a representative snapshot (agents, ephemerals, summary, recent, degraded vs ok); `DASHBOARD_HTML` references `/api/status`.
- **server:** `handleWebRequest` routes `/` (html, 200), `/api/status` (json, 200), `405` on POST, `404` on unknown — injected `collect`, no real socket.

## 8. Build order (each increment shippable, leaves the system working)

1. **web core** (`hub/web.ts`) — `renderDashboardJson` + `DASHBOARD_HTML`. Pure.
2. **web server** (`hub/webServer.ts`) — `handleWebRequest` + `startWebServer`. Pure handler, injected collector.
3. **wire** — `collectWeb` + `startWebServer(hub.webPort, …)`; config + README + PR.
