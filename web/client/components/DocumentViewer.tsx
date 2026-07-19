import { useEffect, useRef, useState, type JSX, type RefObject } from "react"
import { ApiError } from "../api"
import type { DocumentSummary } from "../types"
import { Markdown } from "./Markdown"

export type DocumentKind = "markdown" | "image" | "pdf" | "csv" | "text" | "binary"

/** Which in-page renderer a document gets. SVG is excluded from the image branch on purpose:
 *  the hub already refuses to serve it inline, and it would be script-capable if it did. */
export function documentKind(contentType: string, filename: string): DocumentKind {
  const type = contentType.toLowerCase()
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image"
  if (type === "application/pdf") return "pdf"
  if (type === "text/markdown" || /\.(?:md|markdown)$/i.test(filename)) return "markdown"
  if (type === "text/csv" || /\.csv$/i.test(filename)) return "csv"
  if (type.startsWith("text/")) return "text"
  return "binary"
}

export const KIND_GLYPH: Record<DocumentKind, string> = {
  markdown: "▤", image: "▣", pdf: "▦", csv: "▥", text: "≡", binary: "◆",
}

/** Content types whose subtype makes a poor badge ("MARK", "PLAI", "OCTE"). Everything else
 *  reads fine truncated, so only the offenders are listed. */
const SUBTYPE_BADGE: Record<string, string> = {
  markdown: "MD", plain: "TXT", jpeg: "JPG", "octet-stream": "BIN", javascript: "JS", typescript: "TS",
}

/** Short mono type badge — the file's extension when there is one, otherwise the content-type
 *  subtype. Capped at four characters so the badge box never reflows between rows. Callers
 *  without a real filename can pass the title: published documents are usually named for the
 *  file they came from, so `notes.md` still resolves to `MD`. */
export function documentBadge(contentType: string, filename: string): string {
  // Must start with a letter, so a version-suffixed title like "plan v1.2" falls through to
  // the content type rather than badging itself "2".
  const extension = /\.([a-z][a-z0-9]{0,7})$/i.exec(filename.trim())?.[1]
  if (extension) return extension.slice(0, 4).toUpperCase()
  const subtype = contentType.toLowerCase().split(";")[0].split("/")[1]?.replace(/^x-/, "").replace(/\+.*$/, "") ?? ""
  return (SUBTYPE_BADGE[subtype] ?? subtype.slice(0, 4) ?? "").toUpperCase() || "FILE"
}

export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
}

export const formatDate = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10)
}

/** RFC-4180-ish: comma separated, `"` quoting, `""` escapes a quote inside a quoted field. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') { field += char; continue }
      if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ",") { row.push(field); field = ""; continue }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      row.push(field); rows.push(row); row = []; field = ""
      continue
    }
    field += char
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

export interface DocumentViewerApi {
  documentContentUrl(token: string): string
  fetchDocumentText(token: string): Promise<string>
}

type TextState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "error"; reason: "forbidden" | "missing" | "unavailable" }

export function DocumentViewer({ document: selected, api, hidden, closeRef, onBack }: {
  document: DocumentSummary | null
  api: DocumentViewerApi
  hidden?: boolean
  closeRef?: RefObject<HTMLButtonElement | null>
  onBack(): void
}): JSX.Element {
  const [text, setText] = useState<TextState>({ status: "idle" })
  const generation = useRef(0)
  const kind = selected ? documentKind(selected.contentType, selected.filename) : null
  const needsText = kind === "markdown" || kind === "text" || kind === "csv"
  const token = selected?.token ?? null

  useEffect(() => {
    if (!token || !needsText) { setText({ status: "idle" }); return }
    const current = ++generation.current
    setText({ status: "loading" })
    void api.fetchDocumentText(token).then(
      value => { if (current === generation.current) setText({ status: "ready", text: value }) },
      error => {
        if (current !== generation.current) return
        const status = error instanceof ApiError ? error.status : 0
        setText({ status: "error", reason: status === 403 ? "forbidden" : status === 404 ? "missing" : "unavailable" })
      },
    )
    return () => { generation.current++ }
  }, [api, needsText, token])

  if (!selected || !kind) {
    return (
      <section className="document-viewer" data-open="false" aria-hidden={hidden || undefined} data-region="document-viewer">
        <div className="document-viewer-empty">
          <h2>Nothing open</h2>
          <p>Pick a document from the list to read it here. Nothing leaves this page.</p>
        </div>
      </section>
    )
  }

  const contentUrl = api.documentContentUrl(selected.token)
  return (
    <section className="document-viewer" data-open={hidden ? "false" : "true"} data-kind={kind} aria-hidden={hidden || undefined} aria-label={selected.title} data-region="document-viewer">
      <header className="document-viewer-header">
        <button ref={closeRef} type="button" className="document-back" onClick={onBack}>Back to documents</button>
        <div className="document-viewer-title">
          <p className="eyebrow">{selected.visibility === "org" ? "Org-wide" : "Private"} · {kind}</p>
          <h2>{selected.title}</h2>
          <p className="document-viewer-meta">{formatSize(selected.sizeBytes)} · {selected.ownerName || selected.ownerId} · {formatDate(selected.createdAt)}</p>
        </div>
        <a className="document-download" href={contentUrl} download={selected.filename}>Download</a>
      </header>
      <div className="document-viewer-body">
        {kind === "image" ? <img className="document-image" src={contentUrl} alt={selected.title} />
          : kind === "pdf" ? (
            <object className="document-pdf" data={contentUrl} type="application/pdf" aria-label={selected.title}>
              <p className="document-fallback">This browser will not display the PDF in page. <a href={contentUrl} download={selected.filename}>Download {selected.filename}</a> instead.</p>
            </object>
          )
          : kind === "binary" ? (
            <div className="document-fallback">
              <p>There is no safe in-page view for <code>{selected.filename}</code> ({selected.contentType}).</p>
              <a className="document-download-large" href={contentUrl} download={selected.filename}>Download {formatSize(selected.sizeBytes)}</a>
            </div>
          )
          : <TextBody state={text} kind={kind} filename={selected.filename} />}
      </div>
    </section>
  )
}

/** The text-shaped branches (markdown / plain / CSV) share one fetch, so they share one
 *  loading-and-error surface too. */
function TextBody({ state, kind, filename }: { state: TextState; kind: DocumentKind; filename: string }): JSX.Element {
  if (state.status === "idle" || state.status === "loading") {
    return <p className="document-viewer-status" role="status">Loading {filename}…</p>
  }
  if (state.status === "error") {
    return <p className="document-viewer-status" role="alert">
      {state.reason === "forbidden" ? "This document is private to its owner."
        : state.reason === "missing" ? "This document is no longer on disk."
        : "The document could not be loaded. Try again."}
    </p>
  }
  if (kind === "markdown") return <Markdown source={state.text} />
  if (kind === "csv") return <CsvTable text={state.text} />
  return <pre className="document-plain">{state.text}</pre>
}

function CsvTable({ text }: { text: string }): JSX.Element {
  const rows = parseCsv(text)
  if (rows.length === 0) return <p className="document-viewer-status">This file is empty.</p>
  const [header, ...body] = rows
  return (
    <div className="markdown-table-scroll">
      <table className="document-csv">
        <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}
