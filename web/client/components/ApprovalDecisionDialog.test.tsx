import "../testSetup"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act, cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiError } from "../api"
import type {
  ApprovalDecision,
  ApprovalDecisionResult,
  ApprovalDetail,
  ApprovalListPage,
  ApprovalListQuery,
  ConnectionState,
  Session,
  WorkspaceRole,
} from "../types"
import { ApprovalDecisionDialog } from "./ApprovalDecisionDialog"
import { ApprovalsWorkspace, type ApprovalsApi } from "./ApprovalsWorkspace"

const screen = within(document.body)
const NOW = 1_700_000_000_000

const approval = (overrides: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  id: "approval-1",
  version: "v1",
  kind: "outbound_http",
  target: "https://hooks.example.com/deploy",
  summary: "Deploy the release candidate",
  risk: "elevated",
  requestedBy: { surface: "agent", id: "architect@example.com" },
  createdAt: NOW - 60_000,
  expiresAt: NOW + 300_000,
  terminalAt: null,
  state: "pending",
  execution: "not_applicable",
  conversationId: "conversation/1",
  detail: { method: "POST", hostname: "hooks.example.com", fingerprints: ["sha256:release"] },
  executionDetail: null,
  decisionBy: null,
  decisionAt: null,
  outcomeReason: null,
  audit: [],
  permissions: { canDecide: true },
  ...overrides,
})

function session(role: WorkspaceRole = "operator", overrides: Partial<Session["approvalState"]> = {}): Session {
  return {
    identity: "operator@example.com",
    agents: [],
    features: { agents: false, approvals: true },
    permissions: { agents: "hidden", approvals: role },
    approvalState: { producing: true, canDecide: role === "operator", pendingCount: 1, ...overrides },
  }
}

function page(item: ApprovalDetail): ApprovalListPage {
  return { items: [item], nextCursor: null, pendingCount: item.state === "pending" ? 1 : 0, querySummary: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function approvalApi(options: {
  initial?: ApprovalDetail
  get?: (id: string, call: number) => Promise<ApprovalDetail>
  decide?: (decision: ApprovalDecision, expectedVersion: string, idempotencyKey: string, call: number) => Promise<ApprovalDecisionResult>
} = {}) {
  const initial = options.initial ?? approval()
  const calls = {
    list: [] as ApprovalListQuery[],
    get: [] as string[],
    decisions: [] as Array<{ approvalId: string; decision: ApprovalDecision; expectedVersion: string; idempotencyKey: string }>,
  }
  const api: ApprovalsApi = {
    listApprovals: async query => { calls.list.push({ ...query }); return page(initial) },
    getApproval: async id => {
      calls.get.push(id)
      return options.get ? options.get(id, calls.get.length) : { ...initial, id }
    },
    decideApproval: async (approvalId, decision, expectedVersion, idempotencyKey) => {
      calls.decisions.push({ approvalId, decision, expectedVersion, idempotencyKey })
      return options.decide
        ? options.decide(decision, expectedVersion, idempotencyKey, calls.decisions.length)
        : { approval: approval({ id: approvalId, version: "v2", state: decision === "grant" ? "granted" : "denied", execution: decision === "grant" ? "succeeded" : "not_applicable", terminalAt: NOW, decisionBy: { surface: "web", id: "operator@example.com" }, decisionAt: NOW }) }
    },
  }
  return { api, calls }
}

function renderDialog(value: ApprovalDetail, decision: ApprovalDecision, options: {
  submitting?: boolean
  error?: string
  onCancel?: () => void
  onConfirm?: () => void
} = {}) {
  const props = {
    approval: value,
    decision,
    submitting: options.submitting ?? false,
    error: options.error ?? "",
    onCancel: options.onCancel ?? (() => {}),
    onConfirm: options.onConfirm ?? (() => {}),
  }
  const view = render(<ApprovalDecisionDialog {...props} />)
  return {
    ...view,
    rerenderApproval(nextApproval: ApprovalDetail, nextDecision: ApprovalDecision) {
      view.rerender(<ApprovalDecisionDialog {...props} approval={nextApproval} decision={nextDecision} />)
    },
  }
}

function renderWorkspace(options: {
  approval?: ApprovalDetail
  api?: ApprovalsApi
  session?: Session
  connection?: ConnectionState
  revision?: number
} = {}) {
  const fixture = options.api ? null : approvalApi({ initial: options.approval })
  const api = options.api ?? fixture!.api
  const workspaceSession = options.session ?? session()
  const connection = options.connection ?? "live"
  const revision = options.revision ?? 0
  const view = render(<ApprovalsWorkspace
    api={api}
    session={workspaceSession}
    routeApprovalId="approval-1"
    connection={connection}
    revision={revision}
    pendingCount={1}
    onNavigate={() => {}}
    onNewConversation={() => {}}
  />)
  return { ...view, api: fixture?.calls ?? null, rerenderRevision(nextRevision: number) {
    view.rerender(<ApprovalsWorkspace api={api} session={workspaceSession} routeApprovalId="approval-1" connection={connection} revision={nextRevision} pendingCount={0} onNavigate={() => {}} onNewConversation={() => {}} />)
  } }
}

afterEach(cleanup)

describe("ApprovalDecisionDialog", () => {
  test("every grant confirms the exact effect and destructive grant strengthens copy", () => {
    const view = renderDialog(approval({ risk: "elevated" }), "grant")
    expect(screen.getByRole("dialog").textContent).toContain("Deploy the release candidate")
    expect(screen.getByRole("dialog").textContent).toContain("hooks.example.com")
    expect(screen.getByRole("dialog").textContent).toContain("POST")
    expect(screen.getByRole("dialog").textContent).toContain("sha256:release")
    view.rerenderApproval(approval({ risk: "destructive" }), "grant")
    expect(screen.getByRole("dialog").textContent).toMatch(/destructive|irreversible/i)
  })

  test("pending submission refuses Escape dismissal and cancel restores the invoker", async () => {
    const trigger = document.createElement("button")
    trigger.textContent = "Grant"
    document.body.append(trigger)
    trigger.focus()
    const onCancel = mock(() => {})
    const view = renderDialog(approval(), "grant", { submitting: true, onCancel })
    const dialog = screen.getByRole("dialog") as HTMLDialogElement
    dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }))
    expect(onCancel).toHaveBeenCalledTimes(0)
    expect(dialog.open).toBe(true)
    view.rerender(<ApprovalDecisionDialog approval={approval()} decision="grant" submitting={false} error="" onCancel={onCancel} onConfirm={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    trigger.remove()
  })
})

describe("protected approval decisions", () => {
  test("low-risk denial is direct while elevated and destructive denial confirm", async () => {
    const low = approvalApi({ initial: approval({ risk: "low" }) })
    const direct = renderWorkspace({ api: low.api })
    await userEvent.click(await screen.findByRole("button", { name: "Deny" }))
    await waitFor(() => expect(low.calls.decisions).toHaveLength(1))
    expect(screen.queryByRole("dialog")).toBeNull()
    direct.unmount()

    renderWorkspace({ approval: approval({ risk: "elevated" }) })
    await userEvent.click(await screen.findByRole("button", { name: "Deny" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  test("viewers and approver-excluded operators see no decision controls", async () => {
    const viewer = renderWorkspace({ session: session("viewer") })
    expect(await screen.findByRole("heading", { name: "Deploy the release candidate" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^(Grant|Deny)$/ })).toBeNull()
    viewer.unmount()

    const excluded = approvalApi({ initial: approval({ permissions: { canDecide: false } }) })
    renderWorkspace({ api: excluded.api, session: session("operator") })
    expect(await screen.findByRole("heading", { name: "Deploy the release candidate" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^(Grant|Deny)$/ })).toBeNull()
  })

  test("offline and in-flight actions are disabled with a textual explanation", async () => {
    const offline = renderWorkspace({ connection: "offline" })
    expect(await screen.findByText("Reconnect to decide this approval.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true)
    offline.unmount()

    const pending = deferred<ApprovalDecisionResult>()
    const fixture = approvalApi({ decide: async () => pending.promise })
    renderWorkspace({ api: fixture.api })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    expect((await screen.findByRole("status", { name: "Approval decision status" })).textContent).toContain("Decision in progress")
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Granting…" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      pending.resolve({ approval: approval({ state: "granted", execution: "succeeded", version: "v2", terminalAt: NOW }) })
      await pending.promise
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  test("core-disabled production keeps operator controls visible but disabled with guidance", async () => {
    renderWorkspace({ session: session("operator", { producing: false, canDecide: true }) })
    expect(await screen.findByText("Core approval production is off; decisions are disabled.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("double submission uses one request and one UUID for the attempt", async () => {
    const original = globalThis.crypto.randomUUID
    const randomUUID = mock(() => "attempt-1" as `${string}-${string}-${string}-${string}-${string}`)
    globalThis.crypto.randomUUID = randomUUID
    try {
      const pending = deferred<ApprovalDecisionResult>()
      const fixture = approvalApi({ decide: async () => pending.promise })
      renderWorkspace({ api: fixture.api })
      await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
      expect(randomUUID).toHaveBeenCalledTimes(0)
      const confirm = screen.getByRole("button", { name: "Grant approval" })
      act(() => {
        confirm.click()
        confirm.click()
      })
      await waitFor(() => expect(fixture.calls.decisions).toHaveLength(1))
      expect(randomUUID).toHaveBeenCalledTimes(1)
      expect(fixture.calls.decisions[0]?.idempotencyKey).toBe("attempt-1")
      await act(async () => {
        pending.resolve({ approval: approval({ state: "granted", execution: "succeeded", version: "v2", terminalAt: NOW }) })
        await pending.promise
      })
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    } finally {
      globalThis.crypto.randomUUID = original
    }
  })

  test("ambiguous failure reloads canonical detail and reuses the key only for the same pending version", async () => {
    const original = globalThis.crypto.randomUUID
    const randomUUID = mock(() => "attempt-1" as `${string}-${string}-${string}-${string}-${string}`)
    globalThis.crypto.randomUUID = randomUUID
    try {
      const fixture = approvalApi({
        get: async () => approval(),
        decide: async (_decision, _version, _key, call) => {
          if (call === 1) throw new ApiError(0, "request_failed")
          return { approval: approval({ state: "granted", execution: "succeeded", version: "v2", terminalAt: NOW }) }
        },
      })
      renderWorkspace({ api: fixture.api })
      await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
      await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
      expect(await screen.findByRole("button", { name: "Try grant again" })).toBeTruthy()
      expect(fixture.calls.get).toHaveLength(2)
      await userEvent.click(screen.getByRole("button", { name: "Try grant again" }))
      await waitFor(() => expect(fixture.calls.decisions).toHaveLength(2))
      expect(fixture.calls.decisions[0]?.idempotencyKey).toBe(fixture.calls.decisions[1]?.idempotencyKey)
      expect(randomUUID).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.crypto.randomUUID = original
    }
  })

  test("ambiguous reload to a changed pending version clears the old key before a new attempt", async () => {
    const original = globalThis.crypto.randomUUID
    const keys = ["attempt-1", "attempt-2"]
    const randomUUID = mock(() => keys.shift()! as `${string}-${string}-${string}-${string}-${string}`)
    globalThis.crypto.randomUUID = randomUUID
    try {
      const fixture = approvalApi({
        get: async (_id, call) => call === 1 ? approval() : approval({ version: "v2" }),
        decide: async (_decision, _version, _key, call) => {
          if (call === 1) throw new ApiError(502, "request_failed")
          return { approval: approval({ state: "granted", execution: "succeeded", version: "v3", terminalAt: NOW }) }
        },
      })
      renderWorkspace({ api: fixture.api })
      await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
      await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      await userEvent.click(screen.getByRole("button", { name: "Grant" }))
      await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
      await waitFor(() => expect(fixture.calls.decisions).toHaveLength(2))
      expect(fixture.calls.decisions.map(call => call.idempotencyKey)).toEqual(["attempt-1", "attempt-2"])
      expect(randomUUID).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.crypto.randomUUID = original
    }
  })

  test("a newer revision superseding ambiguous reconciliation does not leave controls locked", async () => {
    const staleReload = deferred<ApprovalDetail>()
    const fixture = approvalApi({
      get: async (_id, call) => call === 1 ? approval() : call === 2 ? staleReload.promise : approval({ version: "v2" }),
      decide: async () => { throw new ApiError(0, "request_failed") },
    })
    const view = renderWorkspace({ api: fixture.api, revision: 0 })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    await waitFor(() => expect(fixture.calls.get).toHaveLength(2))

    view.rerenderRevision(1)
    await waitFor(() => expect(fixture.calls.get).toHaveLength(3))
    await act(async () => {
      staleReload.resolve(approval())
      await staleReload.promise
    })

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false)
  })

  test("a newer same-version revision proves an ambiguous attempt is safe to retry", async () => {
    const staleReload = deferred<ApprovalDetail>()
    const fixture = approvalApi({
      get: async (_id, call) => call === 1 ? approval() : call === 2 ? staleReload.promise : approval(),
      decide: async () => { throw new ApiError(0, "request_failed") },
    })
    const view = renderWorkspace({ api: fixture.api, revision: 0 })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    await waitFor(() => expect(fixture.calls.get).toHaveLength(2))

    view.rerenderRevision(1)
    await waitFor(() => expect(fixture.calls.get).toHaveLength(3))
    await act(async () => {
      staleReload.resolve(approval())
      await staleReload.promise
    })

    expect(await screen.findByRole("button", { name: "Try grant again" })).toBeTruthy()
    expect(screen.getByRole("status", { name: "Approval decision status" }).textContent).toContain("still pending")
  })

  test("ambiguous reload failure disables controls with exact reload guidance", async () => {
    const fixture = approvalApi({
      get: async (_id, call) => {
        if (call === 1) return approval()
        throw new ApiError(503, "request_failed")
      },
      decide: async () => { throw new ApiError(0, "request_failed") },
    })
    renderWorkspace({ api: fixture.api })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    expect(await screen.findByText("Reload approval before retrying.")).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect((screen.getByRole("button", { name: "Grant" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test.each(["stale_version", "expired", "interrupted", "already_resolved", "idempotency_conflict"])("409 %s reloads canonical state, clears the attempt, and never auto-submits", async code => {
    const terminal = approval({ version: "v2", state: code === "expired" ? "expired" : code === "interrupted" ? "interrupted" : "denied", execution: "not_applicable", terminalAt: NOW })
    const fixture = approvalApi({
      get: async (_id, call) => call === 1 ? approval() : terminal,
      decide: async () => { throw new ApiError(409, code, { canonical: terminal }) },
    })
    renderWorkspace({ api: fixture.api })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(fixture.calls.get).toHaveLength(2)
    expect(fixture.calls.decisions).toHaveLength(1)
    expect(screen.getByRole("region", { name: "Approval detail" }).textContent).toMatch(/discarded without running/i)
  })

  test("guards an unknown conflict payload before using canonical as a display hint", async () => {
    const terminal = approval({ version: "v2", state: "denied", terminalAt: NOW })
    const fixture = approvalApi({
      get: async (_id, call) => call === 1 ? approval() : terminal,
      decide: async () => { throw new ApiError(409, "already_resolved", { canonical: "<script>not an approval</script>" }) },
    })
    renderWorkspace({ api: fixture.api })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    expect(await screen.findByText(/discarded without running/i)).toBeTruthy()
    expect(document.querySelector("script")).toBeNull()
    expect(fixture.calls.get).toHaveLength(2)
  })

  test.each([
    [approval({ state: "granted", execution: "failed", version: "v2", terminalAt: NOW }), /approval succeeded, but delivery failed/i],
    [approval({ state: "granted", execution: "interrupted", version: "v2", terminalAt: NOW }), /execution outcome unknown/i],
    [approval({ state: "denied", execution: "not_applicable", version: "v2", terminalAt: NOW }), /held effect was discarded without running/i],
    [approval({ state: "expired", execution: "not_applicable", version: "v2", terminalAt: NOW }), /held effect was discarded without running/i],
    [approval({ state: "interrupted", execution: "not_applicable", version: "v2", terminalAt: NOW }), /held effect was discarded without running/i],
  ] as const)("presents canonical terminal outcome %# truthfully", async (terminal, message) => {
    const fixture = approvalApi({ decide: async () => ({ approval: terminal }) })
    renderWorkspace({ api: fixture.api })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    await userEvent.click(screen.getByRole("button", { name: "Grant approval" }))
    expect(await screen.findByText(message)).toBeTruthy()
    if (terminal.state === "granted" && terminal.execution === "interrupted") {
      expect(screen.queryByRole("button", { name: /retry/i })).toBeNull()
    }
  })

  test("revision terminal resolution closes the dialog and moves focus to a safe detail control", async () => {
    let current = approval()
    const fixture = approvalApi({ get: async () => current })
    const view = renderWorkspace({ api: fixture.api, revision: 0 })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    current = approval({ version: "v2", state: "expired", terminalAt: NOW })
    view.rerenderRevision(1)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect((await screen.findByRole("status", { name: "Approval decision status" })).textContent).toContain("Approval expired")
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to approvals" })))
  })

  test("revision terminal resolution focuses the detail region when the responsive Back control is hidden", async () => {
    let current = approval()
    const fixture = approvalApi({ get: async () => current })
    const view = renderWorkspace({ api: fixture.api, revision: 0 })
    await userEvent.click(await screen.findByRole("button", { name: "Grant" }))
    const back = screen.getByRole("button", { name: "Back to approvals" }) as HTMLButtonElement
    back.style.display = "none"
    current = approval({ version: "v2", state: "denied", terminalAt: NOW })
    view.rerenderRevision(1)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Approval detail"))
  })
})
