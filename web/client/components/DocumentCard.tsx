import { useState, type JSX } from "react"
import { documentBadge, documentKind, formatSize } from "./DocumentViewer"

export interface DocumentCardProps {
  token: string
  title: string
  contentType: string
  mode: string
  visibility: "private" | "org"
  /** Real filename when the caller has one. Transcript attachments do not carry it, so the
   *  title stands in — published documents are normally named for the file they came from. */
  filename?: string
  ownerName?: string
  sizeBytes?: number
  /** Source for an inline image preview. Omit it and images fall back to the type badge. */
  thumbnailUrl?: string
  /** Prefix for the `/share/:token` fallback link, used only when `onOpen` is absent. */
  raBase?: string
  /** In-page open. When supplied the whole card is a button and nothing leaves the page —
   *  the Documents viewer built in #41 renders the bytes. Without it the card degrades to a
   *  `/share` link in a new tab. */
  onOpen?(token: string): void
}

/** One published document, rendered as a self-contained card. Used inline in the transcript,
 *  where it has to read as a tappable artifact among message text rather than as another row
 *  in a list — hence the surface and border, where `DocumentRow` (a real list) stays flat.
 *  Badge, size and visibility chip all use the Documents workspace's vocabulary so the two
 *  surfaces teach the same language. */
export function DocumentCard(props: DocumentCardProps): JSX.Element {
  const { token, title, contentType, mode, visibility, filename, ownerName, sizeBytes, thumbnailUrl, raBase = "/", onOpen } = props
  const [thumbBroken, setThumbBroken] = useState(false)
  const nameForKind = filename ?? title
  const kind = documentKind(contentType, nameForKind)
  const badge = documentBadge(contentType, nameForKind)
  const showThumb = kind === "image" && !!thumbnailUrl && !thumbBroken
  const shareUrl = `${raBase.replace(/\/$/, "")}/share/${encodeURIComponent(token)}`
  // The kind is only worth spelling out when the name doesn't already give it away — otherwise
  // "sprint-notes.md" ends up badged MD and captioned "markdown", saying one thing three times.
  const nameShowsKind = /\.[a-z][a-z0-9]{0,7}$/i.test(nameForKind.trim())
  const meta = [
    sizeBytes === undefined ? null : formatSize(sizeBytes),
    ownerName || null,
    nameShowsKind ? null : kind,
  ].filter(Boolean).join(" · ")

  const face = <>
    {showThumb
      ? <img className="document-card-thumb" src={thumbnailUrl} alt="" onError={() => setThumbBroken(true)} />
      : <span className="document-card-badge" aria-hidden="true">{badge}</span>}
    <span className="document-card-copy">
      <span className="document-card-title" title={title}>{title}</span>
      <span className="document-card-meta">{meta}</span>
    </span>
    <span className="document-visibility" data-visibility={visibility}>{visibility === "org" ? "org" : "private"}</span>
  </>

  return (
    <article className="document-card" data-kind={kind} data-visibility={visibility}>
      {onOpen
        ? <button type="button" className="document-card-open" onClick={() => onOpen(token)}>{face}</button>
        : (
          <a
            className="document-card-open"
            href={shareUrl}
            {...(mode === "download" ? { download: "" } : { target: "_blank", rel: "noopener noreferrer" })}
          >{face}</a>
        )}
    </article>
  )
}
