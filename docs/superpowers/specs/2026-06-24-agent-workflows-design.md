# Switchboard — Agent Workflows / Missions

**Date:** 2026-06-24
**Status:** Proposed design, pre-implementation
**One-liner:** Turn "one agent answers" into "a team executes." A **mission** is a declarative, multi-step pipeline — each step runs a named agent with a templated prompt, and each step's **output feeds the next** — orchestrated by the hub on hidden virtual channels, surfaced as a live progress card, and threaded end-to-end in the audit ledger. Built directly on the consult run-and-capture primitive we just merged.

---

## 0. Why this, why now

Switchboard routes a user to exactly one agent per turn. Agents can now *consult* each other (`ask_agent`) and spawn ephemerals, but there's no way to say **"research this, then have the coder implement it, then have the reviewer check it"** as one governed, repeatable unit. That sequenced, multi-agent execution is the difference between a chatbot fleet and an *operations platform* — and it's the most visceral "wow": post a goal, watch a team deliver it.

The machinery already exists. The consult feature established the exact primitive a workflow step needs: dispatch a prompt to an agent on a **virtual channel** (`consult:<id>`), intercept its reply in `onAgentReply` (never posting to Discord), and resolve a promise with the text (`ConsultRegistry` + `consultAnswerFromReply`, both merged). A mission is that primitive **chained**: run step 1, capture its output, interpolate it into step 2's prompt, run step 2, and so on — every hop an audit event threaded by the run id.

**Off by default** — no `workflows` config, no behaviour change. Operator-defined and operator-triggered, so the workflow config *is* the authorization (no per-agent consult gate needed).

New components:

| Component | Responsibility |
| --- | --- |
| **workflow core** | Pure: `renderStepPrompt` (templating), `findWorkflow`, `MissionRegistry` (run-and-capture, mirrors `ConsultRegistry`), `renderMissionCard` (live progress). |
| **mission engine** | The sequential executor in the hub: run each step on a virtual channel, capture, feed forward, update the card, audit. |
| **triggers** | `!run <id> [input]` + `!workflows` operator commands (cron/outbound triggers are a trivial follow-on). |

No new dependency, no new secret. Reuses `consultAnswerFromReply`, the `onAgentReply` interception pattern, the approval-style live card, and the audit ledger. Adds a `mission` audit kind.

---

## 1. What a mission is (config)

```jsonc
"workflows": [
  {
    "id": "ship-feature",
    "description": "research → implement → review, one governed pipeline",
    "steps": [
      { "id": "research", "agent": "research", "prompt": "Research how to {{input}}. Summarise the approach and any gotchas." },
      { "id": "implement", "agent": "assistant", "prompt": "Using this research:\n{{steps.research}}\n\nImplement: {{input}}. Describe what you changed." },
      { "id": "review", "agent": "help", "prompt": "Review this work for correctness:\n{{steps.implement}}\n\nList any issues, or say LGTM." }
    ]
  }
],
"workflow": { "enabled": true, "stepTimeoutMs": 120000 }
```

- A step's `prompt` interpolates **`{{input}}`** (the run input) and **`{{steps.<id>}}`** (any prior step's captured output).
- Steps target **persistent (registered) agents**; they run sequentially, each as one turn on a hidden channel. (Ephemeral-per-step isolation is a documented future enhancement — see §7.)

## 2. Workflow core (pure, unit-tested)

```ts
// hub/workflow.ts
export interface WorkflowStep { id: string; agent: string; prompt: string }
export interface WorkflowRoute { id: string; description?: string; enabled?: boolean; steps: WorkflowStep[] }
export interface WorkflowConfig { enabled?: boolean; stepTimeoutMs?: number }   // off unless enabled

/** Interpolate {{input}} and {{steps.<id>}} into a step prompt. Unknown refs → "". Pure. */
export function renderStepPrompt(template: string, ctx: { input: string; steps: Record<string, string> }): string

export function findWorkflow(workflows: WorkflowRoute[], id: string): WorkflowRoute | undefined

/** Run-and-capture registry for mission steps — mirrors ConsultRegistry: open a
 *  pending step on a virtual `mission:<id>` channel, settle it from the agent's
 *  reply, TTL-sweep stragglers. Injected now/genId. */
export class MissionRegistry {
  constructor(now: () => number, genId: () => string, ttlMs: number)
  open(label: string, agent: string, resolve: (out: string) => void): { id: string; channel: string }
  isMissionChannel(channel: string): boolean
  settle(channel: string, output: string): boolean    // single-shot
  sweepExpired(): { channel: string; resolve: (out: string) => void; label: string }[]
}

/** A run's live state — the engine mutates it and re-renders the card. */
export interface MissionRun {
  runId: string; workflowId: string; input: string; chatId: string
  steps: { id: string; agent: string; state: "pending" | "running" | "done" | "failed"; output?: string }[]
  state: "running" | "done" | "failed"
}
export function renderMissionCard(run: MissionRun): CardSpec   // pure → the progress card
```

- `renderStepPrompt` is the only non-trivial pure logic besides the registry — both fully unit-tested.
- `renderMissionCard` shows each step with a status glyph (⏳ pending · 🔄 running · ✅ done · ❌ failed) and a truncated output, plus the final result — the visible "wow."

## 3. The engine (hub wiring)

```
!run ship-feature "add dark mode"
   │  runWorkflow(id, input, chatId)
   ├─ post mission card (all steps ⏳)
   ├─ for each step in order:
   │     render prompt ({{input}}, {{steps.*}})  →  open MissionRegistry entry (mission:<id>)
   │     dispatcher.dispatch(step.agent, channel, synthesized turn)        ← run the step
   │     await the captured reply  (onAgentReply settles it; never hits Discord)
   │     store output, mark step done, EDIT the card, audit (mission/step, corr=runId)
   └─ post the final step's output; mark card done; audit (mission/done)
```

1. **`runWorkflow(id, input, chatId)`** — looks up the workflow, builds a `MissionRun`, posts the card, then runs steps sequentially via an internal `runStep(agent, prompt)` that opens a `MissionRegistry` entry, `dispatcher.dispatch`es the prompt on the virtual channel, and returns a promise the reply resolves. Each step: interpolate → run → capture → record → re-render.
2. **Interception** — `onAgentReply` gains a sibling of the consult check: `if (missionRegistry.isMissionChannel(reply.chatId)) { settle with consultAnswerFromReply(reply); return }` — a step reply never posts to Discord or runs the normal pipeline.
3. **Failure/timeout** — an unavailable agent or a step that exceeds `stepTimeoutMs` (the sweep) fails the step, marks the run failed, edits the card, and posts what completed. Steps are a fixed list, so no iteration cap is needed.
4. **Audit** — `mission/start`, `mission/step` (per step, `target: agent`), `mission/done` / `mission/error`, all `corr = runId`, **metadata only** (step ids/agents/outcomes, never the prompt or output text).

## 4. Triggers

- **`!run <workflow-id> [input...]`** — operator-gated (same `baseGate.listAllowed()` as `!audit`/`!status`); kicks off `runWorkflow`.
- **`!workflows`** — lists configured workflows (id, description, step count).
- Cron/outbound triggers reuse the existing `deliver` seam and are a trivial follow-on (noted, not built here).

## 5. Security & governance

- **Operator-defined & operator-triggered.** Workflows live in hub config; `!run` is allowlist-gated. The config *is* the authorization — steps don't go through the per-agent consult gate (that's for agent-initiated calls).
- **No agent-supplied routing.** Step agents/prompts are fixed in config; `{{...}}` only interpolates the run input and prior step outputs — no arbitrary agent selection at runtime.
- **Bounded.** Each step has a TTL; a stuck step fails the run rather than hanging. Concurrent runs are isolated by distinct virtual channels.
- **Audited end-to-end.** The whole pipeline is one `corr`-threaded story in the ledger — exactly what replay (the next feature) will reconstruct.
- **Off by default** — `workflow.enabled` gates the engine; absent config = inert.

## 6. From OK to must-have — what this seeds

- **Scheduled missions** — a cron entry that fires `!run` turns a workflow into a recurring autonomous job (daily report, triage sweep).
- **DAG / parallel / conditional steps** — the sequential v1 generalizes to fan-out (run steps in parallel, synthesize) and branches, without changing the capture primitive.
- **Approval-gated steps** — a step flagged `requireApproval` parks on the existing ApprovalRegistry before running — governance composes.

## 7. Boundaries (documented)

- **Persistent-agent steps (v1).** Steps dispatch to registered (persistent) agents, so a step runs as one turn in that agent's shared session (same tradeoff consult accepts). **Ephemeral-per-step isolation** — spawn a fresh agent per step via the `runSpawnTrigger` path and capture its reply — is a clean future enhancement.
- **Sequential (v1).** Steps run in order; fan-out/DAG is future.
- **Synchronous run.** A run holds until its steps complete or time out; multiple runs proceed concurrently on separate channels.

## 8. Testing

- **renderStepPrompt:** interpolates `{{input}}` and `{{steps.id}}`; unknown refs → ""; leaves other text intact.
- **MissionRegistry:** open stamps a `mission:<id>` channel + deadline; settle is single-shot; isMissionChannel; sweepExpired returns only past-deadline entries with their resolvers.
- **renderMissionCard:** pending/running/done/failed glyphs; final result shown when done; truncation.
- **findWorkflow:** by id; undefined on miss.

## 9. Build order (each increment shippable, leaves the system working)

1. **workflow core** (`hub/workflow.ts`) — types + `renderStepPrompt` + `findWorkflow` + `MissionRegistry` + `renderMissionCard`; `WorkflowConfig`/`HubConfig.workflows`; `mission` audit kind. Pure, unit-tested.
2. **mission engine** — `runWorkflow` sequential executor, `onAgentReply` interception, the TTL sweep, the live card, audit threading.
3. **triggers + docs** — `!run` / `!workflows` commands; example `workflows` config; README + PR.
