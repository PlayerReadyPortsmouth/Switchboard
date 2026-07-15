import { useRef } from "react"
import type { ApprovalDecision, ApprovalDetail } from "../types"
import { SafeValueView } from "./ApprovalDetail"
import { useModalDialog } from "./useModalDialog"

const decisionTitle: Record<ApprovalDecision, string> = {
  grant: "Grant approval",
  deny: "Deny approval",
}

export function ApprovalDecisionDialog({ approval, decision, submitting, error, onCancel, onConfirm }: {
  approval: ApprovalDetail
  decision: ApprovalDecision
  submitting: boolean
  error: string
  onCancel(): void
  onConfirm(): void
}) {
  const pendingRef = useRef(submitting)
  pendingRef.current = submitting
  const { dialogRef, cancel } = useModalDialog(() => {
    if (pendingRef.current) return false
    onCancel()
    return true
  })
  const destructiveGrant = decision === "grant" && approval.risk === "destructive"
  const confirmLabel = submitting
    ? decision === "grant" ? "Granting…" : "Denying…"
    : error
      ? `Try ${decision} again`
      : decisionTitle[decision]

  return <div className="dialog-backdrop">
    <dialog ref={dialogRef} aria-labelledby="approval-decision-title" className="approval-decision-dialog" tabIndex={-1}>
      <form onSubmit={event => { event.preventDefault(); if (!submitting) onConfirm() }}>
        <header><p className="eyebrow">Protected approval decision</p><h2 id="approval-decision-title">{decisionTitle[decision]}</h2></header>
        <p>{decision === "grant" ? "Granting authorizes exactly the held effect shown here." : "Denying discards the held effect without running it."}</p>
        {destructiveGrant ? <p className="approval-irreversible"><strong>Destructive and potentially irreversible.</strong> Verify every target and fingerprint before granting.</p> : null}
        <dl className="approval-decision-summary">
          <div><dt>Summary</dt><dd>{approval.summary}</dd></div>
          <div><dt>Target</dt><dd>{approval.target}</dd></div>
          <div><dt>Risk</dt><dd>{approval.risk}</dd></div>
        </dl>
        <section className="approval-decision-effect" aria-label="Exact held effect"><h3>Exact held effect</h3><SafeValueView value={approval.detail} /></section>
        {submitting ? <p role="status">Decision in progress. This dialog cannot be dismissed.</p> : null}
        {error ? <p role="alert" className="form-error">{error}</p> : null}
        <div className="dialog-actions"><button type="button" disabled={submitting} onClick={cancel}>Cancel</button><button type="submit" className={decision === "grant" ? "danger-fill" : ""} disabled={submitting}>{confirmLabel}</button></div>
      </form>
    </dialog>
  </div>
}
