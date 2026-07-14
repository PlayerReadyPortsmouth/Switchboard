import "../testSetup"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentActionPreview, AgentConfigPreview } from "../types"
import { AgentActionDialog, type AgentActionApi } from "./AgentActionDialog"

const screen = within(document.body)

const actionPreview = (action: "reset" | "restart"): AgentActionPreview => ({
  id: `preview-${action}`, actor: "operator@example.com", agent: "qa", action,
  statusVersion: "v1", impact: { busy: true, queueDepth: 4 }, expiresAt: Date.now() + 60_000,
})

function actionApi(): AgentActionApi {
  return {
    previewAgentAction: mock(async (_agent, action) => actionPreview(action)),
    confirmAgentAction: mock(async (_agent, _id, _key) => ({ state: "applied" as const, agent: "qa", action: "reset" as const })),
    previewAgentConfig: mock(async (): Promise<AgentConfigPreview> => ({
      id: "preview-remove", before: null, after: null,
      classification: { tier: "restart", fullRestart: ["-agent:qa"] }, expiresAt: Date.now() + 60_000,
    })),
    confirmAgentConfig: mock(async () => ({ state: "applied" as const, restarted: [], fullRestart: ["-agent:qa"] })),
  }
}

afterEach(cleanup)

describe("AgentActionDialog", () => {
  test.each(["reset", "restart"] as const)("previews %s impact before enabling confirmation", async action => {
    const api = actionApi()
    render(<AgentActionDialog agent="qa" action={action} api={api} onCancel={() => {}} onSuccess={() => {}} />)
    expect(screen.getByRole("status").textContent).toContain("Checking current impact")
    expect(await screen.findByText("Agent is busy")).toBeTruthy()
    expect(screen.getByText("4 queued requests")).toBeTruthy()
    expect(api.previewAgentAction).toHaveBeenCalledWith("qa", action)
    expect(screen.getByText(action === "reset" ? /clears resumable context/ : /keeps the session file/)).toBeTruthy()
  })

  test("restores trigger focus on cancel", async () => {
    const trigger = document.createElement("button")
    trigger.textContent = "Restart agent"
    document.body.append(trigger)
    trigger.focus()
    render(<AgentActionDialog agent="qa" action="restart" api={actionApi()} onCancel={() => {}} onSuccess={() => {}} />)
    await screen.findByText("Agent is busy")
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    trigger.remove()
  })

  test("retains one idempotency key across a failed confirmation retry", async () => {
    const api = actionApi()
    let attempts = 0
    api.confirmAgentAction = mock(async () => {
      attempts++
      if (attempts === 1) throw new Error("offline")
      return { state: "applied" as const, agent: "qa", action: "restart" as const }
    })
    render(<AgentActionDialog agent="qa" action="restart" api={api} onCancel={() => {}} onSuccess={() => {}} />)
    await userEvent.click(await screen.findByRole("button", { name: "Restart agent" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Restart was not confirmed")
    await userEvent.click(screen.getByRole("button", { name: "Try restart again" }))
    await waitFor(() => expect(api.confirmAgentAction).toHaveBeenCalledTimes(2))
    const calls = (api.confirmAgentAction as ReturnType<typeof mock>).mock.calls
    expect(calls[0]?.[2]).toBe(calls[1]?.[2])
  })

  test("removal previews config=null and remains explicitly pending restart", async () => {
    const api = actionApi()
    render(<AgentActionDialog agent="qa" action="remove" api={api} onCancel={() => {}} onSuccess={() => {}} />)
    expect(await screen.findByText(/running agent remains until the hub restarts/)).toBeTruthy()
    expect(api.previewAgentConfig).toHaveBeenCalledWith("qa", null)
    expect((screen.getByRole("button", { name: "Save removal pending hub restart" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
