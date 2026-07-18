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
  text?: string
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
    documentContentUrl: token => `/api/documents/${encodeURIComponent(token)}/content`,
    fetchDocumentText: async () => options.text ?? "",
  }
}

const shellProps = { routeToken: null, connection: "live" as const, onNavigate: () => {}, onNewConversation: () => {} }

test("renders inside the app shell with the navigation rail", async () => {
  render(<DocumentsWorkspace api={fakeApi()} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByRole("tab", { name: /mine/i })).toBeTruthy())
  expect(document.querySelector('[data-region="application-navigation"]')).not.toBeNull()
  expect(screen.getByRole("link", { name: "Documents" }).getAttribute("aria-current")).toBe("page")
  expect(screen.getByRole("link", { name: "Conversations" })).toBeTruthy()
})

test("renders Mine and Org-wide tabs", async () => {
  render(<DocumentsWorkspace api={fakeApi()} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByRole("tab", { name: /mine/i })).toBeTruthy())
  expect(screen.getByRole("tab", { name: /org-wide/i })).toBeTruthy()
})

test("Mine tab shows the viewer's own documents", async () => {
  render(<DocumentsWorkspace api={fakeApi({ mine: [doc({ token: "m1", title: "Mine doc" })] })} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
})

test("Org-wide tab loads org-visible documents", async () => {
  const user = userEvent.setup()
  render(<DocumentsWorkspace api={fakeApi({
    mine: [doc({ token: "m1", title: "Mine doc" })],
    org: [doc({ token: "o1", title: "Org doc", ownerId: "bob@example.com", ownerName: "Bob", visibility: "org" })],
  })} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
  await user.click(screen.getByRole("tab", { name: /org-wide/i }))
  await waitFor(() => expect(screen.getByText("Org doc")).toBeTruthy())
})

test("selecting a row opens the viewer pane in place and pushes the document route", async () => {
  const user = userEvent.setup()
  const navigated: Array<[string, string | null | undefined]> = []
  render(<DocumentsWorkspace
    api={fakeApi({ mine: [doc({ token: "m1", title: "Mine doc", filename: "notes.md", contentType: "text/markdown" })], text: "# Heading" })}
    session={session}
    {...shellProps}
    onNavigate={(destination, token) => navigated.push([destination, token])}
  />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
  expect(screen.getByRole("heading", { name: "Nothing open" })).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /Mine doc/ }))
  await waitFor(() => expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy())
  expect(navigated).toEqual([["documents", "m1"]])
  expect(document.querySelector('[data-region="document-viewer"]')?.getAttribute("data-kind")).toBe("markdown")
})

test("routeToken opens the matching document without a click", async () => {
  render(<DocumentsWorkspace
    api={fakeApi({ mine: [doc({ token: "m1", title: "Deep linked", filename: "notes.md", contentType: "text/markdown" })], text: "hello" })}
    session={session}
    {...shellProps}
    routeToken="m1"
  />)
  await waitFor(() => expect(screen.getByRole("heading", { name: "Deep linked" })).toBeTruthy())
})

test("upload input triggers uploadDocument and refreshes the list", async () => {
  const user = userEvent.setup()
  let uploaded: File | null = null
  let listCalls = 0
  const api = fakeApi({ onUpload: file => { uploaded = file } })
  const wrapped: DocumentsApi = { ...api, listDocuments: async scope => { listCalls++; return api.listDocuments(scope) } }
  render(<DocumentsWorkspace api={wrapped} session={session} {...shellProps} />)
  await waitFor(() => expect(listCalls).toBe(1))
  const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })
  await user.upload(screen.getByLabelText(/upload/i) as HTMLInputElement, file)
  await waitFor(() => expect(uploaded).not.toBeNull())
  await waitFor(() => expect(listCalls).toBe(2))
})

test("the drop zone marks its drag state", async () => {
  render(<DocumentsWorkspace api={fakeApi()} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByRole("tab", { name: /mine/i })).toBeTruthy())
  const zone = document.querySelector(".documents-dropzone") as HTMLElement
  expect(zone.getAttribute("data-dragging")).toBe("false")
})

test("visibility toggle calls setDocumentVisibility and refreshes", async () => {
  const user = userEvent.setup()
  let toggled: { token: string; visibility: string } | null = null
  render(<DocumentsWorkspace api={fakeApi({ mine: [doc({ token: "m1", title: "Mine doc", visibility: "private" })], onSetVisibility: (token, visibility) => { toggled = { token, visibility } } })} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByText("Mine doc")).toBeTruthy())
  await user.click(screen.getByRole("button", { name: /make org-wide/i }))
  await waitFor(() => expect(toggled).toEqual({ token: "m1", visibility: "org" }))
})

test("delete calls deleteDocument and removes the row", async () => {
  const user = userEvent.setup()
  let deleted: string | null = null
  const state = { mine: [doc({ token: "m1", title: "Mine doc" })] }
  const api: DocumentsApi = {
    ...fakeApi(),
    listDocuments: async () => state.mine,
    deleteDocument: async token => { deleted = token; state.mine = []; return { ok: true } },
  }
  render(<DocumentsWorkspace api={api} session={session} {...shellProps} />)
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
  })} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByRole("tab", { name: /org-wide/i })).toBeTruthy())
  await user.click(screen.getByRole("tab", { name: /org-wide/i }))
  await waitFor(() => expect(screen.getByText("Org doc")).toBeTruthy())
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull()
  expect(screen.queryByRole("button", { name: /make (private|org-wide)/i })).toBeNull()
})

test("the empty state tells the viewer what to do next", async () => {
  render(<DocumentsWorkspace api={fakeApi({ mine: [] })} session={session} {...shellProps} />)
  await waitFor(() => expect(screen.getByRole("heading", { name: /your library is empty/i })).toBeTruthy())
  expect(screen.getByText(/drag a file into the box above/i)).toBeTruthy()
})
