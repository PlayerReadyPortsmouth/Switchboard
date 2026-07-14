import { useEffect, useRef, useState } from "react"
import { ApiError } from "../api"
import type { AgentActionPreview, AgentActionResult, AgentConfigCommitResult, AgentConfigPreview, AgentRuntimeAction } from "../types"
import type { AgentConfigApi } from "./AgentConfigEditor"
import { useModalDialog } from "./useModalDialog"

export type AgentProtectedAction = AgentRuntimeAction | "remove"
export interface AgentActionApi extends AgentConfigApi {
  previewAgentAction(agent: string, action: AgentRuntimeAction): Promise<AgentActionPreview>
  confirmAgentAction(agent: string, previewId: string, idempotencyKey: string): Promise<AgentActionResult>
}
const title = { reset: "Reset agent context", restart: "Restart agent", remove: "Remove agent" } as const
const confirmLabel = { reset: "Reset agent", restart: "Restart agent", remove: "Save removal pending hub restart" } as const

export function AgentActionDialog({ agent, action, baseVersion, api, online, onCancel, onSuccess }: {
  agent: string
  action: AgentProtectedAction
  baseVersion: string
  api: AgentActionApi
  online: boolean
  onCancel(): void
  onSuccess(message: string): void
}) {
  const [preview, setPreview] = useState<AgentActionPreview | AgentConfigPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const pendingRef = useRef(false)
  const keyRef = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`)
  const { dialogRef, cancel } = useModalDialog(() => {
    if (pendingRef.current) return false
    onCancel()
    return true
  })

  const previewGeneration = useRef(0)
  const loadPreview = () => {
    const generation = ++previewGeneration.current
    keyRef.current = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    setLoading(true); setError("")
    const request = action === "remove" ? api.previewAgentConfig(agent, null, baseVersion) : api.previewAgentAction(agent, action)
    void request.then(next => { if (generation === previewGeneration.current) setPreview(next) }).catch(() => { if (generation === previewGeneration.current) setError(`Could not preview ${action}. Check the connection and try again.`) }).finally(() => { if (generation === previewGeneration.current) setLoading(false) })
  }

  useEffect(() => {
    loadPreview()
    return () => { previewGeneration.current++ }
  }, [action, agent, api, baseVersion])

  const confirm = async () => {
    if (!preview || pendingRef.current || !online) return
    pendingRef.current = true; setSubmitting(true); setError("")
    dialogRef.current?.focus()
    try {
      if (action === "remove") await api.confirmAgentConfig(agent, preview.id, false)
      else await api.confirmAgentAction(agent, preview.id, keyRef.current)
      onSuccess(action === "remove" ? `${agent} removal saved pending hub restart.` : `${agent} ${action} completed.`)
    } catch (cause) {
      const definitive = cause instanceof ApiError && cause.code !== "request_failed"
      if (definitive) {
        setPreview(null)
        setError(`${title[action]} was not applied. The consumed preview is closed; request a new preview.`)
      } else {
        setError(action === "restart" ? "Restart was not confirmed. The preview is still open; try restart again." : action === "reset" ? "Reset was not confirmed. The preview is still open; try reset again." : "Removal was not saved. The preview is still open; try again.")
      }
    } finally { pendingRef.current = false; setSubmitting(false) }
  }

  const actionImpact = preview && "impact" in preview ? preview.impact : null
  return <div className="dialog-backdrop">
    <dialog ref={dialogRef} aria-labelledby="agent-action-title" className="agent-action-dialog" tabIndex={-1}>
      <form onSubmit={event => { event.preventDefault(); void confirm() }}>
        <header><p className="eyebrow">Protected runtime action</p><h2 id="agent-action-title">{title[action]}</h2></header>
        <p>{action === "reset" ? "Reset clears resumable context and starts the next turn without the prior session." : action === "restart" ? "Restart stops the current process but keeps the session file for resumption." : "The configuration entry will be removed now. The running agent remains until the hub restarts."}</p>
        {loading ? <p role="status">Checking current impact…</p> : null}
        {actionImpact ? <dl className="action-impact"><div><dt>Runtime</dt><dd>{actionImpact.busy ? "Agent is busy" : "Agent is idle"}</dd></div><div><dt>Queue</dt><dd>{actionImpact.queueDepth} queued {actionImpact.queueDepth === 1 ? "request" : "requests"}</dd></div></dl> : null}
        {action === "remove" && preview && "classification" in preview ? <div className="restart-reasons"><strong>Full hub restart required</strong><ul>{preview.classification.fullRestart.map(reason => <li key={reason}>{reason}</li>)}</ul></div> : null}
        {error && preview ? <p role="alert" className="form-error">{error}</p> : null}
        {error && !preview && !loading ? <p role="alert" className="form-error">{error}</p> : null}
        {!online ? <p className="config-offline">Reconnect to confirm this preview.</p> : null}
        <div className="dialog-actions"><button type="button" disabled={submitting} onClick={cancel}>Cancel</button>{!preview && error && !loading ? <button type="button" disabled={!online} onClick={loadPreview}>Preview {action} again</button> : <button type="submit" className={action === "remove" || action === "reset" ? "danger-fill" : ""} disabled={!preview || submitting || !online}>{submitting ? "Confirming…" : error && preview && action !== "remove" ? `Try ${action} again` : confirmLabel[action]}</button>}</div>
      </form>
    </dialog>
  </div>
}
