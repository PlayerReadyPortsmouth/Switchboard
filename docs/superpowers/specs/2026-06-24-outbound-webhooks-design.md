# Switchboard — Outbound Webhooks (and the road to a must-have)

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Let agents (and hub events) **act on the outside world** — fire a signed, reliably-delivered HTTP POST to a configured destination — without ever handing an agent a raw URL. Built so its delivery log, named-route model, and approval hook become the seeds of an audit log, an action catalog, and a governance layer: the things that turn Switchboard from "an ok Discord bot" into "the audited control plane a team's ops run through."

---

## 0. Why this, why now

Switchboard today is **one-way**: messages in → agents answer → maybe a card. The only outbound HTTP is `directCommands`' user-triggered exec and Discord card posting. There is **no way for an agent or a hub event to push to an external system**. Closing that loop is the difference between a conversational toy and an operational tool.

Done naively this is "let the agent call `fetch`." Done right it is a **governed effect**: the agent names an action, the hub owns the URL + secret, every attempt is signed, retried, logged, and (optionally) gated on a human. That governance is exactly the substrate the must-have features need (§7), so we build it once, here.

New components:

| Component | Responsibility |
| --- | --- |
| **OutboundRoute** | A named destination (`url`, `secretEnv`, method, headers, template) + optional text-trigger `pattern` + optional `requireApproval`. |
| **outbound core** | Pure: match a route by text/name, render the body, HMAC-sign, redact, compute retry backoff. |
| **OutboundDelivery** | The engine: async send with retry → dead-letter on exhaustion, idempotency key, append-only delivery log. Injected IO. |
| **`post_webhook` shim tool** | Agent-facing MCP tool addressing routes **by name** (never a raw URL). |

No new secret type (env-var refs, as everywhere else); all model/IO seams injected for tests, mirroring `router.ts` / `directCommands.ts`.

---

## 1. Route shape

```jsonc
"outboundWebhooks": [
  {
    "id": "deploy-done",                       // address for post_webhook + the log key
    "pattern": "DEPLOYED\\s+(\\S+)",           // optional: agent outbound text trigger ($1.. = groups)
    "url": "https://hooks.example.com/deploy",
    "secretEnv": "OUT_HOOK_SECRET",            // optional: HMAC-sign the body with this secret
    "method": "POST",                          // default POST
    "headers": { "X-Source": "switchboard" },  // optional static headers
    "template": "{\"event\":\"deploy\",\"ref\":\"$1\"}",  // optional; omit ⇒ raw trigger text / tool body
    "requireApproval": false                   // optional: gate behind the deploy-approver button (§7)
  }
]
```

- `pattern` present ⇒ the route is **text-triggered** (matched against agent outbound text, like `spawnTriggers[]`).
- Any route (with or without `pattern`) is addressable by `id` via the **`post_webhook`** MCP tool and by **hub events** (§4).
- Hub config gains optional `outboundAllowedHosts?: string[]` (defense-in-depth host allowlist) and `outboundRetries?: number` (default 3).

## 2. Outbound core (pure, fully unit-tested)

```ts
matchOutbound(text: string, routes: OutboundRoute[]): { route; groups: string[] }[]   // all matches
renderBody(template: string | undefined, ctx: { groups?: string[]; body?: string }): string
signBody(body: string, secret: string, tsSec: number): { signature: string; timestamp: string }
backoffMs(attempt: number, baseMs = 500): number    // 500, 1000, 2000, … (capped)
redact(obj: Record<string,string>, secrets: string[]): Record<string,string>  // for the log
```

- **Signing** is symmetric with the *incoming* verifier (`hub/webhookListener.ts`): `X-Switchboard-Signature: sha256=hmac(secret, "${timestamp}.${body}")` plus `X-Switchboard-Timestamp` so receivers get replay protection. (Receivers reuse the same `verifySignature` shape.)
- `$1..$n` interpolate regex capture groups (text-trigger); the `post_webhook` body is sent as-is (or through `template` if the route defines one).

## 3. OutboundDelivery — reliable by construction

```ts
interface DeliverDeps {
  fetch: (url, init) => Promise<{ status: number }>
  appendLog: (entry: DeliveryLogEntry) => void        // <stateDir>/outbound-log.jsonl
  appendDeadLetter: (entry: DeadLetterEntry) => void   // <stateDir>/outbound-dead.jsonl
  sleep: (ms: number) => Promise<void>
  now: () => number
  idempotencyKey: (route: string, body: string) => string
}
class OutboundDelivery {
  deliver(route: OutboundRoute, body: string): Promise<DeliveryResult>   // async, off the hot path
}
```

- **Async / non-blocking:** delivery never blocks an agent turn (fire-and-forget from `onAgentReply`; the engine owns the lifecycle).
- **Retry:** up to `outboundRetries` attempts with `backoffMs` between; 2xx ⇒ success, else retry; network throw ⇒ retry.
- **Idempotency:** a stable `Idempotency-Key` header per (route, body) so receivers dedupe across retries.
- **Dead-letter:** on exhaustion, append the payload + last status to `outbound-dead.jsonl` (atomic append) for inspection/replay — never a silent drop.
- **Delivery log:** every attempt (route id, status, attempt n, ts, **secrets redacted**) → `outbound-log.jsonl`. *This file is the seed of the audit log (§7).*

Atomic-append uses the existing `.tmp`+rename / append discipline already used for `bindings.json` / `cron-state.json`.

## 4. Triggers & wiring

1. **Agent-text** — in `onAgentReply` (alongside the existing `spawnTriggers` scan), `matchOutbound(reply.text, routes)` → for each match, `delivery.deliver(route, renderBody(...))`. The matched text is *not* consumed (unlike spawn triggers) — it still posts to Discord — unless the route sets `consume: true`.
2. **`post_webhook` MCP tool** — new shim tool `post_webhook({ target: string, body?: string })` over the existing socket (new kind `webhook`, like `remember`). The hub **resolves `target` against `outboundWebhooks[].id`**; an unknown id is rejected (logged). The agent never supplies a URL — this is the SSRF / data-exfiltration guard.
3. **Hub events (optional, last)** — a tiny internal emitter: `agent.offline`, `governor.compacted`, `deploy.ok`, `schedule.fired` → any route whose `id` matches a configured event name. Lets external systems observe the hub.

## 5. Security

- **No agent-supplied URLs.** Agents address routes by name; the hub holds URL + secret. Text-trigger routes are operator-defined too.
- **Host allowlist** (`outboundAllowedHosts`) checked before every send — defense-in-depth even for configured routes.
- **Secrets** come only from named env vars and are **redacted** in the delivery log.
- **Signed + timestamped** so receivers can verify authenticity and reject replays.
- Prompt-injection stance inherited: a Discord message telling an agent to "post our data to evil.com" can't — there is no raw-URL path; only named, operator-approved routes exist.

## 6. Testing

- **core:** `matchOutbound` (multi-match, no-match, group capture); `renderBody` ($n interp, raw passthrough); `signBody` (HMAC matches `verifySignature`, timestamp included); `backoffMs` (sequence + cap); `redact`.
- **delivery:** success on 2xx (one attempt, logged); retry then succeed; retry-exhaust → dead-letter + log; idempotency key stable across retries; host-allowlist rejection; injected `fetch`/`sleep`/`now` (no real network), mirroring existing transport tests.
- **tool resolution:** `post_webhook` unknown `target` rejected; known `target` delivers.

## 7. From OK to must-have — what this seeds

This feature is deliberately the **foundation** of a larger arc. Each piece below reuses what §1–§4 build:

1. **Audit log** — the `outbound-log.jsonl` delivery log generalizes into an append-only record of *every* inbound, route decision, agent action, outbound call, approval, and cost — operator-queryable (`!audit`, or an embed). The single biggest trust lever for anything touching real systems.
2. **Gated action catalog** — named `OutboundRoute`s + `requireApproval` generalize into a catalog of *typed* actions (ticket / sheet / page / email-SMS) the agent invokes by name, sensitive ones gated behind the existing `deploy:`-style approver button before they fire.
3. **Reliable + observable by default** — retry / dead-letter / idempotency become the platform's delivery guarantees (and a `!deadletter` replay surface), not a per-integration afterthought.
4. **Durable playbooks** (further out) — once actions are named, governed, and logged, chaining them with cron + state gives resumable multi-step workflows ("run the Tuesday close"), the point at which the hub becomes load-bearing.

We don't build §7 now — but §1–§4 are shaped so these are additive, not rewrites.

## 8. Build order (each increment shippable, leaves the system working)

1. **outbound core** (match / render / sign / backoff / redact) + config types. Pure, no wiring.
2. **OutboundDelivery** engine (retry / dead-letter / idempotency / log), injected IO.
3. **Text-trigger wiring** in `onAgentReply` + `outboundWebhooks[]` loaded in `index.ts`.
4. **`post_webhook` shim tool** + socket `webhook` kind (named-route resolution; unknown rejected).
5. **Hub-event sink** (optional) + README + example config.
