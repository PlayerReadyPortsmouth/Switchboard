import { useRef, useState, type FormEvent } from "react"
import type { CardModal } from "../types"
import { useModalDialog } from "./useModalDialog"

/** The form a card button opens instead of firing.
 *
 *  The spec is the one the HUB returned from the interaction POST, not the one embedded in the
 *  button: the hub gates the open as well as the submit, so the round-trip has already happened
 *  by the time this mounts and its answer is the authoritative shape.
 *
 *  `useModalDialog` supplies the shared modal behaviour used by every other dialog in the app —
 *  native `showModal()`, a Tab focus trap, Escape-to-cancel, and focus restored to the button
 *  that opened it. Escape is refused while a submit is in flight, matching the archive dialog,
 *  so a half-sent action can't be abandoned into an ambiguous state. */
export function CardModalDialog({ modal, submitting, error, onSubmit, onCancel }: {
  modal: CardModal
  submitting: boolean
  error: string
  onSubmit(fields: Record<string, string>): void
  onCancel(): void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const submittingRef = useRef(submitting)
  submittingRef.current = submitting
  const { dialogRef } = useModalDialog(() => {
    if (submittingRef.current) return false
    onCancel()
    return true
  })
  const titleId = "card-modal-title"
  // The value is read EAGERLY, in the handler, and only then closed over. A lazy
  // `current => ({ ...current, [id]: event.currentTarget.value })` reads the event during the
  // render that applies it, by which point React has already cleared `currentTarget` — the
  // updater then throws and the keystroke is lost.
  const change = (id: string) => (event: { currentTarget: { value: string } }) => {
    const { value } = event.currentTarget
    setValues(current => ({ ...current, [id]: value }))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (submittingRef.current) return
    // Only inputs the form actually carries are sent. Untouched optional inputs are omitted
    // rather than sent empty, so the agent's frame distinguishes "left blank" from "absent".
    const fields: Record<string, string> = {}
    for (const input of modal.inputs) {
      const value = values[input.id] ?? ""
      if (value !== "") fields[input.id] = value
    }
    onSubmit(fields)
  }

  return (
    <div className="dialog-backdrop">
      <dialog ref={dialogRef} className="card-modal" aria-labelledby={titleId} data-region="card-modal">
        <form onSubmit={submit}>
          <h2 id={titleId}>{modal.title}</h2>
          {modal.inputs.map(input => (
            <label key={input.id}>
              {/* Label text and the required marker share ONE grid child. `dialog label` is a
                  grid, so a bare sibling span would be placed on its own row and the asterisk
                  would float under the label instead of beside it. */}
              <span>{input.label}{input.required ? <span className="card-modal-required" aria-hidden="true"> *</span> : null}</span>
              {input.style === "paragraph"
                ? <textarea
                    rows={4}
                    required={input.required === true}
                    placeholder={input.placeholder}
                    value={values[input.id] ?? ""}
                    onChange={change(input.id)}
                  />
                : <input
                    type="text"
                    required={input.required === true}
                    placeholder={input.placeholder}
                    value={values[input.id] ?? ""}
                    onChange={change(input.id)}
                  />}
            </label>
          ))}
          {error ? <p role="alert" className="form-error">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" disabled={submitting} onClick={onCancel}>Cancel</button>
            <button type="submit" disabled={submitting}>{submitting ? "Submitting…" : "Submit"}</button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
