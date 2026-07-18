import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, waitFor, within } from "@testing-library/react"
import { ApiError } from "../api"
import type { DocumentSummary } from "../types"
import { DocumentViewer, documentKind, parseCsv, type DocumentViewerApi } from "./DocumentViewer"

const screen = within(document.body)
afterEach(cleanup)

const doc = (overrides: Partial<DocumentSummary> = {}): DocumentSummary => ({
  token: "tok1", filename: "report.pdf", title: "Report", contentType: "application/pdf", mode: "view",
  ownerId: "ada@example.com", ownerName: "Ada", visibility: "private",
  createdAt: "2026-07-18T00:00:00Z", expiresAt: null, conversationId: null, sizeBytes: 2048, ...overrides,
})

const api = (text: string | Promise<string> = ""): DocumentViewerApi => ({
  documentContentUrl: token => `/api/documents/${encodeURIComponent(token)}/content`,
  fetchDocumentText: async () => await text,
})

test("documentKind maps each supported content type", () => {
  expect(documentKind("text/markdown", "a.md")).toBe("markdown")
  expect(documentKind("text/plain", "notes.md")).toBe("markdown")
  expect(documentKind("image/png", "a.png")).toBe("image")
  expect(documentKind("application/pdf", "a.pdf")).toBe("pdf")
  expect(documentKind("text/csv", "a.csv")).toBe("csv")
  expect(documentKind("text/plain", "a.txt")).toBe("text")
  expect(documentKind("application/octet-stream", "a.zip")).toBe("binary")
  // SVG is script-capable, so it never takes the inline image branch.
  expect(documentKind("image/svg+xml", "a.svg")).toBe("binary")
})

test("no selection shows the invitation, not a blank pane", () => {
  render(<DocumentViewer document={null} api={api()} onBack={() => {}} />)
  expect(screen.getByRole("heading", { name: "Nothing open" })).toBeTruthy()
})

test("markdown renders as styled elements in page", async () => {
  render(<DocumentViewer document={doc({ contentType: "text/markdown", filename: "notes.md", title: "Notes" })} api={api("# Title\n\nSome **bold** text.")} onBack={() => {}} />)
  await waitFor(() => expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy())
  expect(document.querySelector(".markdown-body strong")?.textContent).toBe("bold")
})

test("images render inline from the content endpoint", () => {
  render(<DocumentViewer document={doc({ contentType: "image/png", filename: "shot.png", title: "Shot" })} api={api()} onBack={() => {}} />)
  const image = screen.getByRole("img") as HTMLImageElement
  expect(image.getAttribute("src")).toBe("/api/documents/tok1/content")
  expect(image.getAttribute("alt")).toBe("Shot")
})

test("PDFs embed an object with a download fallback", () => {
  render(<DocumentViewer document={doc()} api={api()} onBack={() => {}} />)
  const object = document.querySelector("object.document-pdf") as HTMLObjectElement
  expect(object.getAttribute("data")).toBe("/api/documents/tok1/content")
  expect(object.getAttribute("type")).toBe("application/pdf")
  expect(within(object).getByRole("link", { name: /download report\.pdf/i })).toBeTruthy()
})

test("plain text renders readably, not as markdown", async () => {
  render(<DocumentViewer document={doc({ contentType: "text/plain", filename: "log.txt" })} api={api("line one\n# not a heading")} onBack={() => {}} />)
  await waitFor(() => expect(document.querySelector(".document-plain")?.textContent).toBe("line one\n# not a heading"))
  expect(document.querySelector(".markdown-body")).toBeNull()
})

test("CSV renders as a table", async () => {
  render(<DocumentViewer document={doc({ contentType: "text/csv", filename: "rows.csv" })} api={api('name,note\nAda,"a, b"')} onBack={() => {}} />)
  await waitFor(() => expect(screen.getByRole("columnheader", { name: "name" })).toBeTruthy())
  expect(screen.getByRole("cell", { name: "a, b" })).toBeTruthy()
})

test("unknown types get a clean download affordance instead of a render", () => {
  render(<DocumentViewer document={doc({ contentType: "application/octet-stream", filename: "bundle.zip", title: "Bundle" })} api={api()} onBack={() => {}} />)
  expect(screen.getByRole("link", { name: /download 2\.0 KB/i })).toBeTruthy()
  expect(document.querySelector(".markdown-body")).toBeNull()
})

test("a 403 on the content feed is reported as owner-only, not a generic failure", async () => {
  const forbidden: DocumentViewerApi = {
    documentContentUrl: token => `/api/documents/${token}/content`,
    fetchDocumentText: () => Promise.reject(new ApiError(403, "forbidden")),
  }
  render(<DocumentViewer document={doc({ contentType: "text/markdown", filename: "secret.md" })} api={forbidden} onBack={() => {}} />)
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("private to its owner"))
})

test("parseCsv handles quoted commas and escaped quotes", () => {
  expect(parseCsv('a,b\n"x,y","he said ""hi"""')).toEqual([["a", "b"], ["x,y", 'he said "hi"']])
})
