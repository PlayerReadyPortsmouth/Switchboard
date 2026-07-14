import "../testSetup"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentActionPreview, AgentConfigPreview } from "../types"
import { ApiError } from "../api"
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
    render(<AgentActionDialog agent="qa" action={action} baseVersion="v1" api={api} online onCancel={() => {}} onSuccess={() => {}} />)
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
    render(<AgentActionDialog agent="qa" action="restart" baseVersion="v1" api={actionApi()} online onCancel={() => {}} onSuccess={() => {}} />)
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
    render(<AgentActionDialog agent="qa" action="restart" baseVersion="v1" api={api} online onCancel={() => {}} onSuccess={() => {}} />)
    await userEvent.click(await screen.findByRole("button", { name: "Restart agent" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Restart was not confirmed")
    await userEvent.click(screen.getByRole("button", { name: "Try restart again" }))
    await waitFor(() => expect(api.confirmAgentAction).toHaveBeenCalledTimes(2))
    const calls = (api.confirmAgentAction as ReturnType<typeof mock>).mock.calls
    expect(calls[0]?.[2]).toBe(calls[1]?.[2])
  })

  test.each(["runtime_failure", "action_state_changed", "preview_not_found"])("clears consumed preview after definitive %s", async code => {
    const api = actionApi()
    api.confirmAgentAction = mock(async () => { throw new ApiError(code === "runtime_failure" ? 500 : 409, code) })
    render(<AgentActionDialog agent="qa" action="restart" baseVersion="v1" api={api} online onCancel={() => {}} onSuccess={() => {}} />)
    await userEvent.click(await screen.findByRole("button", { name: "Restart agent" }))
    expect(await screen.findByRole("button", { name: "Preview restart again" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Try restart again" })).toBeNull()
  })

  test("keeps the preview and idempotency key for an ambiguous proxy failure", async () => {
    const api = actionApi()
    let attempts = 0
    api.confirmAgentAction = mock(async () => {
      if (++attempts === 1) throw new ApiError(502, "request_failed")
      return { state: "applied" as const, agent: "qa", action: "restart" as const }
    })
    render(<AgentActionDialog agent="qa" action="restart" baseVersion="v1" api={api} online onCancel={() => {}} onSuccess={() => {}} />)
    await userEvent.click(await screen.findByRole("button", { name: "Restart agent" }))
    await userEvent.click(await screen.findByRole("button", { name: "Try restart again" }))
    const calls = (api.confirmAgentAction as ReturnType<typeof mock>).mock.calls
    expect(calls[0]?.[2]).toBe(calls[1]?.[2])
  })

  test("removal previews config=null and remains explicitly pending restart", async () => {
    const api = actionApi()
    render(<AgentActionDialog agent="qa" action="remove" baseVersion="v1" api={api} online onCancel={() => {}} onSuccess={() => {}} />)
    expect(await screen.findByText(/running agent remains until the hub restarts/)).toBeTruthy()
    expect(api.previewAgentConfig).toHaveBeenCalledWith("qa", null, "v1")
    expect((screen.getByRole("button", { name: "Save removal pending hub restart" }) as HTMLButtonElement).disabled).toBe(false)
  })

  test.each(["reset", "restart"] as const)("going offline after %s preview blocks confirmation", async action => {
    const api = actionApi()
    const view = render(<AgentActionDialog agent="qa" action={action} baseVersion="v1" api={api} online onCancel={() => {}} onSuccess={() => {}} />)
    expect(await screen.findByText("Agent is busy")).toBeTruthy()
    view.rerender(<AgentActionDialog agent="qa" action={action} baseVersion="v1" api={api} online={false} onCancel={() => {}} onSuccess={() => {}} />)
    const confirm = screen.getByRole("button", { name: action === "reset" ? "Reset agent" : "Restart agent" }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText("Agent is busy")).toBeTruthy()
    await userEvent.click(confirm)
    expect(api.confirmAgentAction).toHaveBeenCalledTimes(0)
  })

  test("Escape while confirmation is pending keeps the dialog open and focus trapped", async () => {
    let resolve!: () => void
    const api = actionApi()
    api.confirmAgentAction = mock(() => new Promise<Awaited<ReturnType<AgentActionApi["confirmAgentAction"]>>>(resolvePromise => { resolve = () => resolvePromise({ state: "applied", agent: "qa", action: "restart" }) }))
    const trigger = document.createElement("button")
    trigger.textContent = "Restart trigger"
    document.body.append(trigger)
    trigger.focus()
    const onCancel = mock(() => {})
    render(<AgentActionDialog agent="qa" action="restart" baseVersion="v1" api={api} online onCancel={onCancel} onSuccess={() => {}} />)
    await userEvent.click(await screen.findByRole("button", { name: "Restart agent" }))
    const dialog = screen.getByRole("dialog") as HTMLDialogElement
    dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }))
    await waitFor(() => expect(dialog.open).toBe(true))
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(0)
    await act(async () => { resolve(); await Promise.resolve() })
    trigger.remove()
  })
})
