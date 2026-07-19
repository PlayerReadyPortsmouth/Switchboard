import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DocumentCard, type DocumentCardProps } from "./DocumentCard"

const screen = within(document.body)
afterEach(cleanup)

const props = (overrides: Partial<DocumentCardProps> = {}): DocumentCardProps => ({
  token: "tok/1", title: "Quarterly report", contentType: "application/pdf", mode: "download",
  visibility: "private", ...overrides,
})

test("shows a mono type badge derived from the filename extension", () => {
  render(<DocumentCard {...props({ title: "Sprint notes", filename: "sprint-notes.md", contentType: "text/markdown" })} />)
  expect(screen.getByText("MD")).toBeTruthy()
})

test("falls back to the content type when the name carries no extension", () => {
  render(<DocumentCard {...props({ title: "Ori test file", contentType: "text/markdown" })} />)
  expect(screen.getByText("MD")).toBeTruthy()
})

test("uses the title as the filename when no filename is supplied", () => {
  render(<DocumentCard {...props({ title: "test-file.csv", contentType: "text/plain" })} />)
  expect(screen.getByText("CSV")).toBeTruthy()
})

test("renders title, size and kind, with size omitted when unknown", () => {
  render(<DocumentCard {...props({ sizeBytes: 2048 })} />)
  expect(screen.getByText("Quarterly report")).toBeTruthy()
  expect(screen.getByText("2.0 KB · pdf")).toBeTruthy()
  cleanup()
  render(<DocumentCard {...props()} />)
  expect(screen.getByText("pdf")).toBeTruthy()
  expect(screen.queryByText(/KB/)).toBeNull()
})

test("a private document is chipped private", () => {
  render(<DocumentCard {...props({ visibility: "private" })} />)
  const chip = screen.getByText("private")
  expect(chip.getAttribute("data-visibility")).toBe("private")
})

test("an org document is chipped org", () => {
  render(<DocumentCard {...props({ visibility: "org" })} />)
  const chip = screen.getByText("org")
  expect(chip.getAttribute("data-visibility")).toBe("org")
})

test("onOpen makes the whole card one button that opens in page", async () => {
  const user = userEvent.setup()
  const opened: string[] = []
  render(<DocumentCard {...props({ onOpen: token => opened.push(token) })} />)
  expect(screen.queryByRole("link")).toBeNull()
  await user.click(screen.getByRole("button", { name: /Quarterly report/ }))
  expect(opened).toEqual(["tok/1"])
})

test("without onOpen the card degrades to a /share link", () => {
  render(<DocumentCard {...props({ mode: "download" })} />)
  const link = screen.getByRole("link") as HTMLAnchorElement
  expect(link.getAttribute("href")).toBe("/share/tok%2F1")
  expect(link.hasAttribute("download")).toBe(true)
})

test("mode:view opens the /share fallback in a new tab with no download attribute", () => {
  render(<DocumentCard {...props({ mode: "view" })} />)
  const link = screen.getByRole("link") as HTMLAnchorElement
  expect(link.hasAttribute("download")).toBe(false)
  expect(link.getAttribute("target")).toBe("_blank")
  expect(link.getAttribute("rel")).toContain("noopener")
})

test("a non-root raBase prefixes the /share fallback URL", () => {
  render(<DocumentCard {...props({ raBase: "https://app.example/" })} />)
  expect((screen.getByRole("link") as HTMLAnchorElement).getAttribute("href")).toBe("https://app.example/share/tok%2F1")
})

test("an image with a thumbnail URL previews inline, and falls back to the badge if it fails", () => {
  render(<DocumentCard {...props({ title: "Photo", contentType: "image/png", thumbnailUrl: "/api/documents/tok%2F1/content" })} />)
  const image = document.querySelector("img.document-card-thumb") as HTMLImageElement
  expect(image).toBeTruthy()
  expect(image.getAttribute("src")).toBe("/api/documents/tok%2F1/content")
  fireEvent.error(image)
  expect(screen.getByText("PNG")).toBeTruthy()
})

test("an image without a thumbnail URL shows the badge, not a broken img", () => {
  render(<DocumentCard {...props({ title: "Photo", contentType: "image/png" })} />)
  expect(document.querySelector("img")).toBeNull()
  expect(screen.getByText("PNG")).toBeTruthy()
})
