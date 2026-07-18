import type { JSX } from "react"

export interface DocumentCardProps {
  token: string
  title: string
  contentType: string
  mode: string
  visibility: "private" | "org"
  ownerName?: string
  sizeBytes?: number
  viewerIsOwner: boolean
  raBase?: string
  onVisibilityToggle?: (next: "private" | "org") => void
  onDelete?: () => void
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function DocumentCard(props: DocumentCardProps): JSX.Element {
  const { token, title, contentType, mode, visibility, ownerName, sizeBytes, viewerIsOwner, raBase = "/" } = props
  const shareUrl = `${raBase.replace(/\/$/, "")}/share/${encodeURIComponent(token)}`
  const isImage = contentType.startsWith("image/")
  const isDownload = mode === "download"

  const linkProps = isDownload
    ? { download: "" }
    : { target: "_blank", rel: "noopener noreferrer" }

  return (
    <div className="document-card">
      <a className="document-card-link" href={shareUrl} {...linkProps}>
        {isImage
          ? <img className="document-card-thumb" src={shareUrl} alt={title} />
          : (
            <span className="document-card-meta">
              <span className="document-card-title">{title}</span>
              {sizeBytes !== undefined ? <span className="document-card-size">{formatSize(sizeBytes)}</span> : null}
            </span>
          )}
      </a>
      {ownerName ? <span className="document-card-owner">{ownerName}</span> : null}
      {viewerIsOwner && (
        <div className="document-card-actions">
          <button
            type="button"
            onClick={() => props.onVisibilityToggle?.(visibility === "org" ? "private" : "org")}
          >
            {visibility === "org" ? "Make private" : "Make org-wide"}
          </button>
          <button type="button" onClick={() => props.onDelete?.()}>Delete</button>
        </div>
      )}
    </div>
  )
}
