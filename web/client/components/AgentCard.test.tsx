import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiError } from "../api"
import type { CardInfo, CardInteractionResult, CardSpec } from "../types"
import { AgentCard, interactionFailureMessage } from "./AgentCard"

const screen = within(document.body)
afterEach(cleanup)

/** Shaped on the real production `triage` card: a bug title, a rationale body ending bold,
 *  four fields, and the four quick actions across all four button styles. */
const triageSpec: CardSpec = {
  title: "🐛 Cannot view CYP profiles",
  body: "Aurora reports a 403 opening any CYP profile from the caseload list.\n\n**Blocks all mentor caseload work.**",
  fields: [
    { name: "Submitter", value: "Aurora", inline: true },
    { name: "Severity", value: "High", inline: true },
    { name: "Area", value: "Caseload", inline: true },
    { name: "Ticket", value: "BUG-481" },
  ],
  buttons: [
    { customId: "triage:fix:481", label: "Fix now", style: "success", emoji: "🔧" },
    { customId: "triage:info:481", label: "Need info", style: "primary", emoji: "❓", modal: { title: "What do you need?", inputs: [{ id: "question", label: "Question", style: "paragraph", required: true }] } },
    { customId: "triage:backlog:481", label: "Backlog", style: "secondary", emoji: "📋" },
    { customId: "triage:close:481", label: "Close", style: "danger", emoji: "✅" },
  ],
  footer: "triage · 19 Jul 21:04",
}

const card = (overrides: Partial<CardInfo> = {}): CardInfo => ({
  correlationId: "corr-481", conversationId: "c1", agent: "triage", revision: 1,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, card: triageSpec, ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Scoped by data-region, not by role: `<details>` also reports role="group", so a bare
// getByRole("group") would match the history disclosure as well as the action row.
const actionRow = () => document.querySelector('[data-region="card-actions"]') as HTMLElement
const notice = () => document.querySelector('[data-region="card-notice"]')

test("renders title, markdown body, every field and the footer", () => {
  render(<AgentCard info={card()} />)
  expect(screen.getByRole("heading", { name: "🐛 Cannot view CYP profiles" })).toBeTruthy()
  // The body goes through the shared chat-variant markdown renderer: the bold run is a <strong>.
  expect(screen.getByText("Blocks all mentor caseload work.").tagName).toBe("STRONG")
  for (const field of triageSpec.fields!) {
    expect(screen.getByText(field.name)).toBeTruthy()
    expect(screen.getByText(field.value)).toBeTruthy()
  }
  expect(screen.getByText("triage · 19 Jul 21:04")).toBeTruthy()
})

test("an inline field is marked inline and a non-inline one is not", () => {
  render(<AgentCard info={card()} />)
  const fields = [...document.querySelectorAll(".agent-card-field")]
  expect(fields.map(field => field.getAttribute("data-inline"))).toEqual(["true", "true", "true", "false"])
})

test("each button carries its style, its emoji and a 44px-capable label", () => {
  render(<AgentCard info={card()} onInteract={async () => ({ status: "ok" })} />)
  const buttons = within(actionRow()).getAllByRole("button")
  expect(buttons.map(button => button.textContent)).toEqual(["🔧Fix now", "❓Need info", "📋Backlog", "✅Close"])
  expect(buttons.map(button => button.getAttribute("data-style"))).toEqual(["success", "primary", "secondary", "danger"])
  // A button that opens a form announces so before it is pressed.
  expect(buttons[1]!.getAttribute("aria-haspopup")).toBe("dialog")
  expect(buttons[0]!.getAttribute("aria-haspopup")).toBeNull()
})

test("a button with no style falls back to secondary; a Discord custom emoji is dropped", () => {
  render(<AgentCard info={card({ card: { ...triageSpec, buttons: [{ customId: "a", label: "Go", emoji: "<:ready:123>" }] } })} onInteract={async () => ({ status: "ok" })} />)
  const button = within(actionRow()).getByRole("button")
  expect(button.getAttribute("data-style")).toBe("secondary")
  expect(button.textContent).toBe("Go")
})

test("buttons: [] is terminal — no control row at all", () => {
  render(<AgentCard info={card({ card: { ...triageSpec, buttons: [] } })} onInteract={async () => ({ status: "ok" })} />)
  expect(actionRow()).toBeNull()
  expect(screen.queryAllByRole("button")).toEqual([])
})

test("with no interaction handler the card renders read-only", () => {
  render(<AgentCard info={card()} />)
  expect(actionRow()).toBeNull()
  expect(screen.queryAllByRole("button")).toEqual([])
})

test("a click posts the customId and confirms delivery to the agent", async () => {
  const sent: string[] = []
  render(<AgentCard info={card()} onInteract={async customId => { sent.push(customId); return { status: "ok" } }} />)
  await userEvent.click(within(actionRow()).getByRole("button", { name: /Fix now/ }))
  expect(sent).toEqual(["triage:fix:481"])
  await waitFor(() => expect(notice()!.textContent).toBe("Sent to triage."))
})

test("a hub-handled click says so without mentioning the agent", async () => {
  const { promise, resolve } = deferred<CardInteractionResult>()
  render(<AgentCard info={card()} onInteract={() => promise} />)
  await userEvent.click(within(actionRow()).getByRole("button", { name: /Close/ }))
  await act(async () => { resolve({ status: "handled", action: "approval" }); await promise })
  await waitFor(() => expect(notice()!.textContent).toBe("Approval recorded."))

  cleanup()
  render(<AgentCard info={card()} onInteract={async () => ({ status: "handled", action: "gated" })} />)
  await userEvent.click(within(actionRow()).getByRole("button", { name: /Close/ }))
  await waitFor(() => expect(notice()!.textContent).toBe("Action completed."))
})

test("a click in flight shows pending, blocks every button, and only fires once", async () => {
  const { promise, resolve } = deferred<CardInteractionResult>()
  let calls = 0
  render(<AgentCard info={card()} onInteract={() => { calls++; return promise } } />)
  const buttons = within(actionRow()).getAllByRole("button")
  await userEvent.click(buttons[0]!)
  await waitFor(() => expect(notice()!.textContent).toBe("Sending…"))
  expect(buttons[0]!.getAttribute("data-pending")).toBe("true")
  // Every button on the card is blocked, not just the pressed one: they are alternatives.
  expect(buttons.every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  await userEvent.click(buttons[2]!, { pointerEventsCheck: 0 })
  expect(calls).toBe(1)
  await act(async () => { resolve({ status: "ok" }); await promise })
  await waitFor(() => expect(buttons[0]!.hasAttribute("disabled")).toBe(false))
})

// The regression the Discord path shipped: an unroutable click froze its button forever.
test.each([
  ["unmapped_identity", 403, undefined, /isn’t linked to a Switchboard identity/],
  ["not_allowlisted", 403, undefined, /not on this Switchboard’s allowlist/],
  ["forbidden_action", 403, "deploy approvals are owner-only", /not authorised to run this action\. Deploy approvals are owner-only\./],
  ["unroutable", 409, "the triage agent has exited", /Nothing is listening for this card any more.*The triage agent has exited\./],
  ["web_cards_disabled", 503, undefined, /Card actions are switched off/],
])("a %s failure renders legibly and leaves the buttons usable", async (code, status, reason, expected) => {
  render(<AgentCard info={card()} onInteract={async () => { throw new ApiError(status as number, code as string, reason as string | undefined) }} />)
  const button = within(actionRow()).getByRole("button", { name: /Fix now/ })
  await userEvent.click(button)
  const message = await waitFor(() => {
    const found = notice()
    expect(found!.textContent).toMatch(expected as RegExp)
    return found!
  })
  expect(message.getAttribute("role")).toBe("alert")
  expect(message.getAttribute("data-tone")).toBe("error")
  // Never stuck: the card is clickable again immediately.
  expect((button as HTMLButtonElement).disabled).toBe(false)
})

test("a transport failure with no response falls back to a retry prompt", async () => {
  render(<AgentCard info={card()} onInteract={async () => { throw new TypeError("network") }} />)
  const button = within(actionRow()).getByRole("button", { name: /Fix now/ })
  await userEvent.click(button)
  await waitFor(() => expect(notice()!.textContent).toMatch(/didn’t reach Switchboard/))
  expect((button as HTMLButtonElement).disabled).toBe(false)
})

test("interactionFailureMessage never leaks a raw error code", () => {
  for (const code of ["unmapped_identity", "not_allowlisted", "forbidden_action", "unroutable", "web_cards_disabled", "something_new"]) {
    const message = interactionFailureMessage(new ApiError(403, code))
    expect(message).not.toContain(code)
    expect(message.length).toBeGreaterThan(20)
  }
})

test("the modal round-trip: open from the hub's spec, submit fields, then confirm", async () => {
  const calls: { customId: string; fields?: Record<string, string> }[] = []
  render(<AgentCard info={card()} onInteract={async (customId, fields) => {
    calls.push(fields ? { customId, fields } : { customId })
    return fields ? { status: "ok" } : { status: "modal", modal: { title: "What do you need?", inputs: [
      { id: "question", label: "Question", style: "paragraph", placeholder: "Ask the submitter…", required: true },
      { id: "owner", label: "Owner", style: "short" },
    ] } }
  }} />)

  await userEvent.click(within(actionRow()).getByRole("button", { name: /Need info/ }))
  const dialog = await waitFor(() => {
    const found = document.querySelector('[data-region="card-modal"]')
    expect(found).toBeTruthy()
    return within(found as HTMLElement)
  })
  // The click alone must NOT have fired the action — a modal button opens a form instead.
  expect(calls).toEqual([{ customId: "triage:info:481" }])
  // `paragraph` is a textarea, `short` a single-line input, and `required`/`placeholder` hold.
  const question = dialog.getByLabelText(/Question/) as HTMLTextAreaElement
  expect(question.tagName).toBe("TEXTAREA")
  expect(question.required).toBe(true)
  expect(question.placeholder).toBe("Ask the submitter…")
  const owner = dialog.getByLabelText("Owner") as HTMLInputElement
  expect(owner.tagName).toBe("INPUT")
  expect(owner.required).toBe(false)

  await userEvent.type(question, "Which browser?")
  await userEvent.click(dialog.getByRole("button", { name: "Submit" }))
  await waitFor(() => expect(calls).toHaveLength(2))
  // Untouched optional inputs are omitted rather than sent empty.
  expect(calls[1]).toEqual({ customId: "triage:info:481", fields: { question: "Which browser?" } })
  await waitFor(() => expect(document.querySelector('[data-region="card-modal"]')).toBeNull())
  await waitFor(() => expect(notice()!.textContent).toBe("Sent to triage."))
})

test("a refused modal submit keeps the form open with what was typed", async () => {
  render(<AgentCard info={card()} onInteract={async (_customId, fields) => {
    if (!fields) return { status: "modal", modal: { title: "Note", inputs: [{ id: "note", label: "Note", style: "short" }] } }
    throw new ApiError(403, "forbidden_action", "approver only")
  }} />)
  await userEvent.click(within(actionRow()).getByRole("button", { name: /Need info/ }))
  const dialog = await waitFor(() => {
    const found = document.querySelector('[data-region="card-modal"]')
    expect(found).toBeTruthy()
    return within(found as HTMLElement)
  })
  await userEvent.type(dialog.getByLabelText("Note"), "please")
  await userEvent.click(dialog.getByRole("button", { name: "Submit" }))
  await waitFor(() => expect(dialog.getByRole("alert").textContent).toMatch(/not authorised.*Approver only\./))
  // Still open, still holding the text — the reader's typing is not thrown away by a refusal.
  expect(document.querySelector('[data-region="card-modal"]')).toBeTruthy()
  expect((dialog.getByLabelText("Note") as HTMLInputElement).value).toBe("please")
})

test("a modal can be cancelled with Escape and with the Cancel button", async () => {
  render(<AgentCard info={card()} onInteract={async () => ({ status: "modal", modal: { title: "Note", inputs: [{ id: "note", label: "Note", style: "short" }] } })} />)
  const open = async () => {
    await userEvent.click(within(actionRow()).getByRole("button", { name: /Need info/ }))
    await waitFor(() => expect(document.querySelector('[data-region="card-modal"]')).toBeTruthy())
  }
  await open()
  await userEvent.click(within(document.querySelector('[data-region="card-modal"]') as HTMLElement).getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(document.querySelector('[data-region="card-modal"]')).toBeNull())

  await open()
  // happy-dom does not synthesise a <dialog> `cancel` from an Escape keydown, so the native
  // event is dispatched directly — the repo's existing convention for dialog-cancel tests.
  act(() => { (document.querySelector("dialog") as HTMLDialogElement).dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })) })
  await waitFor(() => expect(document.querySelector('[data-region="card-modal"]')).toBeNull())
})

test("history is collapsed by default and its buttons are not buttons at all", async () => {
  const info = card({
    revision: 3,
    updatedAt: 1_700_000_600_000,
    card: { title: "✅ Deployed to live.", body: "Deploy 512 green.", buttons: [] },
    history: [
      { revision: 1, updatedAt: 1_700_000_000_000, card: triageSpec },
      { revision: 2, updatedAt: 1_700_000_300_000, card: { title: "🚀 Fix ready: CYP profile 403", body: "Branch pushed.", fields: [{ name: "PR", value: "#514" }], buttons: [{ customId: "deploy:go:514", label: "Deploy", style: "success" }] } },
    ],
  })
  render(<AgentCard info={info} onInteract={async () => ({ status: "ok" })} />)

  const history = document.querySelector('[data-region="card-history"]') as HTMLDetailsElement
  expect(history.open).toBe(false)
  expect(within(history).getByText("2 earlier states")).toBeTruthy()

  // The current revision is terminal, so there is no live control row at all — and no
  // button anywhere on the card, from this revision or any prior one.
  expect(actionRow()).toBeNull()
  expect(screen.queryAllByRole("button")).toEqual([])

  // happy-dom does not toggle <details> from a summary click, so the disclosure is opened
  // directly — what is under test here is what the revealed markup IS, not the toggle itself.
  act(() => { history.open = true })
  // Prior states are fully readable…
  expect(within(history).getByText("🚀 Fix ready: CYP profile 403")).toBeTruthy()
  expect(within(history).getByText("Deploy")).toBeTruthy()
  expect(within(history).getByText("Fix now")).toBeTruthy()
  // …and structurally inert: a superseded button is a <span>, not a disabled <button>, so
  // there is no control for a click, an Enter key, or a removed `disabled` attribute to reach.
  expect(within(history).queryAllByRole("button")).toEqual([])
  expect(within(history).getByText("Deploy").tagName).toBe("SPAN")
  expect(history.querySelector("button")).toBeNull()
})

test("history ordering is oldest-first regardless of the order it arrived in", () => {
  const info = card({
    revision: 3,
    card: { title: "Now", body: "", buttons: [] },
    history: [
      { revision: 2, updatedAt: 2, card: { title: "Second", body: "", buttons: [] } },
      { revision: 1, updatedAt: 1, card: { title: "First", body: "", buttons: [] } },
    ],
  })
  render(<AgentCard info={info} />)
  const history = document.querySelector('[data-region="card-history"]') as HTMLDetailsElement
  act(() => { history.open = true })
  expect([...history.querySelectorAll(".agent-card-revision")].map(item => item.getAttribute("data-revision"))).toEqual(["1", "2"])
})

test("a card at revision 1 has no history disclosure", () => {
  render(<AgentCard info={card()} />)
  expect(document.querySelector('[data-region="card-history"]')).toBeNull()
})

test("a hub reason is sentence-cased and punctuated rather than run on lowercase", () => {
  expect(interactionFailureMessage(new ApiError(409, "unroutable", "the triage agent has exited")))
    .toBe("Nothing is listening for this card any more, so the click wasn’t delivered. The triage agent has exited.")
  // An already-punctuated reason is not double-stopped.
  expect(interactionFailureMessage(new ApiError(409, "unroutable", "Agent gone.")))
    .toMatch(/Agent gone\.$/)
})
