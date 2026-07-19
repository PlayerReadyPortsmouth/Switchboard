import { useId, useRef, useState } from "react"
import { ApiError } from "../api"
import type { CardButton, CardInfo, CardInteractionResult, CardModal, CardSpec } from "../types"
import { Markdown } from "./Markdown"
import { CardModalDialog } from "./CardModalDialog"

/** Submits one click. Resolves to a 200 shape; every documented failure rejects with an
 *  `ApiError` carrying the hub's `error` code. Absent ⇒ the card renders read-only. */
export type CardInteract = (customId: string, fields?: Record<string, string>) => Promise<CardInteractionResult>

interface Notice { tone: "ok" | "error"; text: string }

/** Turn a failed click into a sentence a human can act on.
 *
 *  Exported and pure so the mapping is tested directly rather than through the DOM. Every
 *  documented failure gets its own sentence: the three 403s differ in what the reader should do
 *  about them (get an identity mapped / get allowlisted / stop trying), and conflating them
 *  into "forbidden" would hide that. `unroutable` is not a permission problem at all — the
 *  click was allowed and there was simply nobody left to receive it, which is the one case a
 *  reader might reasonably retry later. Anything unrecognised, including a network failure
 *  with no response at all, falls through to a plain retry prompt rather than a raw code. */
export function interactionFailureMessage(error: unknown): string {
  // The hub's `reason` is a fragment ("the triage agent has exited"), and it is appended after
  // a full stop — so it is sentence-cased and given a stop of its own rather than reading as a
  // lowercase run-on.
  const raw = error instanceof ApiError ? error.reason?.trim() : undefined
  const reason = raw ? ` ${raw[0]!.toUpperCase()}${raw.slice(1)}${/[.!?]$/.test(raw) ? "" : "."}` : ""
  if (!(error instanceof ApiError)) return "This action didn’t reach Switchboard. Check the connection, then try again."
  switch (error.code) {
    case "unmapped_identity": return "Your sign-in isn’t linked to a Switchboard identity, so this button can’t act on your behalf. Ask an administrator to map it."
    case "not_allowlisted": return "You’re not on this Switchboard’s allowlist, so this button is read-only for you."
    case "forbidden_action": return `You’re not authorised to run this action.${reason}`
    case "unroutable": return `Nothing is listening for this card any more, so the click wasn’t delivered.${reason}`
    case "web_cards_disabled": return "Card actions are switched off on this hub."
    default: return "This action didn’t reach Switchboard. Check the connection, then try again."
  }
}

/** A Discord custom emoji (`<:name:id>` / `<a:name:id>`) has no web rendering — dropping it
 *  beats printing the raw markup next to the label. Plain unicode emoji pass through. */
const displayEmoji = (emoji: string | undefined): string | null =>
  emoji && !/^<a?:/.test(emoji) ? emoji : null

function CardFields({ fields }: { fields: NonNullable<CardSpec["fields"]> }) {
  if (!fields.length) return null
  return (
    <dl className="agent-card-fields">
      {fields.map((field, index) => (
        // `inline` is Discord's flag for "this field may share a row". It maps to a grid
        // span rather than to a float: at 390px everything is one column regardless, which
        // is why the flag is expressed as data rather than as a width in JS.
        <div key={`${field.name}.${index}`} className="agent-card-field" data-inline={String(field.inline === true)}>
          <dt>{field.name}</dt>
          <dd><Markdown source={field.value} variant="chat" /></dd>
        </div>
      ))}
    </dl>
  )
}

/** The read-only body of a card: everything except the live buttons. Shared by the current
 *  revision and by each history entry, which is what makes a prior state look like the card it
 *  once was rather than like a different component. */
function CardSurface({ spec, headingId, headingLevel = "h3" }: { spec: CardSpec; headingId?: string; headingLevel?: "h3" | "h4" }) {
  const Heading = headingLevel
  return <>
    <Heading className="agent-card-title" {...(headingId ? { id: headingId } : {})}>{spec.title}</Heading>
    {spec.body ? <div className="agent-card-body"><Markdown source={spec.body} variant="chat" /></div> : null}
    {spec.fields?.length ? <CardFields fields={spec.fields} /> : null}
    {spec.footer ? <p className="agent-card-footer">{spec.footer}</p> : null}
  </>
}

/** Prior revisions, collapsed.
 *
 *  Collapsed by default because the current state is the answer — `triage` rewrites one card
 *  three or four times per ticket, and expanding that trail inline would bury the live buttons
 *  under superseded copies of themselves. Kept reachable because the trail is the audit answer
 *  to "what did this card say when I clicked Approve", which the hub deliberately retains.
 *
 *  A superseded button is rendered as a `<span>`, never a disabled `<button>`. That is the
 *  guarantee, and it is structural: there is no button element, so there is nothing for a
 *  click, an Enter key, a form submit, or a `disabled` attribute someone later removes to
 *  activate. `aria-disabled` on a real button would have been a promise; this is an absence. */
function CardHistory({ history }: { history: NonNullable<CardInfo["history"]> }) {
  if (!history.length) return null
  return (
    <details className="agent-card-history" data-region="card-history">
      <summary>{history.length === 1 ? "1 earlier state" : `${history.length} earlier states`}</summary>
      <ol className="agent-card-history-list">
        {[...history].sort((left, right) => left.revision - right.revision).map(entry => (
          <li key={entry.revision} className="agent-card-revision" data-revision={entry.revision}>
            <p className="eyebrow">
              Revision {entry.revision}
              <time dateTime={new Date(entry.updatedAt).toISOString()}>
                {new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
            </p>
            <CardSurface spec={entry.card} headingLevel="h4" />
            {entry.card.buttons.length ? (
              <p className="agent-card-inert-buttons" data-region="card-inert-buttons">
                {entry.card.buttons.map((button, index) => (
                  <span key={`${button.customId}.${index}`} className="agent-card-inert-button">
                    {displayEmoji(button.emoji) ? <span aria-hidden="true">{displayEmoji(button.emoji)} </span> : null}
                    {button.label}
                  </span>
                ))}
                <span className="sr-only"> (no longer available)</span>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  )
}

/** One interactive agent card in the transcript.
 *
 *  Renders the CURRENT revision's spec and only the current revision's buttons; `history[]` is
 *  strictly inert. A click POSTs to the interaction endpoint and every documented answer lands
 *  somewhere the reader can see — a sent/handled confirmation, an opened form, or a sentence
 *  explaining the refusal.
 *
 *  Pending state is tracked per-card, not per-button: two buttons on one card are alternatives
 *  ("Fix now" vs "Backlog"), so while one is in flight the rest must not be clickable either.
 *  Crucially the pending flag is cleared in a `finally`, so a rejected click frees the card
 *  again — Discord's path left an unroutable click spinning forever, and a frozen control
 *  surface is worse than a legible failure. */
export function AgentCard({ info, onInteract }: { info: CardInfo; onInteract?: CardInteract }) {
  const headingId = `agent-card-${useId()}`
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [modal, setModal] = useState<{ customId: string; modal: CardModal } | null>(null)
  const [modalError, setModalError] = useState("")
  const [modalSubmitting, setModalSubmitting] = useState(false)
  // A ref as well as state: two clicks in the same tick both read the stale `pending` state,
  // so the state drives the disabled attributes and the ref is what actually rejects the
  // second submit.
  const inFlightRef = useRef(false)
  const interactive = Boolean(onInteract)

  const applyResult = (result: CardInteractionResult, customId: string) => {
    if (result.status === "modal") { setModal({ customId, modal: result.modal }); setModalError(""); return }
    setModal(null)
    setNotice(result.status === "handled"
      ? { tone: "ok", text: result.action === "approval" ? "Approval recorded." : "Action completed." }
      : { tone: "ok", text: `Sent to ${info.agent}.` })
  }

  const send = async (customId: string, fields?: Record<string, string>) => {
    if (!onInteract || inFlightRef.current) return
    inFlightRef.current = true
    setPending(customId)
    if (fields) setModalSubmitting(true)
    setNotice(null)
    try {
      applyResult(await onInteract(customId, fields), customId)
      if (fields) setModalError("")
    } catch (error) {
      const message = interactionFailureMessage(error)
      // A failure while a form is open belongs IN the form — closing the dialog would throw
      // away everything the reader typed to say the submit was refused.
      if (fields) setModalError(message)
      else { setNotice({ tone: "error", text: message }); setModal(null) }
    } finally {
      // Always. This is the line that stops a failed click freezing the card.
      inFlightRef.current = false
      setPending(null)
      setModalSubmitting(false)
    }
  }

  const buttons = info.card.buttons
  return (
    <article className="agent-card" aria-labelledby={headingId} data-region="agent-card" data-revision={info.revision} data-correlation-id={info.correlationId}>
      <CardSurface spec={info.card} headingId={headingId} />
      {/* `buttons: []` is terminal: the card renders as a record with no control row at all,
          rather than as an empty toolbar implying something is missing. */}
      {interactive && buttons.length ? (
        <div className="agent-card-actions" role="group" aria-labelledby={headingId} data-region="card-actions">
          {buttons.map((button, index) => (
            <CardActionButton
              key={`${button.customId}.${index}`}
              button={button}
              pending={pending === button.customId}
              disabled={pending !== null}
              onClick={() => { void send(button.customId) }}
            />
          ))}
        </div>
      ) : null}
      {/* One line carries both states. It is a live region rather than text inside the button
          because the pending button is `disabled`, and a disabled control's changing label is
          not reliably announced — so "sending" and its outcome are announced from here. */}
      {pending !== null || notice ? (
        <p
          className="agent-card-notice"
          data-region="card-notice"
          data-tone={pending !== null ? "pending" : notice!.tone}
          role={notice?.tone === "error" && pending === null ? "alert" : "status"}
          aria-live={notice?.tone === "error" && pending === null ? undefined : "polite"}
        >{pending !== null ? "Sending…" : notice!.text}</p>
      ) : null}
      {/* History last, BELOW the live controls: expanded, a revision trail is tall, and the
          buttons that still work must never be pushed away from the card they belong to. */}
      {info.history?.length ? <CardHistory history={info.history} /> : null}
      {modal ? (
        <CardModalDialog
          modal={modal.modal}
          submitting={modalSubmitting}
          error={modalError}
          onSubmit={fields => { void send(modal.customId, fields) }}
          onCancel={() => { if (!inFlightRef.current) { setModal(null); setModalError("") } }}
        />
      ) : null}
    </article>
  )
}

function CardActionButton({ button, pending, disabled, onClick }: {
  button: CardButton
  pending: boolean
  disabled: boolean
  onClick(): void
}) {
  const emoji = displayEmoji(button.emoji)
  return (
    <button
      type="button"
      className="agent-card-action"
      data-style={button.style ?? "secondary"}
      data-pending={String(pending)}
      disabled={disabled}
      // Announces "opens a form" before the click for anyone driving this by keyboard or
      // screen reader. The hub still decides — this is the affordance, not the mechanism.
      {...(button.modal ? { "aria-haspopup": "dialog" as const } : {})}
      onClick={onClick}
    >
      {emoji ? <span className="agent-card-action-emoji" aria-hidden="true">{emoji}</span> : null}
      <span className="agent-card-action-label">{button.label}</span>
      {pending ? <span className="sr-only"> — sending</span> : null}
    </button>
  )
}
