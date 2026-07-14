import { useEffect, useRef, useState } from "react"
import { ApiError } from "../api"
import type { AgentConfigCommitResult, AgentConfigPreview, EditableAgentConfig, RedactedConfiguredValue } from "../types"
import { editableAgentConfigError, isConfiguredValueSentinel } from "../../../hub/operations/editableAgentConfigValidation"

export interface AgentConfigApi {
  previewAgentConfig(agent: string, config: EditableAgentConfig | null, expectedVersion: string): Promise<AgentConfigPreview>
  confirmAgentConfig(agent: string, previewId: string, hard: boolean): Promise<AgentConfigCommitResult>
}

const configuredSentinel = isConfiguredValueSentinel as (value: unknown) => value is RedactedConfiguredValue

const confirmCopy = { safe: "Apply changes", hard: "Apply and restart agent", restart: "Save pending hub restart" } as const
const classificationHeading = { safe: "Changes can apply live", hard: "Agent restart required", restart: "Full hub restart required" } as const

export function AgentConfigEditor({ agent, config, baseVersion, api, online, onApplied, onReload }: {
  agent: string
  config: EditableAgentConfig
  baseVersion: string
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
  const [staleDraft, setStaleDraft] = useState(false)
  const [originVersion, setOriginVersion] = useState(baseVersion)
  const sourceRef = useRef(config)
  const draftRef = useRef(config)

  useEffect(() => {
    sourceRef.current = config; draftRef.current = config; setOriginVersion(baseVersion); setStaleDraft(false)
    setDraft(config); setJson(JSON.stringify(config, null, 2)); setJsonError(""); setPreview(null); setError("")
  }, [agent])

  useEffect(() => {
    if (baseVersion === originVersion) return
    if (JSON.stringify(draftRef.current) !== JSON.stringify(sourceRef.current)) { setStaleDraft(true); setPreview(null); return }
    sourceRef.current = config; draftRef.current = config; setOriginVersion(baseVersion); setStaleDraft(false)
    setDraft(config); setJson(JSON.stringify(config, null, 2)); setPreview(null)
  }, [baseVersion, config, originVersion])

  const replaceDraft = (next: EditableAgentConfig) => {
    draftRef.current = next; setDraft(next); setJson(JSON.stringify(next, null, 2)); setJsonError(""); setPreview(null); setError("")
  }
  const runtime = (next: Partial<EditableAgentConfig["runtime"]>) => replaceDraft({ ...draft, runtime: { ...draft.runtime, ...next } })
  const changeJson = (next: string) => {
    setJson(next); setPreview(null); setError("")
    try {
      const parsed: unknown = JSON.parse(next)
      const validationError = editableAgentConfigError(parsed, sourceRef.current)
      if (validationError) { setJsonError(validationError); return }
      draftRef.current = parsed as EditableAgentConfig; setDraft(parsed as EditableAgentConfig); setJsonError("")
    } catch { setJsonError("Enter valid JSON before previewing changes.") }
  }
  const requestPreview = async () => {
    setBusy(true); setError(""); setPreview(null)
    try { setPreview(await api.previewAgentConfig(agent, draft, originVersion)) }
    catch (cause) {
      if (cause instanceof ApiError && cause.code === "stale_config") { setStaleDraft(true); setError("") }
      else setError("Configuration preview failed. Check the connection and try again.")
    }
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
    {staleDraft ? <div className="config-recovery" role="alert"><p>The server configuration changed. Your local draft is preserved; reload deliberately before previewing.</p><button type="button" onClick={() => { sourceRef.current = config; draftRef.current = config; setDraft(config); setJson(JSON.stringify(config, null, 2)); setOriginVersion(baseVersion); setStaleDraft(false); setError(""); onReload() }}>Reload current configuration</button></div> : null}
    {error ? <div className="config-recovery" role="alert"><p>{error}</p>{error.includes("current configuration changed") ? <button type="button" onClick={onReload}>Reload current configuration</button> : null}</div> : null}
    {!online ? <p className="config-offline">Reconnect to preview and apply this local draft.</p> : null}
    <div className="config-editor-actions"><button type="button" disabled={!online || Boolean(jsonError) || busy || staleDraft} onClick={() => void requestPreview()}>{busy && !preview ? "Previewing…" : "Preview changes"}</button></div>
    {preview ? <section className="config-impact-ledger" aria-label="Configuration impact">
      <header><p className="eyebrow">Server classification</p><h4>{classificationHeading[preview.classification.tier]}</h4></header>
      <div className="config-diff"><div><strong>Before</strong><pre>{JSON.stringify(preview.before, null, 2)}</pre></div><div><strong>After</strong><pre>{JSON.stringify(preview.after, null, 2)}</pre></div></div>
      {preview.classification.fullRestart.length ? <div className="restart-reasons"><strong>Pending restart reasons</strong><ul>{preview.classification.fullRestart.map(reason => <li key={reason}>{reason}</li>)}</ul></div> : null}
      <div className="config-editor-actions"><button type="button" disabled={busy || !online} onClick={() => void confirm()}>{busy ? "Applying…" : confirmCopy[preview.classification.tier]}</button></div>
    </section> : null}
  </section>
}
