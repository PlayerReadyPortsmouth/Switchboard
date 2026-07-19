import "../testSetup"
import { afterEach, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import { safeUrl } from "../markdown"
import { Markdown } from "./Markdown"

const screen = within(document.body)
afterEach(cleanup)

test("headings, emphasis, code and lists render as elements", () => {
  render(<Markdown source={"# Title\n\nSome **bold** and *soft* and `code`.\n\n- one\n- two\n\n1. first\n2. second"} />)
  expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy()
  expect(document.querySelector("strong")?.textContent).toBe("bold")
  expect(document.querySelector("em")?.textContent).toBe("soft")
  expect(document.querySelector("code")?.textContent).toBe("code")
  expect(document.querySelectorAll("ul li").length).toBe(2)
  expect(document.querySelectorAll("ol li").length).toBe(2)
})

test("fenced code keeps its content verbatim and records the language", () => {
  render(<Markdown source={"```ts\nconst a = 1 < 2 && 3 > 2\n```"} />)
  const pre = document.querySelector("pre") as HTMLElement
  expect(pre.getAttribute("data-language")).toBe("ts")
  expect(pre.textContent).toBe("const a = 1 < 2 && 3 > 2")
})

test("pipe tables render as a real table", () => {
  render(<Markdown source={"| name | note |\n| --- | --- |\n| Ada | first |"} />)
  expect(screen.getByRole("columnheader", { name: "name" })).toBeTruthy()
  expect(screen.getByRole("cell", { name: "first" })).toBeTruthy()
})

test("blockquotes and rules render", () => {
  render(<Markdown source={"> quoted line\n\n---"} />)
  expect(document.querySelector("blockquote")?.textContent).toBe("quoted line")
  expect(document.querySelector("hr")).not.toBeNull()
})

test("raw HTML in the source is inert text, never markup", () => {
  render(<Markdown source={'<img src=x onerror="alert(1)"><script>alert(2)</script>Hello'} />)
  expect(document.querySelector("script")).toBeNull()
  expect(document.querySelector("img")).toBeNull()
  expect(document.body.textContent).toContain("alert(1)")
})

test("javascript: and data: links are stripped but their text survives", () => {
  render(<Markdown source={"[click](javascript:alert(1)) and [pic](data:text/html,<script>1</script>)"} />)
  expect(document.querySelectorAll("a").length).toBe(0)
  expect(document.body.textContent).toContain("click")
  expect(document.body.textContent).toContain("pic")
})

test("http links render with a safe rel and open out of page", () => {
  render(<Markdown source={"[docs](https://example.com/a)"} />)
  const link = screen.getByRole("link", { name: "docs" }) as HTMLAnchorElement
  expect(link.getAttribute("href")).toBe("https://example.com/a")
  expect(link.getAttribute("rel")).toContain("noopener")
  expect(link.getAttribute("target")).toBe("_blank")
})

test("image sources are scheme-checked; a rejected one degrades to its alt text", () => {
  render(<Markdown source={"![safe](https://example.com/a.png)\n\n![unsafe](javascript:alert(1))"} />)
  const images = document.querySelectorAll("img")
  expect(images.length).toBe(1)
  expect(images[0].getAttribute("src")).toBe("https://example.com/a.png")
  expect(document.body.textContent).toContain("unsafe")
})

// --- chat variant -----------------------------------------------------------------------
// A transcript message is prose typed into a box, so it follows Discord/GFM soft-break
// semantics rather than CommonMark's "a single newline is a space".

test("chat variant turns single newlines into hard breaks", () => {
  render(<Markdown source={"first line\nsecond line\nthird line"} variant="chat" />)
  const paragraph = document.querySelector("p") as HTMLElement
  expect(paragraph.querySelectorAll("br").length).toBe(2)
  expect(paragraph.textContent).toBe("first linesecond linethird line")
})

test("document variant leaves single newlines as CommonMark soft breaks", () => {
  render(<Markdown source={"first line\nsecond line"} />)
  expect(document.querySelectorAll("br").length).toBe(0)
})

test("chat hard breaks survive inside emphasis", () => {
  render(<Markdown source={"**bold one\nbold two**"} variant="chat" />)
  const strong = document.querySelector("strong") as HTMLElement
  expect(strong.querySelectorAll("br").length).toBe(1)
})

test("chat variant damps headings well below document scale", () => {
  render(<Markdown source={"# Not a page title"} variant="chat" />)
  expect(document.querySelector("h2")).toBeNull()
  expect(document.querySelector("h4")?.textContent).toBe("Not a page title")
})

test("chat variant shows the fenced language quietly beside the code", () => {
  render(<Markdown source={"```ts\nconst a = 1\n```"} variant="chat" />)
  expect(document.querySelector(".markdown-code-language")?.textContent).toBe("ts")
  // The label lives outside the <pre> so it neither scrolls with nor pollutes the code text.
  expect((document.querySelector("pre") as HTMLElement).textContent).toBe("const a = 1")
})

test("chat variant renders bold, italic, inline code, links and lists as real elements", () => {
  render(<Markdown source={"**b** and *i* and `c` and [d](https://example.com)\n\n- one\n- two"} variant="chat" />)
  expect(document.querySelector("strong")?.textContent).toBe("b")
  expect(document.querySelector("em")?.textContent).toBe("i")
  expect(document.querySelector("code")?.textContent).toBe("c")
  expect(screen.getByRole("link", { name: "d" })).toBeTruthy()
  expect(document.querySelectorAll("ul li").length).toBe(2)
})

test("chat variant keeps injected markup and javascript: links inert", () => {
  render(<Markdown source={'<script>alert(1)</script>[x](javascript:alert(2))'} variant="chat" />)
  expect(document.querySelector("script")).toBeNull()
  expect(document.querySelectorAll("a").length).toBe(0)
  expect(document.body.textContent).toContain("alert(1)")
})

test("safeUrl allowlists schemes and rejects protocol-relative URLs", () => {
  expect(safeUrl("https://example.com")).toBe("https://example.com")
  expect(safeUrl("mailto:a@b.co")).toBe("mailto:a@b.co")
  expect(safeUrl("/documents/x")).toBe("/documents/x")
  expect(safeUrl("#anchor")).toBe("#anchor")
  expect(safeUrl("//evil.example")).toBeNull()
  expect(safeUrl("  javascript:alert(1)")).toBeNull()
  expect(safeUrl("JaVaScRiPt:alert(1)")).toBeNull()
  expect(safeUrl("data:text/html,<script>1</script>")).toBeNull()
  expect(safeUrl("vbscript:msgbox")).toBeNull()
})
