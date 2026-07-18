import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import { TurnSteps, formatDuration } from "./TurnSteps"
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
