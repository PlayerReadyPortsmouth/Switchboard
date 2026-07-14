import { expect, test } from "bun:test"
import { AgentConfigPreviewRegistry } from "../agentConfigPreview"
import type { AgentConfig, AgentRegistry, WorkspaceConfig } from "../types"
import { AgentEventStream } from "./agentEvents"
import { AgentOperationsError, AgentOperationsService, type AgentActionResult, type AgentConfigCommitResult } from "./agentService"
import type { EditableAgentConfig } from "./agentViews"
import { AgentActionPreviewRegistry, IdempotencyRegistry } from "./operationPreview"

const config: AgentConfig = {
  emoji: "🧪",
  description: "Checks releases",
  mode: "persistent",
  access: { roles: ["engineering"] },
  runtime: {
    cwd: "~",
    model: "claude-sonnet-4-5",
    claudeArgs: ["--permission-prompt-tool", "private-value"],
    appendSystemPrompt: "private instructions",
  },
}

function harness(workspace: WorkspaceConfig = { features: { agents: true }, operators: ["operator"] }, failAction = false) {
  let now = 100
  let previewId = 0
  const disk: AgentRegistry = { qa: structuredClone(config) }
  const commits: Array<{ actor: string; agent: string; before: AgentConfig | null; after: AgentConfig | null; hard: boolean }> = []
  const actions: Array<{ actor: string; agent: string; action: "reset" | "restart" }> = []
  const audits: Array<{ actor: string; action: string; target: string; outcome: "ok" | "deny" | "error"; detail?: Record<string, unknown> }> = []
  const status = {
    name: "qa", emoji: "🧪", mode: "persistent" as const, alive: true, busy: false,
    queueDepth: 0, fillPct: 0.2, lastActivityMs: 90,
  }
  const hub = {
    guildIds: [], socketPath: "socket", stateDir: ".", routerModel: "router", switchThreshold: 0.5,
    defaultAgent: "qa", ephemeralTimeoutMs: 1_000, tagStyle: "prefix" as const, chatKeyScope: "user" as const,
  }
  const service = new AgentOperationsService({
    workspace,
    hub,
    readAgents: () => structuredClone(disk),
    statuses: () => ({ agents: [structuredClone(status)], overseers: [] }),
    commitConfig: async input => {
      commits.push({ actor: input.actor, agent: input.agent, before: input.before, after: input.after, hard: input.hard })
      if (input.after === null) delete disk[input.agent]
      else disk[input.agent] = structuredClone(input.after)
      return { state: "applied", restarted: input.hard ? [input.agent] : [], fullRestart: input.classification.fullRestart }
    },
    runAction: async input => {
      actions.push(input)
      if (failAction) throw new Error("runtime failed")
      return { state: "applied", agent: input.agent, action: input.action }
    },
    audit: input => audits.push(input),
    now: () => now,
    events: new AgentEventStream(),
    configPreviews: new AgentConfigPreviewRegistry(() => now, () => `config-${++previewId}`, 1_000),
    actionPreviews: new AgentActionPreviewRegistry(() => now, () => `action-${++previewId}`, 1_000),
    idempotency: new IdempotencyRegistry<AgentActionResult>(() => now, 1_000),
  })
  return { service, disk, commits, actions, audits, status, setNow: (value: number) => { now = value } }
}

function thrown(operation: () => unknown): unknown {
  try { operation() } catch (error) { return error }
  return undefined
}

test("hidden users cannot enumerate agents and viewers cannot mutate", async () => {
  const service = harness({ features: { agents: true }, viewers: ["viewer"], operators: ["operator"] }).service
  expect(thrown(() => service.list("hidden"))).toMatchObject({ status: 404, code: "not_found" })
  expect(service.list("viewer")[0]?.permissions.configure).toBe(false)
  await expect(service.previewConfig("viewer", "qa", config, "not-authorized" )).rejects.toMatchObject({ status: 403 })
})

test("disabled feature is hidden even from operators", () => {
  const service = harness({ features: { agents: false }, operators: ["operator"] }).service
  expect(thrown(() => service.list("operator"))).toMatchObject({ status: 404, code: "not_found" })
})

test("config confirm rejects disk drift without writing", async () => {
  const h = harness()
  const preview = await h.service.previewConfig("operator", "qa", { ...config, description: "changed" }, h.service.get("operator", "qa").version)
  h.disk.qa = { ...config, description: "outside edit" }
  await expect(h.service.confirmConfig("operator", "qa", preview.id, false)).rejects.toMatchObject({ status: 409, code: "stale_preview" })
  expect(h.commits).toHaveLength(0)
})

test("repeated action confirmation returns one runtime result", async () => {
  const h = harness()
  const preview = h.service.previewAction("operator", "qa", "reset")
  const first = await h.service.confirmAction("operator", "qa", preview.id, "key-1")
  const second = await h.service.confirmAction("operator", "qa", preview.id, "key-1")
  expect(second).toEqual(first)
  expect(h.actions).toEqual([{ agent: "qa", action: "reset", actor: "operator" }])
})

test("cached action results still recheck permission and feature visibility", async () => {
  const workspace: WorkspaceConfig = { features: { agents: true }, operators: ["operator"] }
  const h = harness(workspace)
  const preview = h.service.previewAction("operator", "qa", "reset")
  await h.service.confirmAction("operator", "qa", preview.id, "recheck-key")

  workspace.operators = []
  workspace.viewers = ["operator"]
  await expect(h.service.confirmAction("operator", "qa", preview.id, "recheck-key")).rejects.toMatchObject({ status: 403, code: "forbidden" })
  workspace.operators = ["operator"]
  workspace.features!.agents = false
  await expect(h.service.confirmAction("operator", "qa", preview.id, "recheck-key")).rejects.toMatchObject({ status: 404, code: "not_found" })
  expect(h.actions).toHaveLength(1)
})

test("one idempotency key cannot cross agent or action request scope", async () => {
  const h = harness()
  h.disk.ops = { ...structuredClone(config), description: "Operations" }
  const qaReset = h.service.previewAction("operator", "qa", "reset")
  const opsReset = h.service.previewAction("operator", "ops", "reset")
  const qaRestart = h.service.previewAction("operator", "qa", "restart")

  await h.service.confirmAction("operator", "qa", qaReset.id, "shared-key")
  await h.service.confirmAction("operator", "ops", opsReset.id, "shared-key")
  await h.service.confirmAction("operator", "qa", qaRestart.id, "shared-key")

  expect(h.actions.map(({ agent, action }) => ({ agent, action }))).toEqual([
    { agent: "qa", action: "reset" },
    { agent: "ops", action: "reset" },
    { agent: "qa", action: "restart" },
  ])
})

test("opaque configured values preserve their live values before classification", async () => {
  const h = harness()
  const editable = h.service.get("operator", "qa").config
  const preview = await h.service.previewConfig("operator", "qa", { ...editable, description: "changed" }, h.service.get("operator", "qa").version)
  expect(preview.classification.fullRestart).not.toContain("unapplied:runtime.claudeArgs")
  await h.service.confirmConfig("operator", "qa", preview.id, false)
  expect(h.commits[0]?.after?.runtime.claudeArgs).toEqual(config.runtime.claudeArgs)
  expect(h.commits[0]?.after?.runtime.appendSystemPrompt).toBe(config.runtime.appendSystemPrompt)
})

test("opaque configured values require a matching live value", async () => {
  const h = harness()
  delete h.disk.qa.runtime.appendSystemPrompt
  const submitted = structuredClone(config) as unknown as EditableAgentConfig
  submitted.runtime.appendSystemPrompt = { redacted: true, configured: true }
  await expect(h.service.previewConfig("operator", "qa", submitted, h.service.get("operator", "qa").version)).rejects.toMatchObject({ status: 400, code: "configured_value_missing" })
})

test("legacy operations bypass only the feature flag", async () => {
  const h = harness({ features: { agents: false }, viewers: ["viewer"], operators: ["operator"] })
  expect(h.service.listLegacyConfigs("viewer").qa?.description).toBe(config.description)
  await expect(h.service.previewLegacyConfig("viewer", "qa", config)).rejects.toMatchObject({ status: 403 })
  const preview = await h.service.previewLegacyConfig("operator", "qa", { ...config, description: "legacy edit" })
  expect(Object.keys(preview).sort()).toEqual(["after", "before", "classification", "id"])
  await h.service.confirmLegacyConfig("operator", "qa", preview.id, false)
  expect(h.disk.qa?.description).toBe("legacy edit")
})

test("changed action status rejects before runtime work", async () => {
  const h = harness()
  const preview = h.service.previewAction("operator", "qa", "restart")
  h.status.busy = true
  h.status.queueDepth = 2
  await expect(h.service.confirmAction("operator", "qa", preview.id, "key-2")).rejects.toMatchObject({ status: 409, code: "action_state_changed" })
  expect(h.actions).toHaveLength(0)
})

test("action confirmation maps non-drift preview misses to preview_not_found and consumes mismatches", async () => {
  const workspace: WorkspaceConfig = { features: { agents: true }, operators: ["operator", "other"] }
  const h = harness(workspace)
  h.disk.ops = { ...structuredClone(config), description: "Operations" }

  await expect(h.service.confirmAction("operator", "qa", "unknown", "unknown-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })

  const expired = h.service.previewAction("operator", "qa", "reset")
  h.setNow(1_100)
  await expect(h.service.confirmAction("operator", "qa", expired.id, "expired-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })

  h.setNow(100)
  const wrongActor = h.service.previewAction("operator", "qa", "reset")
  await expect(h.service.confirmAction("other", "qa", wrongActor.id, "actor-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })
  await expect(h.service.confirmAction("operator", "qa", wrongActor.id, "actor-owner-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })

  const wrongAgent = h.service.previewAction("operator", "qa", "restart")
  await expect(h.service.confirmAction("operator", "ops", wrongAgent.id, "agent-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })
  await expect(h.service.confirmAction("operator", "qa", wrongAgent.id, "agent-owner-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })

  const consumed = h.service.previewAction("operator", "qa", "reset")
  await h.service.confirmAction("operator", "qa", consumed.id, "consumed-key")
  await expect(h.service.confirmAction("operator", "qa", consumed.id, "different-key")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })
})

test("malformed submitted runtime is rejected as invalid_config without raw exceptions", async () => {
  const h = harness()
  const missingRuntime = { ...structuredClone(config), runtime: undefined } as unknown as AgentConfig
  const nullRuntime = { ...structuredClone(config), runtime: null } as unknown as AgentConfig

  const version = h.service.get("operator", "qa").version
  await expect(h.service.previewConfig("operator", "qa", missingRuntime, version)).rejects.toMatchObject({ status: 400, code: "invalid_config" })
  await expect(h.service.previewConfig("operator", "qa", nullRuntime, version)).rejects.toMatchObject({ status: 400, code: "invalid_config" })
})

test("mutation audit details stay sanitized on success, deny, and callback failure", async () => {
  const h = harness({ features: { agents: true }, viewers: ["viewer"], operators: ["operator"] })
  await expect(h.service.previewConfig("viewer", "qa", config, "not-authorized")).rejects.toBeInstanceOf(AgentOperationsError)
  await h.service.previewConfig("operator", "qa", { ...config, description: "safe audit" }, h.service.get("operator", "qa").version)
  const serialized = JSON.stringify(h.audits)
  expect(serialized).not.toContain("private-value")
  expect(serialized).not.toContain("private instructions")
  expect(h.audits.map(row => row.outcome)).toEqual(["deny", "ok"])
})

test("validation and stale-state failures audit as errors rather than authorization denies", async () => {
  const h = harness()
  const submitted = structuredClone(config) as unknown as EditableAgentConfig
  submitted.runtime.appendSystemPrompt = { redacted: true, configured: true }
  delete h.disk.qa.runtime.appendSystemPrompt
  await expect(h.service.previewConfig("operator", "qa", submitted, h.service.get("operator", "qa").version)).rejects.toMatchObject({ code: "configured_value_missing" })
  expect(h.audits.at(-1)?.outcome).toBe("error")
})

test("legacy list redacts viewer and operator secrets and hides unauthorized users", () => {
  const h = harness({ features: { agents: false }, viewers: ["viewer"], operators: ["operator"] })
  const viewer = h.service.listLegacyConfigs("viewer").qa!
  const operator = h.service.listLegacyConfigs("operator").qa!
  expect(viewer.runtime.cwd).toBe("[redacted]")
  expect(viewer.runtime).not.toHaveProperty("claudeArgs")
  expect(viewer.runtime).not.toHaveProperty("appendSystemPrompt")
  expect(operator.runtime.cwd).toBe("~")
  expect(operator.runtime.claudeArgs).toEqual({ redacted: true, configured: true })
  expect(operator.runtime.appendSystemPrompt).toEqual({ redacted: true, configured: true })
  expect(thrown(() => h.service.listLegacyConfigs("hidden"))).toMatchObject({ status: 404 })
})

test("server rejects exhaustive malformed editable config shapes", async () => {
  const h = harness()
  const malformed = [
    { ...config, access: { roles: "*" } },
    { ...config, access: { roles: ["ok"], users: [1] } },
    { ...config, runtime: { ...config.runtime, injectContext: "sometimes" } },
    { ...config, runtime: { ...config.runtime, maxQueueDepth: -1 } },
    { ...config, runtime: { ...config.runtime, pool: { min: 3, max: 1 } } },
    { ...config, runtime: { ...config.runtime, claudeArgs: { redacted: true } } },
  ]
  for (const submitted of malformed) {
    await expect(h.service.previewConfig("operator", "qa", submitted as never, h.service.get("operator", "qa").version)).rejects.toMatchObject({ status: 400, code: "invalid_config" })
  }
})

test("config preview rejects a stale editor base before issuing a token", async () => {
  const h = harness()
  const base = h.service.get("operator", "qa").version
  h.disk.qa.description = "changed elsewhere"
  await expect(h.service.previewConfig("operator", "qa", config, base)).rejects.toMatchObject({ status: 409, code: "stale_config" })
})

test("operations config preview requires a non-empty editor base version", async () => {
  const h = harness()
  await expect(h.service.previewConfig("operator", "qa", config, "")).rejects.toMatchObject({ status: 400, code: "invalid_expected_version" })
  await expect((h.service.previewConfig as any)("operator", "qa", config)).rejects.toMatchObject({ status: 400, code: "invalid_expected_version" })
})

test("server rejects unknown editable keys recursively", async () => {
  const h = harness({ features: { agents: true }, viewers: ["viewer"], operators: ["operator"] })
  const cases = [
    { ...config, surprise: true },
    { ...config, access: { ...config.access, unexpected: ["x"] } },
    { ...config, runtime: { ...config.runtime, env: { API_TOKEN: "secret" } } },
    { ...config, runtime: { ...config.runtime, overseer: { enabled: true, extra: true } } },
    { ...config, runtime: { ...config.runtime, sessionGovernor: { enabled: true, extra: true } } },
    { ...config, runtime: { ...config.runtime, pool: { min: 1, max: 2, extra: true } } },
  ]
  const version = h.service.get("operator", "qa").version
  for (const submitted of cases) await expect(h.service.previewConfig("operator", "qa", submitted as never, version)).rejects.toMatchObject({ status: 400, code: "invalid_config" })
  expect(JSON.stringify(h.audits)).not.toContain("API_TOKEN")
  expect(JSON.stringify(h.service.get("viewer", "qa"))).not.toContain("API_TOKEN")
})

test("existing unknown runtime keys are excluded from viewer projections and audit evidence", async () => {
  const h = harness({ features: { agents: true }, viewers: ["viewer"], operators: ["operator"] })
  ;(h.disk.qa.runtime as unknown as Record<string, unknown>).env = { API_TOKEN: "disk-secret" }
  expect(JSON.stringify(h.service.get("viewer", "qa"))).not.toContain("API_TOKEN")
  const submitted = h.service.get("operator", "qa").config
  await h.service.previewConfig("operator", "qa", submitted, h.service.get("operator", "qa").version)
  expect(JSON.stringify(h.audits)).not.toContain("API_TOKEN")
  expect(JSON.stringify(h.audits)).not.toContain("disk-secret")
})

test("existing unknown nested keys are excluded from every projection and audit level", async () => {
  const h = harness({ features: { agents: true }, viewers: ["viewer"], operators: ["operator"] })
  ;(h.disk.qa.access as unknown as Record<string, unknown>).credentials = { API_TOKEN: "access-secret" }
  h.disk.qa.runtime.overseer = { enabled: true }
  ;(h.disk.qa.runtime.overseer as unknown as Record<string, unknown>).credentials = { API_TOKEN: "overseer-secret" }
  h.disk.qa.runtime.sessionGovernor = { enabled: true }
  ;(h.disk.qa.runtime.sessionGovernor as unknown as Record<string, unknown>).credentials = { API_TOKEN: "governor-secret" }
  h.disk.qa.runtime.pool = { min: 1, max: 2 }
  ;(h.disk.qa.runtime.pool as unknown as Record<string, unknown>).credentials = { API_TOKEN: "pool-secret" }

  for (const actor of ["viewer", "operator"]) {
    const serialized = JSON.stringify(h.service.get(actor, "qa"))
    expect(serialized).not.toContain("credentials")
    expect(serialized).not.toContain("API_TOKEN")
    expect(serialized).not.toContain("-secret")
  }

  const submitted = h.service.get("operator", "qa").config
  await h.service.previewConfig("operator", "qa", submitted, h.service.get("operator", "qa").version)
  const audit = JSON.stringify(h.audits)
  expect(audit).not.toContain("credentials")
  expect(audit).not.toContain("API_TOKEN")
  expect(audit).not.toContain("-secret")
})

test("audit classifies opaque replacements by path without storing either value", async () => {
  const h = harness()
  const submitted = h.service.get("operator", "qa").config
  submitted.runtime.claudeArgs = ["--replacement-secret"]
  submitted.runtime.appendSystemPrompt = "replacement prompt secret"
  const preview = await h.service.previewConfig("operator", "qa", submitted, h.service.get("operator", "qa").version)
  const audit = h.audits.find(row => row.detail?.previewId === preview.id)!
  expect(audit.detail?.diff).toEqual(expect.arrayContaining(["runtime.claudeArgs", "runtime.appendSystemPrompt"]))
  const serialized = JSON.stringify(audit)
  expect(serialized).not.toContain("private-value")
  expect(serialized).not.toContain("private instructions")
  expect(serialized).not.toContain("replacement-secret")
  expect(serialized).not.toContain("replacement prompt secret")
})

test("pooled runtime actions conflict without runtime work or successful audit", () => {
  const h = harness()
  h.disk.qa.runtime.pool = { min: 1, max: 2 }
  expect(thrown(() => h.service.previewAction("operator", "qa", "restart"))).toMatchObject({ status: 409, code: "action_unavailable" })
  expect(h.actions).toHaveLength(0)
  expect(h.audits.at(-1)?.outcome).not.toBe("ok")
})

test("definitive runtime failure consumes the preview without completion evidence", async () => {
  const h = harness(undefined, true)
  const events: string[] = []
  h.service.subscribe(0, event => events.push(event.kind))
  const preview = h.service.previewAction("operator", "qa", "restart")
  await expect(h.service.confirmAction("operator", "qa", preview.id, "runtime-failure")).rejects.toMatchObject({ status: 500, code: "runtime_failure" })
  await expect(h.service.confirmAction("operator", "qa", preview.id, "new-request")).rejects.toMatchObject({ status: 409, code: "preview_not_found" })
  expect(events).not.toContain("action_completed")
  expect(h.audits.filter(row => row.action === "agent_action_confirm").map(row => row.outcome)).toEqual(["error", "error"])
})

test("config preview and confirmation audits include redacted correlated evidence", async () => {
  const h = harness()
  const next = h.service.get("operator", "qa").config
  next.description = "audited change"
  const preview = await h.service.previewConfig("operator", "qa", next, h.service.get("operator", "qa").version)
  await h.service.confirmConfig("operator", "qa", preview.id, false)
  const serialized = JSON.stringify(h.audits)
  expect(serialized).toContain(preview.id)
  expect(serialized).toContain("description")
  expect(serialized).toContain("classification")
  expect(serialized).not.toContain("private-value")
  expect(serialized).not.toContain("private instructions")
})
