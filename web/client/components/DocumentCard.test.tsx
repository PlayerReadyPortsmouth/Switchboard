import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DocumentCard, type DocumentCardProps } from "./DocumentCard"

const screen = within(document.body)
afterEach(cleanup)

const props = (overrides: Partial<DocumentCardProps> = {}): DocumentCardProps => ({
  token: "tok/1", title: "Quarterly report", contentType: "application/pdf", mode: "download",
  visibility: "private", ownerName: "Ada", sizeBytes: 2048, viewerIsOwner: false, ...overrides,
})

test("image content-type renders an img thumbnail pointed at the /share URL", () => {
  render(<DocumentCard {...props({ contentType: "image/png", title: "Photo", mode: "view" })} />)
  const image = screen.getByRole("img") as HTMLImageElement
  expect(image.getAttribute("src")).toBe("/share/tok%2F1")
  expect(image.getAttribute("alt")).toBe("Photo")
})

test("non-image content-type renders a title + size, not an img", () => {
  render(<DocumentCard {...props({ sizeBytes: 2048 })} />)
  expect(screen.queryByRole("img")).toBeNull()
  expect(screen.getByText("Quarterly report")).toBeTruthy()
  expect(screen.getByText("2.0 KB")).toBeTruthy()
})

test("mode:download gives the anchor a download attribute", () => {
  render(<DocumentCard {...props({ mode: "download" })} />)
  const link = screen.getByRole("link") as HTMLAnchorElement
  expect(link.hasAttribute("download")).toBe(true)
  expect(link.getAttribute("href")).toBe("/share/tok%2F1")
})

test("mode:view opens the /share URL in a new tab with no download attribute", () => {
  render(<DocumentCard {...props({ mode: "view" })} />)
  const link = screen.getByRole("link") as HTMLAnchorElement
  expect(link.hasAttribute("download")).toBe(false)
  expect(link.getAttribute("target")).toBe("_blank")
  expect(link.getAttribute("rel")).toContain("noopener")
})

test("a non-root raBase prefixes the /share URL", () => {
  render(<DocumentCard {...props({ raBase: "https://app.example/" })} />)
  expect((screen.getByRole("link") as HTMLAnchorElement).getAttribute("href")).toBe("https://app.example/share/tok%2F1")
})

test("owner-only actions are shown and wired when viewerIsOwner is true", async () => {
  const user = userEvent.setup()
  let toggled = ""
  let deleted = false
  render(<DocumentCard {...props({ viewerIsOwner: true, visibility: "private", onVisibilityToggle: next => { toggled = next }, onDelete: () => { deleted = true } })} />)
  await user.click(screen.getByRole("button", { name: /org-wide/i }))
  expect(toggled).toBe("org")
  await user.click(screen.getByRole("button", { name: /delete/i }))
  expect(deleted).toBe(true)
})

test("owner-only actions are hidden when viewerIsOwner is false", () => {
  render(<DocumentCard {...props({ viewerIsOwner: false, onVisibilityToggle: () => {}, onDelete: () => {} })} />)
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull()
  expect(screen.queryByRole("button", { name: /org-wide|private/i })).toBeNull()
})
