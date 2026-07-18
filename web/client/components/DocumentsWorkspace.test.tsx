import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DocumentSummary, Session, UploadDocumentResult } from "../types"
import { DocumentsWorkspace, type DocumentsApi } from "./DocumentsWorkspace"

const screen = within(document.body)
afterEach(() => { cleanup(); history.replaceState(null, "", "/documents") })

const session: Session = {
  identity: "ada@example.com",
  features: { agents: true, documents: true, turnSteps: false },
  permissions: { agents: "viewer" },
  agents: [],
}

const doc = (overrides: Partial<DocumentSummary> = {}): DocumentSummary => ({
  token: "tok1", filename: "report.pdf", title: "Report", contentType: "application/pdf", mode: "download",
  ownerId: "ada@example.com", ownerName: "Ada", visibility: "private",
  createdAt: "2026-07-18T00:00:00Z", expiresAt: null, conversationId: null, sizeBytes: 2048, ...overrides,
})

function fakeApi(options: {
  mine?: DocumentSummary[]; org?: DocumentSummary[]
  onUpload?: (file: File, opts: { title?: string; visibility?: "private" | "org" }) => void
  onSetVisibility?: (token: string, visibility: "private" | "org") => void
  onDelete?: (token: string) => void
} = {}): DocumentsApi {
  const mine = options.mine ?? [doc()]
  const org = options.org ?? [doc()]
  return {
    listDocuments: async scope => (scope === "org" ? org : mine),
    uploadDocument: async (file, opts = {}): Promise<UploadDocumentResult> => {
      options.onUpload?.(file, opts)
      return { token: "tokNew", url: "/share/tokNew" }
    },
    setDocumentVisibility: async (token, visibility) => { options.onSetVisibility?.(token, visibility); return { ok: true } },
    deleteDocument: async token => { options.onDelete?.(token); return { ok: true } },
  }
}

test("renders Mine and Org-wide tabs", async () => {
  render(<DocumentsWorkspace api={fakeApi()} session={session} />)
  await waitFor(() => expect(screen.getByRole("tab", { name: /mine/i })).toBeTruthy())
  expect(screen.getByRole("tab", { name: /org-wide/i })).toBeTruthy()
})

test("Mine tab shows the viewer's own documents", async () => {
  render(<DocumentsWorkspace api={fakeApi({ mine: [doc({ token: "m1", title: "Mine doc" })] })} session={session} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
})

test("Org-wide tab loads org-visible documents", async () => {
  const user = userEvent.setup()
  render(<DocumentsWorkspace api={fakeApi({
    mine: [doc({ token: "m1", title: "Mine doc" })],
    org: [doc({ token: "o1", title: "Org doc", ownerId: "bob@example.com", ownerName: "Bob", visibility: "org" })],
  })} session={session} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
  await user.click(screen.getByRole("tab", { name: /org-wide/i }))
  await waitFor(() => expect(screen.getByText("Org doc")).toBeTruthy())
})

test("upload input triggers uploadDocument and refreshes the list", async () => {
  const user = userEvent.setup()
  let uploaded: File | null = null
  let listCalls = 0
  const api = fakeApi({ onUpload: file => { uploaded = file } })
  const wrapped: DocumentsApi = { ...api, listDocuments: async scope => { listCalls++; return api.listDocuments(scope) } }
  render(<DocumentsWorkspace api={wrapped} session={session} />)
  await waitFor(() => expect(listCalls).toBe(1))
  const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })
  await user.upload(screen.getByLabelText(/upload/i) as HTMLInputElement, file)
  await waitFor(() => expect(uploaded).not.toBeNull())
  await waitFor(() => expect(listCalls).toBe(2))
})

test("visibility toggle calls setDocumentVisibility and refreshes", async () => {
  const user = userEvent.setup()
  let toggled: { token: string; visibility: string } | null = null
  render(<DocumentsWorkspace api={fakeApi({ mine: [doc({ token: "m1", title: "Mine doc", visibility: "private" })], onSetVisibility: (token, visibility) => { toggled = { token, visibility } } })} session={session} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
  await user.click(screen.getByRole("button", { name: /org-wide/i }))
  await waitFor(() => expect(toggled).toEqual({ token: "m1", visibility: "org" }))
})

test("delete calls deleteDocument and removes the row", async () => {
  const user = userEvent.setup()
  let deleted: string | null = null
  const state = { mine: [doc({ token: "m1", title: "Mine doc" })] }
  const api: DocumentsApi = {
    listDocuments: async () => state.mine,
    uploadDocument: async () => ({ token: "x", url: "/share/x" }),
    setDocumentVisibility: async () => ({ ok: true }),
    deleteDocument: async token => { deleted = token; state.mine = []; return { ok: true } },
  }
  render(<DocumentsWorkspace api={api} session={session} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
  await user.click(screen.getByRole("button", { name: /delete/i }))
  await waitFor(() => expect(deleted).toBe("m1"))
  await waitFor(() => expect(screen.queryByText("Mine doc")).toBeNull())
})

test("toggle and delete hidden for non-owned rows in the Org-wide tab", async () => {
  const user = userEvent.setup()
  render(<DocumentsWorkspace api={fakeApi({
    mine: [],
    org: [doc({ token: "o1", title: "Org doc", ownerId: "bob@example.com", ownerName: "Bob", visibility: "org" })],
  })} session={session} />)
  await waitFor(() => expect(screen.getByRole("tab", { name: /org-wide/i })).toBeTruthy())
  await user.click(screen.getByRole("tab", { name: /org-wide/i }))
  await waitFor(() => expect(screen.getByText("Org doc")).toBeTruthy())
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull()
  expect(screen.queryByRole("button", { name: /make (private|org-wide)/i })).toBeNull()
})
