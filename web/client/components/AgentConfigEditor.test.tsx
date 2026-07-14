import "../testSetup"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiError } from "../api"
import type { AgentConfigPreview, EditableAgentConfig } from "../types"
import { AgentConfigEditor, type AgentConfigApi } from "./AgentConfigEditor"

const screen = within(document.body)
const setTextarea = (element: HTMLElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value)
  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
})
const configured = { redacted: true as const, configured: true as const }
const config: EditableAgentConfig = {
  emoji: "🧪",
  description: "Release verification",
  mode: "persistent",
  access: { roles: ["viewer"] },
  runtime: {
    cwd: "/workspace/qa",
    model: "gpt-5",
    resumable: true,
    useMemory: false,
    injectContext: "onSwitch",
    maxQueueDepth: 3,
    pool: { min: 1, max: 2 },
    claudeArgs: configured,
    appendSystemPrompt: configured,
  },
}

const preview = (tier: "safe" | "hard" | "restart", after: EditableAgentConfig | null = config): AgentConfigPreview => ({
  id: `preview-${tier}`,
  before: config,
  after,
  classification: { tier, fullRestart: tier === "restart" ? ["unapplied:description"] : [] },
  expiresAt: Date.now() + 60_000,
})

function apiFor(tier: "safe" | "hard" | "restart" = "safe"): AgentConfigApi {
  return {
    previewAgentConfig: mock(async (_name, next) => preview(tier, next as EditableAgentConfig)),
    confirmAgentConfig: mock(async () => ({ state: "applied" as const, restarted: [], fullRestart: [] })),
  }
}

afterEach(cleanup)

describe("AgentConfigEditor", () => {
  test("guided edits and valid Advanced JSON update the same draft without exposing configured values", async () => {
    const api = apiFor()
    render(<AgentConfigEditor agent="qa" config={config} api={api} online onApplied={() => {}} onReload={() => {}} />)

    expect(screen.getAllByText("Configured · preserved")).toHaveLength(2)
    await userEvent.clear(screen.getByLabelText("Description"))
    await userEvent.type(screen.getByLabelText("Description"), "Release specialist")
    await userEvent.click(screen.getByRole("button", { name: "Advanced JSON" }))
    expect((screen.getByLabelText("Agent configuration JSON") as HTMLTextAreaElement).value).toContain("Release specialist")

    const edited = JSON.stringify({ ...config, emoji: "🚀", runtime: { ...config.runtime, claudeArgs: ["--verbose"] } }, null, 2)
    setTextarea(screen.getByLabelText("Agent configuration JSON"), edited)
    await userEvent.click(screen.getByRole("button", { name: "Guided" }))
    expect((screen.getByLabelText("Emoji") as HTMLInputElement).value).toBe("🚀")
    expect((screen.getByLabelText("Claude arguments") as HTMLInputElement).value).toBe("--verbose")
  })

  test("invalid JSON or constructed redaction objects disable Preview without discarding the last valid draft", async () => {
    render(<AgentConfigEditor agent="qa" config={config} api={apiFor()} online onApplied={() => {}} onReload={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Advanced JSON" }))
    const textarea = screen.getByLabelText("Agent configuration JSON")
    setTextarea(textarea, "{not json")
    expect(screen.getByRole("alert").textContent).toContain("Enter valid JSON")
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(true)

    setTextarea(textarea, JSON.stringify({ ...config, runtime: { ...config.runtime, claudeArgs: { redacted: true } } }))
    expect(screen.getByRole("alert").textContent).toContain("Claude arguments")
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("does not allow a configured sentinel to be constructed for an unset server value", async () => {
    const withoutSecret = { ...config, runtime: { ...config.runtime, claudeArgs: undefined } }
    render(<AgentConfigEditor agent="qa" config={withoutSecret} api={apiFor()} online onApplied={() => {}} onReload={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Advanced JSON" }))
    setTextarea(screen.getByLabelText("Agent configuration JSON"), JSON.stringify({ ...withoutSecret, runtime: { ...withoutSecret.runtime, claudeArgs: configured } }))
    expect(screen.getByRole("alert").textContent).toContain("can only preserve")
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test.each([
    ["safe" as const, "Changes can apply live", "Apply changes"],
    ["hard" as const, "Agent restart required", "Apply and restart agent"],
    ["restart" as const, "Full hub restart required", "Save pending hub restart"],
  ])("uses the %s server classification for confirmation copy", async (tier, heading, button) => {
    const api = apiFor(tier)
    render(<AgentConfigEditor agent="qa" config={config} api={api} online onApplied={() => {}} onReload={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Preview changes" }))
    expect(await screen.findByText(heading)).toBeTruthy()
    expect((screen.getByRole("button", { name: button }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(/Before/)).toBeTruthy()
    expect(screen.getByText(/After/)).toBeTruthy()
    if (tier === "restart") expect(screen.getByText("unapplied:description")).toBeTruthy()
  })

  test("a stale confirmation preserves the draft and offers a current-config reload", async () => {
    const onReload = mock(() => {})
    const api = apiFor("safe")
    api.confirmAgentConfig = mock(async () => { throw new ApiError(409, "stale_preview") })
    const view = render(<AgentConfigEditor agent="qa" config={config} api={api} online onApplied={() => {}} onReload={onReload} />)
    await userEvent.clear(screen.getByLabelText("Description"))
    await userEvent.type(screen.getByLabelText("Description"), "Keep this draft")
    await userEvent.click(screen.getByRole("button", { name: "Preview changes" }))
    await userEvent.click(await screen.findByRole("button", { name: "Apply changes" }))
    expect((await screen.findByRole("alert")).textContent).toContain("current configuration changed")
    await userEvent.click(screen.getByRole("button", { name: "Reload current configuration" }))
    expect(onReload).toHaveBeenCalledTimes(1)
    view.rerender(<AgentConfigEditor agent="qa" config={{ ...config, description: "Server changed" }} api={api} online onApplied={() => {}} onReload={onReload} />)
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Keep this draft")
  })

  test("offline mode preserves edits while disabling preview", async () => {
    const view = render(<AgentConfigEditor agent="qa" config={config} api={apiFor()} online onApplied={() => {}} onReload={() => {}} />)
    await userEvent.clear(screen.getByLabelText("Description"))
    await userEvent.type(screen.getByLabelText("Description"), "Local draft")
    view.rerender(<AgentConfigEditor agent="qa" config={config} api={apiFor()} online={false} onApplied={() => {}} onReload={() => {}} />)
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Local draft")
    expect((screen.getByRole("button", { name: "Preview changes" }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(screen.getByText(/Reconnect to preview/)).toBeTruthy())
  })
})
