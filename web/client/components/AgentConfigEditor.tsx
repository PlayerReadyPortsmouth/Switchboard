import { useEffect, useState } from "react"
import { ApiError } from "../api"
import type { AgentConfigCommitResult, AgentConfigPreview, EditableAgentConfig, RedactedConfiguredValue } from "../types"

export interface AgentConfigApi {
  previewAgentConfig(agent: string, config: EditableAgentConfig | null): Promise<AgentConfigPreview>
  confirmAgentConfig(agent: string, previewId: string, hard: boolean): Promise<AgentConfigCommitResult>
}

const configuredSentinel = (value: unknown): value is RedactedConfiguredValue => {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2 && record.redacted === true && record.configured === true
}

function configValidationError(value: unknown, original: EditableAgentConfig): string | null {
  if (!value || typeof value !== "object") return "Configuration must match the documented agent shape."
  const config = value as Record<string, unknown>
  if (typeof config.emoji !== "string" || typeof config.description !== "string" || !["persistent", "ephemeral"].includes(String(config.mode))) return "Configuration must match the documented agent shape."
  if (!config.access || typeof config.access !== "object" || !Array.isArray((config.access as { roles?: unknown }).roles) || !(config.access as { roles: unknown[] }).roles.every(role => typeof role === "string")) return "Configuration access roles must be a string array."
  if (!config.runtime || typeof config.runtime !== "object") return "Configuration must match the documented agent shape."
  const runtime = config.runtime as Record<string, unknown>
  if (typeof runtime.cwd !== "string") return "Configuration must match the documented agent shape."
  if (runtime.model !== undefined && typeof runtime.model !== "string") return "Configuration runtime model must be a string."
  if (runtime.resumable !== undefined && typeof runtime.resumable !== "boolean") return "Configuration resumable must be true or false."
  if (runtime.useMemory !== undefined && typeof runtime.useMemory !== "boolean") return "Configuration memory must be true or false."
  if (runtime.injectContext !== undefined && !["always", "onSwitch", "never"].includes(String(runtime.injectContext))) return "Configuration context injection must be always, onSwitch, or never."
  if (runtime.maxQueueDepth !== undefined && (!Number.isFinite(runtime.maxQueueDepth) || !Number.isInteger(runtime.maxQueueDepth) || Number(runtime.maxQueueDepth) < 0)) return "Configuration queue depth must be a non-negative integer."
  if (runtime.pool !== undefined) {
    if (!runtime.pool || typeof runtime.pool !== "object" || Array.isArray(runtime.pool)) return "Configuration pool must be an object."
    const pool = runtime.pool as Record<string, unknown>
    for (const key of ["min", "max", "scaleUpQueue", "scaleUpSustainMs", "replicaIdleMs"] as const) {
      const entry = pool[key]
      if (entry !== undefined && (!Number.isFinite(entry) || !Number.isInteger(entry) || Number(entry) < 0)) return `Configuration pool ${key} must be a non-negative integer.`
    }
    if (pool.isolateCwd !== undefined && typeof pool.isolateCwd !== "boolean") return "Configuration pool isolateCwd must be true or false."
    if (typeof pool.min === "number" && typeof pool.max === "number" && pool.min > pool.max) return "Configuration pool minimum cannot exceed maximum."
  }
  const args = runtime.claudeArgs
  if (configuredSentinel(args) && !configuredSentinel(original.runtime.claudeArgs)) return "Configured values can only preserve a value already configured on the server."
  if (args !== undefined && !configuredSentinel(args) && !(Array.isArray(args) && args.every(item => typeof item === "string"))) return "Claude arguments must be a string array or the unchanged configured value."
  const prompt = runtime.appendSystemPrompt
  if (configuredSentinel(prompt) && !configuredSentinel(original.runtime.appendSystemPrompt)) return "Configured values can only preserve a value already configured on the server."
  if (prompt !== undefined && !configuredSentinel(prompt) && typeof prompt !== "string") return "Appended system prompt must be a string or the unchanged configured value."
  return null
}

const confirmCopy = { safe: "Apply changes", hard: "Apply and restart agent", restart: "Save pending hub restart" } as const
const classificationHeading = { safe: "Changes can apply live", hard: "Agent restart required", restart: "Full hub restart required" } as const

export function AgentConfigEditor({ agent, config, api, online, onApplied, onReload }: {
  agent: string
  config: EditableAgentConfig
  api: AgentConfigApi
  online: boolean
  onApplied(result: AgentConfigCommitResult): void
  onReload(): void
}) {
  const [mode, setMode] = useState<"guided" | "advanced">("guided")
  const [draft, setDraft] = useState(config)
  const [json, setJson] = useState(() => JSON.stringify(config, null, 2))
  const [jsonError, setJsonError] = useState("")
  const [preview, setPreview] = useState<AgentConfigPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    setDraft(config); setJson(JSON.stringify(config, null, 2)); setJsonError(""); setPreview(null); setError("")
  }, [agent])

  const replaceDraft = (next: EditableAgentConfig) => {
    setDraft(next); setJson(JSON.stringify(next, null, 2)); setJsonError(""); setPreview(null); setError("")
  }
  const runtime = (next: Partial<EditableAgentConfig["runtime"]>) => replaceDraft({ ...draft, runtime: { ...draft.runtime, ...next } })
  const changeJson = (next: string) => {
    setJson(next); setPreview(null); setError("")
    try {
      const parsed: unknown = JSON.parse(next)
      const validationError = configValidationError(parsed, config)
      if (validationError) { setJsonError(validationError); return }
      setDraft(parsed as EditableAgentConfig); setJsonError("")
    } catch { setJsonError("Enter valid JSON before previewing changes.") }
  }
  const requestPreview = async () => {
    setBusy(true); setError(""); setPreview(null)
    try { setPreview(await api.previewAgentConfig(agent, draft)) }
    catch { setError("Configuration preview failed. Check the connection and try again.") }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!preview || !online) return
    setBusy(true); setError("")
    try { onApplied(await api.confirmAgentConfig(agent, preview.id, preview.classification.tier === "hard")) }
    catch (cause) {
      setPreview(null)
      setError(cause instanceof ApiError && cause.status === 409
        ? "The current configuration changed after this preview. Reload current configuration, review the preserved draft, then preview again."
        : "Configuration was not saved. Review the draft and try the preview again.")
    } finally { setBusy(false) }
  }

  const argsConfigured = configuredSentinel(draft.runtime.claudeArgs)
  const promptConfigured = configuredSentinel(draft.runtime.appendSystemPrompt)
  return <section className="agent-config-editor" aria-label="Agent configuration">
    <header className="config-mode-switch" aria-label="Configuration editor mode">
      <button type="button" aria-pressed={mode === "guided"} onClick={() => setMode("guided")}>Guided</button>
      <button type="button" aria-pressed={mode === "advanced"} onClick={() => setMode("advanced")}>Advanced JSON</button>
    </header>
    {mode === "guided" ? <div className="config-guided-grid">
      <label>Emoji<input aria-label="Emoji" value={draft.emoji} onChange={event => replaceDraft({ ...draft, emoji: event.currentTarget.value })} /></label>
      <label className="config-wide">Description<input aria-label="Description" value={draft.description} onChange={event => replaceDraft({ ...draft, description: event.currentTarget.value })} /></label>
      <label>Mode<select aria-label="Mode" value={draft.mode} onChange={event => replaceDraft({ ...draft, mode: event.currentTarget.value as EditableAgentConfig["mode"] })}><option value="persistent">Persistent</option><option value="ephemeral">Ephemeral</option></select></label>
      <label>Access roles<input aria-label="Access roles" value={draft.access.roles.join(", ")} onChange={event => replaceDraft({ ...draft, access: { ...draft.access, roles: event.currentTarget.value.split(",").map(value => value.trim()).filter(Boolean) } })} /></label>
      <label>Runtime model<input aria-label="Runtime model" value={draft.runtime.model ?? ""} onChange={event => runtime({ model: event.currentTarget.value || undefined })} /></label>
      <label className="config-wide">Working directory<input aria-label="Working directory" value={draft.runtime.cwd} onChange={event => runtime({ cwd: event.currentTarget.value })} /></label>
      <label>Context injection<select aria-label="Context injection" value={draft.runtime.injectContext ?? "onSwitch"} onChange={event => runtime({ injectContext: event.currentTarget.value as "always" | "onSwitch" | "never" })}><option value="always">Always</option><option value="onSwitch">On switch</option><option value="never">Never</option></select></label>
      <label>Queue depth<input aria-label="Queue depth" type="number" min="0" value={draft.runtime.maxQueueDepth ?? ""} onChange={event => runtime({ maxQueueDepth: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label>
      <label>Pool minimum<input aria-label="Pool minimum" type="number" min="0" value={draft.runtime.pool?.min ?? ""} onChange={event => runtime({ pool: { ...draft.runtime.pool, min: event.currentTarget.value ? Number(event.currentTarget.value) : undefined } })} /></label>
      <label>Pool maximum<input aria-label="Pool maximum" type="number" min="0" value={draft.runtime.pool?.max ?? ""} onChange={event => runtime({ pool: { ...draft.runtime.pool, max: event.currentTarget.value ? Number(event.currentTarget.value) : undefined } })} /></label>
      <label className="config-check"><input aria-label="Resumable" type="checkbox" checked={draft.runtime.resumable ?? false} onChange={event => runtime({ resumable: event.currentTarget.checked })} />Resumable sessions</label>
      <label className="config-check"><input aria-label="Memory" type="checkbox" checked={draft.runtime.useMemory ?? false} onChange={event => runtime({ useMemory: event.currentTarget.checked })} />Use memory</label>
      <label className="config-wide">Claude arguments{argsConfigured ? <span className="configured-sentinel">Configured · preserved</span> : null}<input aria-label="Claude arguments" placeholder={argsConfigured ? "Replace with one argument per line" : "One argument per line"} value={Array.isArray(draft.runtime.claudeArgs) ? draft.runtime.claudeArgs.join("\n") : ""} onChange={event => runtime({ claudeArgs: event.currentTarget.value ? event.currentTarget.value.split("\n") : argsConfigured ? draft.runtime.claudeArgs : undefined })} /></label>
      <label className="config-wide">Appended system prompt{promptConfigured ? <span className="configured-sentinel">Configured · preserved</span> : null}<textarea aria-label="Appended system prompt" placeholder={promptConfigured ? "Enter a replacement to change the configured value" : "Optional prompt"} value={typeof draft.runtime.appendSystemPrompt === "string" ? draft.runtime.appendSystemPrompt : ""} onChange={event => runtime({ appendSystemPrompt: event.currentTarget.value || (promptConfigured ? draft.runtime.appendSystemPrompt : undefined) })} /></label>
    </div> : <label className="config-json-label">Agent configuration JSON<textarea aria-label="Agent configuration JSON" spellCheck={false} value={json} onInput={event => changeJson(event.currentTarget.value)} /></label>}
    {jsonError ? <p className="form-error" role="alert">{jsonError}</p> : null}
    {error ? <div className="config-recovery" role="alert"><p>{error}</p>{error.includes("current configuration changed") ? <button type="button" onClick={onReload}>Reload current configuration</button> : null}</div> : null}
    {!online ? <p className="config-offline">Reconnect to preview and apply this local draft.</p> : null}
    <div className="config-editor-actions"><button type="button" disabled={!online || Boolean(jsonError) || busy} onClick={() => void requestPreview()}>{busy && !preview ? "Previewing…" : "Preview changes"}</button></div>
    {preview ? <section className="config-impact-ledger" aria-label="Configuration impact">
      <header><p className="eyebrow">Server classification</p><h4>{classificationHeading[preview.classification.tier]}</h4></header>
      <div className="config-diff"><div><strong>Before</strong><pre>{JSON.stringify(preview.before, null, 2)}</pre></div><div><strong>After</strong><pre>{JSON.stringify(preview.after, null, 2)}</pre></div></div>
      {preview.classification.fullRestart.length ? <div className="restart-reasons"><strong>Pending restart reasons</strong><ul>{preview.classification.fullRestart.map(reason => <li key={reason}>{reason}</li>)}</ul></div> : null}
      <div className="config-editor-actions"><button type="button" disabled={busy || !online} onClick={() => void confirm()}>{busy ? "Applying…" : confirmCopy[preview.classification.tier]}</button></div>
    </section> : null}
  </section>
}
