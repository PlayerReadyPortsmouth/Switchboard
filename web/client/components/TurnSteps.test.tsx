import { DEFAULT_VIEWPORT_WIDTH, resetViewport, setViewport } from "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { act, cleanup, render, within } from "@testing-library/react"
import { TurnSteps, formatDuration, summariseSteps } from "./TurnSteps"
import type { ConversationEvent, ToolStep } from "../types"

const screen = within(document.body)
afterEach(cleanup)

const step = (over: Partial<ToolStep> = {}): ToolStep =>
  ({ id: "t1", name: "Read", summary: "hub/index.ts", status: "ok", durationMs: 400, ...over })

test("renders all three statuses onto the spine with their status data-attribute", () => {
  render(<TurnSteps steps={[
    step({ id: "t1", name: "Read", status: "ok", durationMs: 400 }),
    step({ id: "t2", name: "Bash", summary: "git log --oneline", status: "error", durationMs: 1200 }),
    step({ id: "t3", name: "Grep", summary: "shareLinks", status: "running", durationMs: undefined }),
  ]} />)
  const spine = screen.getByRole("list", { name: "Turn activity" })
  const rows = spine.querySelectorAll(".turn-step")
  expect([...rows].map(row => row.getAttribute("data-status"))).toEqual(["ok", "error", "running"])
  expect([...rows].map(row => row.getAttribute("data-tool"))).toEqual(["Read", "Bash", "Grep"])
})

test("shows a duration only once known, and 'running' until then", () => {
  render(<TurnSteps steps={[
    step({ id: "t1", status: "ok", durationMs: 400 }),
    step({ id: "t2", name: "Bash", status: "running", durationMs: undefined }),
  ]} />)
  expect(screen.getByText("400ms")).toBeTruthy()
  expect(screen.getByText("running")).toBeTruthy()
})

test("the argument summary is one ellipsised line with the full text in title", () => {
  const summary = "apps/api/src/routes/share.ts"
  render(<TurnSteps steps={[step({ summary })]} />)
  const cell = document.querySelector(".turn-step-summary")!
  expect(cell.textContent).toBe(summary)
  expect(cell.getAttribute("title")).toBe(summary)
})

test("a step with no summary renders an empty summary cell rather than 'undefined'", () => {
  render(<TurnSteps steps={[step({ summary: undefined })]} />)
  expect(document.querySelector(".turn-step-summary")!.textContent).toBe("")
})

test("turn states are folded into the same spine, not dropped", () => {
  const events: ConversationEvent[] = [
    { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 1, state: "working" },
    { kind: "turn_state", conversationId: "c1", sequence: 1, ts: 2, state: "completed" },
  ]
  render(<TurnSteps steps={[step()]} events={events} />)
  const spine = screen.getByRole("list", { name: "Turn activity" })
  expect(within(spine).getByText("Read")).toBeTruthy()
  expect(within(spine).getByText("Working")).toBeTruthy()
  expect(within(spine).getByText("Completed")).toBeTruthy()
})

test("renders nothing at all when there is neither a step nor a turn state", () => {
  render(<TurnSteps steps={[]} events={[]} />)
  expect(screen.queryByRole("list", { name: "Turn activity" })).toBeNull()
})

test("formatDuration scales precision to the magnitude", () => {
  expect(formatDuration(0)).toBe("0ms")
  expect(formatDuration(412)).toBe("412ms")
  expect(formatDuration(1200)).toBe("1.2s")
  expect(formatDuration(59_900)).toBe("59.9s")
  expect(formatDuration(65_000)).toBe("1m 5s")
})

// --- Mobile collapse -------------------------------------------------------------------
// On a ~390px screen the spine pushes the conversation off-screen, so there it collapses to a
// summary line and opens on tap. Desktop keeps the bare spine and is asserted unchanged above.

// happy-dom shares one window across the whole test process, so the width is handed back
// after every test here — see the note in testSetup.ts.
const setWidth = (width: number) => act(() => { setViewport(width) })
const DESKTOP = DEFAULT_VIEWPORT_WIDTH
const MOBILE = 390

afterEach(() => { resetViewport(); sessionStorage.clear() })

test("summariseSteps names the work without needing the spine open", () => {
  expect(summariseSteps([])).toBe("No tool calls")
  expect(summariseSteps([step({ id: "a", durationMs: 400 })])).toBe("1 step · 400ms")
  expect(summariseSteps([step({ id: "a", durationMs: 400 }), step({ id: "b", durationMs: 1200 })])).toBe("2 steps · 1.6s")
  // Still working ⇒ say so rather than reporting a partial total.
  expect(summariseSteps([step({ id: "a", durationMs: 400 }), step({ id: "b", status: "running", durationMs: undefined })]))
    .toBe("2 steps · running")
  // A failure is an OUTCOME, not process — it must survive the collapse.
  expect(summariseSteps([step({ id: "a" }), step({ id: "b", status: "error" })])).toBe("2 steps · 1 failed")
})

test("desktop renders the bare spine with no disclosure wrapper at all", () => {
  setWidth(DESKTOP)
  render(<TurnSteps steps={[step()]} />)
  expect(document.querySelector("[data-region='turn-spine-disclosure']")).toBeNull()
  expect(screen.getByRole("list", { name: "Turn activity" })).toBeTruthy()
})

test("mobile collapses the spine behind a summary, closed by default", () => {
  setWidth(MOBILE)
  render(<TurnSteps steps={[step({ id: "a", durationMs: 400 }), step({ id: "b", durationMs: 1200 })]} />)
  const disclosure = document.querySelector("[data-region='turn-spine-disclosure']") as HTMLDetailsElement
  expect(disclosure).toBeTruthy()
  expect(disclosure.open).toBe(false)
  // The summary carries the signal the collapse hides.
  expect(screen.getByText("2 steps · 1.6s")).toBeTruthy()
  // The spine is still in the DOM (native <details> hides it), so opening needs no refetch.
  expect(within(disclosure).getByRole("list", { name: "Turn activity" })).toBeTruthy()
})

test("mobile: opening the disclosure is remembered for the next turn", () => {
  setWidth(MOBILE)
  const first = render(<TurnSteps steps={[step()]} />)
  const disclosure = document.querySelector("[data-region='turn-spine-disclosure']") as HTMLDetailsElement
  // Drive the native toggle exactly as a tap/Enter would.
  act(() => {
    disclosure.open = true
    disclosure.dispatchEvent(new Event("toggle"))
  })
  expect(sessionStorage.getItem("switchboard:turn-spine-open")).toBe("true")
  first.unmount()

  // A later turn re-mounts the component; the deliberate choice survives.
  render(<TurnSteps steps={[step({ id: "z" })]} />)
  expect((document.querySelector("[data-region='turn-spine-disclosure']") as HTMLDetailsElement).open).toBe(true)
})

test("mobile: a stored collapsed choice is honoured too", () => {
  setWidth(MOBILE)
  sessionStorage.setItem("switchboard:turn-spine-open", "false")
  render(<TurnSteps steps={[step()]} />)
  expect((document.querySelector("[data-region='turn-spine-disclosure']") as HTMLDetailsElement).open).toBe(false)
})

test("nothing renders on either layout when there are no steps and no turn states", () => {
  setWidth(MOBILE)
  const { container } = render(<TurnSteps steps={[]} events={[]} />)
  expect(container.textContent).toBe("")
})
