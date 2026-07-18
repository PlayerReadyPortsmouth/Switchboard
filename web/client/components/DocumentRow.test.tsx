import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DocumentSummary } from "../types"
import { DocumentRow } from "./DocumentRow"

const screen = within(document.body)
afterEach(cleanup)

const doc = (overrides: Partial<DocumentSummary> = {}): DocumentSummary => ({
  token: "tok1", filename: "report.pdf", title: "Quarterly report", contentType: "application/pdf", mode: "download",
  ownerId: "ada@example.com", ownerName: "Ada", visibility: "private",
  createdAt: "2026-07-18T00:00:00Z", expiresAt: null, conversationId: null, sizeBytes: 2048, ...overrides,
})

test("a row shows the title and a monospace size · owner · date meta line", () => {
  render(<DocumentRow document={doc()} selected={false} viewerIsOwner={false} onSelect={() => {}} />)
  expect(screen.getByText("Quarterly report")).toBeTruthy()
  expect(screen.getByText("2.0 KB · Ada · 2026-07-18")).toBeTruthy()
})

test("private and org visibility each get their own chip", () => {
  const { rerender } = render(<DocumentRow document={doc()} selected={false} viewerIsOwner={false} onSelect={() => {}} />)
  expect(document.querySelector('.document-visibility[data-visibility="private"]')?.textContent).toBe("private")
  rerender(<DocumentRow document={doc({ visibility: "org" })} selected={false} viewerIsOwner={false} onSelect={() => {}} />)
  expect(document.querySelector('.document-visibility[data-visibility="org"]')?.textContent).toBe("org")
})

test("selection is exposed on the row and to assistive tech", () => {
  render(<DocumentRow document={doc()} selected viewerIsOwner={false} onSelect={() => {}} />)
  expect(document.querySelector('.document-row[data-active="true"]')).not.toBeNull()
  expect(screen.getByRole("button", { name: /Quarterly report/ }).getAttribute("aria-current")).toBe("true")
})

test("the row carries its content-type kind for the glyph", () => {
  render(<DocumentRow document={doc({ contentType: "text/markdown", filename: "a.md" })} selected={false} viewerIsOwner={false} onSelect={() => {}} />)
  expect(document.querySelector('.document-row[data-kind="markdown"]')).not.toBeNull()
})

test("clicking the row selects it", async () => {
  const user = userEvent.setup()
  let selected = false
  render(<DocumentRow document={doc()} selected={false} viewerIsOwner={false} onSelect={() => { selected = true }} />)
  await user.click(screen.getByRole("button", { name: /Quarterly report/ }))
  expect(selected).toBe(true)
})

test("owner-only actions are shown and wired when viewerIsOwner is true", async () => {
  const user = userEvent.setup()
  let toggled = ""
  let deleted = false
  render(<DocumentRow
    document={doc({ visibility: "private" })}
    selected={false}
    viewerIsOwner
    onSelect={() => {}}
    onVisibilityToggle={next => { toggled = next }}
    onDelete={() => { deleted = true }}
  />)
  await user.click(screen.getByRole("button", { name: /make org-wide/i }))
  expect(toggled).toBe("org")
  await user.click(screen.getByRole("button", { name: /delete/i }))
  expect(deleted).toBe(true)
})

test("owner-only actions are hidden when viewerIsOwner is false", () => {
  render(<DocumentRow document={doc()} selected={false} viewerIsOwner={false} onSelect={() => {}} onVisibilityToggle={() => {}} onDelete={() => {}} />)
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull()
  expect(screen.queryByRole("button", { name: /make (org-wide|private)/i })).toBeNull()
})
