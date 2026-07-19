import { useId, type JSX } from "react"
import type { DocumentAttachment, Message } from "../types"
import { DocumentCard } from "./DocumentCard"

/** How a card reaches the Documents viewer, threaded down from the workspace. */
export interface AttachmentCardDeps {
  /** In-page open. Absent ⇒ the cards degrade to `/share/:token` links. */
  onOpenDocument?(token: string): void
  /** Inline image previews only. */
  documentContentUrl?(token: string): string
}

/** One labelled group of document cards.
 *
 *  Rendered in two places, deliberately with the same markup: nested inside the agent message
 *  that produced the documents, and — for anything not yet anchored to a message — once at the
 *  tail of the transcript. Sharing the component is what keeps a card looking the same in both
 *  positions; only the surrounding CSS differs. */
export function TranscriptAttachments(
  { attachments, nested = false, onOpenDocument, documentContentUrl }:
  { attachments: DocumentAttachment[]; nested?: boolean } & AttachmentCardDeps,
): JSX.Element | null {
  const headingId = `attachments-${useId()}`
  if (!attachments.length) return null
  return (
    <section
      className="transcript-attachments"
      aria-labelledby={headingId}
      data-region="transcript-attachments"
      data-nested={String(nested)}
    >
      <p className="eyebrow" id={headingId}>
        {attachments.length === 1 ? "1 document shared" : `${attachments.length} documents shared`}
      </p>
      <ul className="transcript-attachment-list">
        {attachments.map(attachment => (
          <li key={attachment.token}>
            <DocumentCard
              token={attachment.token}
              title={attachment.title}
              contentType={attachment.contentType}
              mode={attachment.mode}
              visibility={attachment.visibility === "org" ? "org" : "private"}
              {...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes })}
              thumbnailUrl={documentContentUrl?.(attachment.token)}
              {...(onOpenDocument ? { onOpen: onOpenDocument } : {})}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

export interface AnchoredAttachments {
  /** message id → the cards that belong inside that message. */
  byMessage: Map<string, DocumentAttachment[]>
  /** Cards with no agent message to sit under yet — rendered after the transcript. */
  trailing: DocumentAttachment[]
}

/** Attach each document to the agent message it belongs to, by adjacency.
 *
 *  The anchor is the nearest agent message at or AFTER the document's `createdAt`, which looks
 *  backwards until you follow the turn lifecycle: an agent publishes mid-turn, over the MCP
 *  shim, while it is still working — its reply message is only committed once the turn ends
 *  (hub/conversations/turnCoordinator.ts). So a document is always stamped BEFORE the reply it
 *  belongs to, and "nearest preceding agent message" would reliably hang it off the PREVIOUS
 *  turn's reply. Nearest following is the rule that matches how the data is actually produced.
 *
 *  Live, between the publish and the reply landing, there is no following agent message yet —
 *  those cards fall to `trailing` and re-seat themselves under the reply when it arrives, which
 *  is the correct reading at both moments.
 *
 *  This is adjacency, not linkage: documents carry a `conversation_id` but no message id, so
 *  two turns whose publishes and replies interleave can misattribute. Fixing that properly
 *  means back-stamping a message id onto the document when the reply commits — see the PR. */
export function anchorAttachments(messages: Message[], attachments: DocumentAttachment[]): AnchoredAttachments {
  const byMessage = new Map<string, DocumentAttachment[]>()
  const trailing: DocumentAttachment[] = []
  const agentMessages = messages.filter(message => message.origin === "agent")
  for (const attachment of attachments) {
    const anchor = agentMessages.find(message => message.createdAt >= attachment.createdAt)
    if (!anchor) { trailing.push(attachment); continue }
    const bucket = byMessage.get(anchor.id)
    if (bucket) bucket.push(attachment)
    else byMessage.set(anchor.id, [attachment])
  }
  return { byMessage, trailing }
}
