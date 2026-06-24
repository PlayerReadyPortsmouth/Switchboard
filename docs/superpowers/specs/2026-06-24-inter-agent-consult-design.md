# Switchboard — Inter-Agent Consult (`ask_agent`)

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Let one agent **consult another and get the answer back** — a governed `ask_agent` MCP tool where agent A asks a named agent B a question, the hub runs B and returns its reply into A's tool call. Built on the one request/response seam the shim already has (`recall`), gated per-agent, and recorded in the audit ledger as a `consult` event.

---

## 0. Why this, why now

Agents in Switchboard are **islands**. The router picks exactly one agent per user turn; agents can spawn ephemerals (`spawnTriggers`, fire-and-forget, both reply to the same Discord channel) and call external systems (`post_webhook`) — but there is **no way for agent A to ask agent B a question and use the answer**. A coding agent can't ask the ops agent "is prod healthy?"; a triage agent can't delegate a sub-question to a specialist and continue.

The machinery to do this already exists, just not wired together: `recall` is a **request/response** shim tool (agent calls it, the shim sends a socket message with an `id`, the hub computes asynchronously, writes the result back over the same socket, the shim resolves the agent's tool call). `deliverToAgent` already injects a synthesized inbound into any agent. We combine them: `ask_agent` dispatches A's question to B on a **virtual channel**, intercepts B's reply before it reaches Discord, and returns its text to A.

Like every other capability, this is **opt-in and governed**: an agent is consultable only if its config says so (`access.consultableBy`), every consult is an audit event, and there's no agent-supplied routing it can abuse.

New components:

| Component | Responsibility |
| --- | --- |
| **`ask_agent` shim tool** | Agent-facing MCP tool `{ agent, message }`, request/response over the socket (modelled on `recall`). |
| **`mayConsult`** | Pure access check: may requester A consult target B? (`access.consultableBy`, `"*"`, no self-consult). |
| **ConsultRegistry** | Pending consults keyed by a virtual channel id; settle on B's reply, time out otherwise. |
| **consult wiring** | The hub handler: access-check → audit → dispatch to B on `consult:<id>` → intercept B's reply in `onAgentReply` → write the answer back to A. |

No new dependency, no new secret. The `consult` audit kind joins the existing union; the tool is **exposed only when `consult.enabled`**, so with it off agents don't even see it — zero behaviour change.

---

## 1. The flow

```
Agent A                         Hub                          Agent B
  │  ask_agent{agent:B,message}   │                            │
  ├──────────────(socket id=q1)──►│ mayConsult(A,B)?           │
  │                               │ audit consult/ask (corr=q1)│
  │                               │ deliverToAgent(B, "consult:q1", message)
  │                               ├───────────────────────────►│ (B runs a turn)
  │                               │   reply{chatId:"consult:q1"}│
  │                               │◄───────────────────────────┤
  │                               │ onAgentReply intercepts the │
  │   ask_agent_result(id=q1) ◄───┤ virtual channel → settle    │
  │   tool returns B's text       │ audit consult/answer (corr=q1)
```

- **Virtual channel.** B is dispatched with `chatId = "consult:<id>"`. B's reply carries that chatId (stamped at delivery, like every reply), so `onAgentReply` recognizes it, settles the pending consult, and **returns without posting to Discord** and without running B's spawn-trigger / outbound / governor / overseer pipeline.
- **Correlation.** The shim holds a pending promise keyed by `id` (exactly as `recall` does); the hub keys the pending consult by the virtual channel. One `id`/channel ↔ one consult.

## 2. Access (pure, unit-tested)

```ts
// hub/consult.ts
export function mayConsult(requester: string, target: AgentConfig | undefined): boolean
```

- New optional field `access.consultableBy?: string[]` on `AgentConfig.access` — the agent names allowed to consult this agent; `"*"` means any agent.
- **Default deny:** absent/empty ⇒ not consultable. A **self-consult is always denied** (`requester === target` → false) to remove the simplest deadlock.
- Mirrors the existing user-facing `permittedAgents` model (`hub/access.ts`), one level over.

## 3. ConsultRegistry (in-memory, injected clock, unit-tested)

```ts
export interface PendingConsult {
  id: string; channel: string        // "consult:<id>"
  requester: string; target: string
  createdAt: number; expiresAt: number
  resolve: (answer: string) => void  // writes ask_agent_result back to A's socket
}
class ConsultRegistry {
  constructor(now: () => number, genId: () => string, ttlMs: number)
  open(requester: string, target: string, resolve: (answer: string) => void): PendingConsult
  isConsultChannel(channel: string): boolean
  settle(channel: string, answer: string): PendingConsult | null   // single-shot; calls resolve
  sweepExpired(): PendingConsult[]                                  // past-deadline; caller resolves with a timeout note
  pendingCount(): number
}
```

- `settle` is **single-shot** (B's first reply wins; a later turn on a freed channel is a no-op).
- `sweepExpired` returns timed-out consults so the wiring can `resolve("(agent <B> did not respond in time)")` and audit a `timeout`. The hub TTL is < the shim's tool timeout, so the agent always gets a definite answer.

## 4. Shim tool + socket (the `recall` pattern, extended)

- **Tool** `ask_agent({ agent, message })` in `shim/server.ts`, **exposed only when `process.env.CONSULT === "1"`** (set by the hub's MCP config when `consult.enabled`). Request/response like `recall`, with a longer timeout (B runs a full turn): the shim sends `{ t:"ask_agent", id, agent, message }`, awaits, and returns the answer text (or a timeout sentinel).
- **Socket** kinds `ask_agent` / `ask_agent_result` in `hub/transports/shimSocket.ts`, plus `onAskAgent(cb)` — an **async** callback (unlike the fire-and-forget kinds) whose resolved string is written back as `{ t:"ask_agent_result", id, answer }`.

## 5. Hub wiring

1. **Handler** (registered per agent A's socket in `makeTransport`): `onAskAgent({ id, agent: B, message })` →
   - `mayConsult(A, agents[B])`? No → audit `consult/ask` `outcome:"deny"`, return a denial string.
   - Yes → audit `consult/ask` (`actor:agent:A`, `target:B`, `corr:id`, `outcome:"ok"`); `registry.open(A, B, resolve)` where `resolve(answer)` writes `ask_agent_result` and audits `consult/answer`; `deliverToAgent(B, channel, "consult:"+A, message)`.
2. **Interception** in `onAgentReply` (very top): `if (consults.isConsultChannel(reply.chatId)) { if reply is text → settle; return }` — a consult turn never posts to Discord and never runs B's reply pipeline.
3. **Sweep** — `setInterval` calls `sweepExpired()`, resolves each with a timeout note, audits `consult/timeout`.

## 6. Audit & governance

- New `AuditKind` member **`consult`**. Events: `ask` (`ok`/`deny`), `answer` (`ok`), `timeout` (`error`) — `actor:agent:<A>`, `target:<B>`, threaded by `corr = id`. **Metadata only** — the question/answer text is never logged (lengths/outcome only), consistent with the ledger's no-content rule.
- **Governed, not free.** No agent-supplied channel or transport; A names B, the hub owns dispatch. Default-deny via `consultableBy`. The whole feature is behind `consult.enabled` (tool not even exposed when off).

## 7. Boundaries (documented)

- **Synchronous & blocking:** A's turn is held while it waits (≤ `timeoutMs`); A holds its turn-gate slot. The TTL bounds it.
- **Shared session:** consulting B injects a turn into B's existing session/context (B is one process), serialized by B's turn gate — not an isolated sub-agent. (An isolated-spawn variant is future work.)
- **Cycles/depth:** self-consult is denied; a mutual A↔B cycle is broken by the timeout. A hard depth cap is future work.
- **Handoff** (A hands the *user* conversation to B) is a separate, simpler mode — out of scope here; `ask_agent` is the consult primitive it would build on.

## 8. Testing

- **mayConsult:** allow on listed name / `"*"`; deny on absent/empty / self / unknown target.
- **ConsultRegistry:** `open` stamps channel+deadline; `settle` is single-shot and calls resolve once; `isConsultChannel`; `sweepExpired` returns only past-deadline; `pendingCount`.
- **shim wire:** `ask_agent` maps to the right socket message; `onAskAgent` resolution writes `ask_agent_result` with the id.

## 9. Build order (each increment shippable, leaves the system working)

1. **consult core** (`hub/consult.ts`) — `mayConsult` + `ConsultRegistry` + `ConsultConfig`/`access.consultableBy` types. Pure, unit-tested.
2. **shim tool + socket** — `ask_agent` tool (env-gated) in `shim/server.ts`; `ask_agent`/`ask_agent_result` kinds + `onAskAgent` in `shimSocket.ts`; wire tests.
3. **hub wiring + audit + docs** — the `onAskAgent` handler, `onAgentReply` interception, the sweep, the `consult` audit kind, `consult.enabled` + the MCP `CONSULT` env, README + PR.
