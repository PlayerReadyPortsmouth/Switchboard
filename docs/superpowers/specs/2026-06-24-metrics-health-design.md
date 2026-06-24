# Switchboard — Metrics & Health Endpoints

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Expose what the hub is doing as **machine-readable metrics** — a Prometheus `/metrics` scrape and a `/health` JSON probe on a dedicated port, plus a `!metrics` chat rollup — all *derived* from signals the hub already has (the live `StatusRegistry` snapshot + the audit ledger summary), so there's nothing new to instrument.

---

## 0. Why this, why now

The hub already knows everything an operator wants graphed — per-agent context fill, queue depth, cost, the router's pick rate, live ephemerals (`StatusRegistry`), and a full ledger of governed effects (the audit log). But it's only legible *inside Discord* (`!status`, `!audit`). There's no way to point Grafana, a uptime checker, or a load balancer at the hub.

This feature is the **read-out**: it turns the existing snapshots into the two standard ops surfaces — a Prometheus exposition endpoint and a health probe — without adding a metrics library or a single new counter to the hot path. It's pure projection of `StatusSnapshot` + `AuditSummary` (the keystone paying off again: deny rate, outbound error rate, cost all fall out of `summarize`). **Off by default** — no `metricsPort`, no listener.

New components:

| Component | Responsibility |
| --- | --- |
| **metrics core** | Pure: project a `MetricsInput` (status snapshot + audit summary + uptime + pending approvals) into Prometheus text and a health JSON report. |
| **metrics server** | A tiny `Bun.serve` on `metricsPort` routing `GET /metrics`, `/health`, `/healthz` — pure request handler, injected collector. |
| **`!metrics` command** | Operator-only chat rollup of the same health report. |

No new dependency. The HTTP handler mirrors `handleWebhookRequest` (pure `(req) => Response`, unit-tested), and the listener mirrors `startWebhookListener`.

---

## 1. What's exposed

**Live gauges from `StatusSnapshot`** (the natural Prometheus shape — current values, labelled by agent):

```
switchboard_up 1
switchboard_uptime_seconds <n>
switchboard_agent_alive{agent="assistant"} 1
switchboard_agent_busy{agent="assistant"} 0
switchboard_agent_queue_depth{agent="assistant"} 2
switchboard_agent_context_fill_ratio{agent="assistant"} 0.62
switchboard_agent_cost_usd{agent="assistant"} 0.4137
switchboard_agent_replicas{agent="assistant"} 1
switchboard_route_rate_10m <n>
switchboard_ephemerals_active <n>
switchboard_overseers_active <n>
switchboard_pending_approvals <n>
```

**Ledger gauges from `AuditSummary`** (counts over the *current* `audit.jsonl` window — a gauge, not a monotonic counter, since rotation drops history; named without `_total` and documented as such):

```
switchboard_ledger_events{kind="outbound"} <n>
switchboard_ledger_outcomes{outcome="deny"} <n>
switchboard_ledger_cost_usd <n>
```

Each family carries `# HELP` / `# TYPE gauge` lines; label values are escaped per the exposition format.

## 2. Metrics core (pure, unit-tested)

```ts
// hub/metrics.ts
export interface MetricsInput {
  now: number
  startedAt: number
  status: StatusSnapshot          // from StatusRegistry.snapshot()
  audit: AuditSummary             // from AuditLog.summary({})
  pendingApprovals: number        // from ApprovalRegistry.pendingCount()
}
renderPrometheus(input: MetricsInput): string
renderHealth(input: MetricsInput): { ok: boolean; body: HealthReport }
```

```ts
interface HealthReport {
  status: "ok" | "degraded"
  uptimeSec: number
  agents: { name: string; alive: boolean; busy: boolean; queueDepth: number; contextFill: number }[]
  pendingApprovals: number
  routeRate10m: number
}
```

- `renderHealth` is **`degraded` (HTTP 503)** when agents exist but none are alive — a real readiness signal for a load balancer; otherwise `ok` (200).
- Both are pure functions of the input; an injected clock (`now`/`startedAt`) keeps them deterministic in tests.

## 3. Metrics server (pure handler + listener)

```ts
// hub/metricsServer.ts
handleMetricsRequest(req: Request, collect: () => MetricsInput): Response
startMetricsServer(port: number, collect: () => MetricsInput): { stop: () => void } | null
```

- `GET /metrics` → Prometheus text (`content-type: text/plain; version=0.0.4`).
- `GET /health` | `/healthz` → the health JSON, `200`/`503` by readiness.
- Non-GET → `405`; unknown path → `404`. Mirrors `handleWebhookRequest`, so it's unit-tested without a socket.
- `startMetricsServer` returns `null` (no-op) when `metricsPort` is unset — off by default.

**Exposure note:** the endpoint is unauthenticated (the Prometheus norm) and serves **only already-aggregated, non-secret** numbers — no message content, no secrets, no per-user data. It's meant to bind on a private network / behind the same boundary as a scrape target; documented as such. (A bearer-token guard is a trivial later addition if needed.)

## 4. Wiring

1. Stamp `startedAt` at boot.
2. A `collect()` closure: refresh the board rows (`setAgents(buildAgentRows())`, `setOverseers(...)` — exactly what `!status` does on demand), then return `{ now, startedAt, status: statusRegistry.snapshot(now), audit: audit.summary({}), pendingApprovals: approvalRegistry.pendingCount() }`.
3. `startMetricsServer(hub.metricsPort, collect)`.
4. `!metrics` (operator-gated, like `!status`/`!audit`) → `renderHealth(collect()).body` rendered as a compact block.

## 5. Config

```jsonc
"metricsPort": 9090     // omit ⇒ no metrics/health listener
```

One optional field on `HubConfig`. Reuses the existing approver/operator gate for `!metrics`; no new secret.

## 6. From OK to must-have — what this seeds

- **Dashboards & alerting** — once scraped, "page me when any agent's context fill > 0.9 for 5m" or "alert on outbound deny rate" are Grafana/Alertmanager rules, not hub code.
- **Autoscaling signals** — the same gauges the in-process `AgentPool` reads are now externally visible, so an external orchestrator could drive scaling too.
- **SLOs** — `/health` readiness + uptime is the basis for an availability SLO and a load-balancer health check.

## 7. Testing

- **core:** `renderPrometheus` emits HELP/TYPE + correctly-labelled, escaped samples for a representative snapshot; `renderHealth` is `degraded`/503 when agents exist but none alive, `ok`/200 otherwise (incl. the no-agents case).
- **server:** `handleMetricsRequest` routes `/metrics` (text, 200), `/health` (json, 200/503), `405` on POST, `404` on unknown — injected `collect`, no real socket.

## 8. Build order (each increment shippable, leaves the system working)

1. **metrics core** (`hub/metrics.ts`) — `renderPrometheus` / `renderHealth` + types. Pure.
2. **metrics server** (`hub/metricsServer.ts`) — `handleMetricsRequest` + `startMetricsServer`. Pure handler, injected collector.
3. **wire + `!metrics`** — construct the collector, start the listener on `metricsPort`, add the operator command; config + README + PR.
