import type { JSX } from "react"
import type { DocumentSummary } from "../types"
import { documentKind, formatDate, formatSize, KIND_GLYPH } from "./DocumentViewer"

/** One row in the documents list. Selection is a button (not a link) because the viewer opens
 *  in-page; the URL is pushed by the workspace so the row still has a real, refreshable route. */
export function DocumentRow({ document: item, selected, viewerIsOwner, rowRef, onSelect, onVisibilityToggle, onDelete }: {
  document: DocumentSummary
  selected: boolean
  viewerIsOwner: boolean
  rowRef?: (element: HTMLButtonElement | null) => void
  onSelect(): void
  onVisibilityToggle?(next: "private" | "org"): void
  onDelete?(): void
}): JSX.Element {
  const kind = documentKind(item.contentType, item.filename)
  return (
    <div className="document-row" data-active={selected} data-kind={kind}>
      <button
        ref={rowRef}
        type="button"
        className="document-row-select"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="document-glyph" aria-hidden="true">{KIND_GLYPH[kind]}</span>
        <span className="document-row-copy">
          <strong>{item.title}</strong>
          <small>{formatSize(item.sizeBytes)} · {item.ownerName || item.ownerId} · {formatDate(item.createdAt)}</small>
        </span>
        <span className="document-visibility" data-visibility={item.visibility}>{item.visibility === "org" ? "org" : "private"}</span>
      </button>
      {viewerIsOwner ? (
        <div className="document-row-actions">
          <button type="button" onClick={() => onVisibilityToggle?.(item.visibility === "org" ? "private" : "org")}>
            {item.visibility === "org" ? "Make private" : "Make org-wide"}
          </button>
          <button type="button" className="danger-action" onClick={() => onDelete?.()}>Delete</button>
        </div>
      ) : null}
    </div>
  )
}
