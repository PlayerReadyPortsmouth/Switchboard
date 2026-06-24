# Switchboard — Gated Action Catalog (human-in-the-loop approval)

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Make a risky effect **pause for a human** before it fires. An agent (or hub) names an action marked `requireApproval`; instead of executing, the hub posts an **Approve / Deny** card and holds the effect until an authorized operator clicks — every step an `approval` event in the audit ledger. This is what turns Switchboard from "trusted agents" into "agents with a human in the loop for the dangerous stuff."

---

## 0. Why this, why now

Switchboard already has the *pieces* of approval but not the *flow*. The outbound `OutboundRoute.requireApproval` flag has been typed since the outbound PR but is **never enforced** (`hub/types.ts`). `GatedAction` buttons (`hub/gatedActions.ts`) run hub-side shell commands gated by an approver — but they fire **immediately** on click; there is no "ask first, fire later." And the audit log just shipped with an `approval` kind and a `corr` correlation field already in the union, waiting for a producer.

So the missing piece is a **deferred, human-gated effect**: an effect is intercepted *before* it runs, parked as a pending approval, surfaced as a Discord card, and only executed when an authorized human approves (or dropped if they deny or it times out). This is the natural second step of the "ok → must-have" arc the outbound spec named (§7): named actions + `requireApproval` + the approver button → a real governance gate.

Everything is **opt-in** — the flag is enforced only when the approvals subsystem is enabled; with no `approvals` config, behaviour is unchanged.

New components:

| Component | Responsibility |
| --- | --- |
| **ApprovalRegistry** | In-memory store of pending approvals: `request` (park an effect), `resolve` (grant/deny), `sweepExpired` (TTL). Holds the deferred effect closure. |
| **approval card** | Pure render of the Approve/Deny card (and its granted/denied/expired terminal states) + the `approval:grant\|deny:<id>` customId helpers. |
| **approval wiring** | Construct the registry; post the card; gate `approval:*` buttons to configured approvers; on click, fire-or-drop the held effect; sweep on a timer; audit every step (threaded by `corr`). |
| **`requireApproval` enforcement** | `deliverAudited` routes a flagged outbound through the gate instead of firing — the first consumer of the generic registry. |

No new dependency, no new secret type. The registry is in-memory like `CardRegistry`/`NotifyRouter` — which gives a **fail-closed** property: a hub restart drops pending approvals (the effect simply never fires), the safe default for "require approval."

---

## 1. The approval lifecycle

```
agent/hub effect (requireApproval)         operator                    hub
        │                                       │                        │
        │ deliverAudited(route, …)              │                        │
        ├──────────────────────────────────────────────────────────────►│  intercept: requireApproval?
        │                                       │     Approve/Deny card  │  registry.request(req, fire)
        │                                       │◄───────────────────────┤  audit approval/request (pending, corr=id)
        │                                       │ clicks ✅ / ✋           │
        │                                       ├───────────────────────►│  gate: approver only
        │                                       │   card → Approved/Denied│  registry.resolve(id)
        │  (on grant) effect fires ◄────────────────────────────────────┤  fire() ; audit approval/grant|deny (corr=id)
        │                                       │                        │  (outbound deliver audits, same corr)
```

A pending approval that is never clicked is **auto-denied** after `ttlMs` (a periodic sweep), audited as `approval/expire`.

## 2. The registry (pure logic, in-memory, unit-tested)

```ts
// hub/approval.ts
export type ApprovalDecision = "grant" | "deny"
export type ApprovalState = "pending" | "granted" | "denied" | "expired"

export interface ApprovalRequest {
  kind: string         // "outbound" | "exec" | … (the effect class)
  target: string       // route id / command id — what will run
  actor: string        // who initiated it: "agent:<name>" | "hub"
  chat?: string        // origin conversation (for the card fallback + audit)
  summary: string      // one line: what will happen if approved
}
export interface PendingApproval extends ApprovalRequest {
  id: string
  createdAt: number
  expiresAt: number
  state: ApprovalState
  fire: () => void | Promise<void>   // the held effect, run on grant
}

class ApprovalRegistry {
  constructor(now: () => number, genId: () => string, ttlMs: number)
  request(req: ApprovalRequest, fire: () => void | Promise<void>): PendingApproval
  get(id: string): PendingApproval | undefined
  resolve(id: string, decision: ApprovalDecision): PendingApproval | null  // null ⇒ unknown/already resolved
  sweepExpired(): PendingApproval[]   // moves past-deadline entries → expired, returns them
  pendingCount(): number
}
```

- `request` stamps `createdAt`/`expiresAt` (injected `now` + `ttlMs`), stores the entry + the `fire` closure, returns it.
- `resolve` is **idempotent / single-shot**: a second click on an already-resolved id returns `null` (so a double-tap can't fire twice).
- `sweepExpired` is called on a timer; expired entries never fire.
- All deterministic — injected `now` and `genId` (no `Date.now`/random inside), unit-tested like `OutboundDelivery`.

## 3. The card (pure render + customId)

```ts
renderApprovalCard(e: PendingApproval): CardSpec     // pending → ✅/✋ buttons; terminal → buttons:[]
approvalCustomId(id, decision): string               // "approval:grant:<id>" | "approval:deny:<id>"
parseApprovalCustomId(customId): { id, decision } | null
```

- The customId fits the gateway's notify scheme `ns:action:arg` (`hub/gateway.ts`): ns `approval`, action `grant`/`deny`, arg `<id>`. `id` is short (`appr-<n>`) so it stays under Discord's 100-char button limit.
- Pending card: title "⏳ Approval required", body = `summary`, fields = `kind · target` and `requested by <actor>`, two buttons (Approve/success, Deny/danger). Terminal cards drop the buttons and restate the outcome (Approved / Denied / Expired).

## 4. Wiring (the hub integration)

1. **Construct** `ApprovalRegistry` from `approvals` config (`enabled`, `channelId`, `approvers`, `ttlMs`).
2. **Request** — a helper `requestApproval(req, fire)` calls `registry.request`, posts `renderApprovalCard` to `approvals.channelId` (falling back to `req.chat`), remembers `{channelId, messageId}` for the edit, and `audit.record({ kind:"approval", action:"request", actor:req.actor, target:req.target, chat:req.chat, outcome:"pending", corr:id })`.
3. **Gate** — extend `gateway.setNotifyButtonGate`: an `approval:*` customId is allowed only when `userId ∈ approvers` (default `[deployApproverUserId]`). Unauthorized clicks are rejected by the existing gate before any handler runs.
4. **Handle** — in `gateway.onNotifyButton`, check `parseApprovalCustomId` **first**: `resolve(id, decision)`; on `grant` run `entry.fire()`; edit the card to its terminal state; `audit.record({ kind:"approval", action: decision==="grant"?"grant":"deny", actor:\`user:<id>\`, target:entry.target, outcome: grant?"ok":"deny", corr:id })`. The fired effect (e.g. the outbound delivery) audits itself with the **same `corr`**, so the ledger threads request → grant → deliver.
5. **Sweep** — a `setInterval(...).unref()` calls `sweepExpired()`, edits each card to "Expired", and audits `approval/expire` (outcome deny).

## 5. Enforcing `requireApproval` (first consumer)

The single interception point is `deliverAudited` (`hub/index.ts`), through which all three outbound fire paths already pass:

```ts
function deliverAudited(route, body, actor, agent?, chat?) {
  if (approvalsEnabled && route.requireApproval) {
    requestApproval(
      { kind: "outbound", target: route.id, actor, chat, summary: `POST → ${route.id}` },
      () => doDeliver(route, body, actor, agent),   // the existing deliver+audit, deferred
    )
    return
  }
  doDeliver(route, body, actor, agent)
}
```

- `requireApproval` is enforced **only when `approvals.enabled`** — otherwise the flag is inert and the route fires as today (so "no config ⇒ no behaviour change" holds). This is documented; an operator who wants gating turns the subsystem on.
- The registry is generic, so `exec`/`gatedActions` can adopt the same gate later (§7) — out of scope here to keep the increment tight.

## 6. Security

- **Approver-only.** Only configured `approvers` (default the existing `deployApproverUserId`) may approve; enforced at the button gate, before the handler.
- **Fail-closed.** A held effect fires *only* on an explicit grant; deny, expiry, and hub restart all result in the effect **not** firing.
- **Single-shot.** `resolve` is idempotent — a double-click or a grant-after-deny cannot double-fire.
- **No agent self-approval.** Agents have no path to the approval buttons (no raw customId injection; the gate checks the human's Discord id).
- **Audited end to end.** request / grant / deny / expire are all `approval` events threaded by `corr`, alongside the effect's own audit row — a tamper-evident trail of who approved what.

## 7. From OK to must-have — what this seeds

- **A real action catalog.** Named outbound routes + `requireApproval` are now a *typed, gated* action catalog. Adding `exec`/ticket/page actions behind the same registry is additive.
- **Approval policies.** `ttlMs`, per-action approver sets, quorum (N-of-M) all hang off the registry without touching call sites.
- **Audit-grade governance.** With every approval threaded by `corr`, "show me every gated action this week and who approved it" is a `!audit kind:approval` query (and a metrics rollup in the next feature).

## 8. Testing

- **registry:** request stamps deadline; resolve grants/denies once (second resolve → null); sweepExpired moves only past-deadline entries; pendingCount.
- **card:** pending card has both buttons with correct customIds; terminal states drop buttons; `parseApprovalCustomId` round-trips and rejects non-approval ids.
- **enforcement (logic):** a `requireApproval` route parks instead of delivering; grant runs the held closure exactly once; deny/expire never run it. (Closure-firing verified with a spy, mirroring the `OutboundDelivery`/governor test style.)

## 9. Build order (each increment shippable, leaves the system working)

1. **approval core** (`hub/approval.ts`) — `ApprovalRegistry`, `renderApprovalCard`, customId helpers + `ApprovalConfig`/types. Pure, unit-tested.
2. **hub wiring** — construct the registry, `requestApproval` (post card + audit request), the `approval:*` button gate + handler (resolve → fire/drop → edit card → audit), and the expiry sweep.
3. **enforce `requireApproval`** — `deliverAudited` parks flagged outbound routes through the gate; the held closure fires on grant (with the same `corr`).
4. **docs + example config** — README section, `approvals` config block, and the PR.
