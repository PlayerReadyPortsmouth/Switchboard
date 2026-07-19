import type { DocumentAttachment, Message } from "../types"
import { Markdown } from "./Markdown"
import { TranscriptAttachments, type AttachmentCardDeps } from "./TranscriptAttachments"

const originLabel = { web: "Web", agent: "Agent", transport: "Transport", system: "System" } as const

export function MessageItem({ message, grouped, parent, onReply, attachments = [], onOpenDocument, documentContentUrl }: {
  message: Message
  grouped: boolean
  parent?: Message
  onReply(message: Message): void
  /** Documents this message produced. Rendered INSIDE the article so they sit within the
   *  message's origin stripe and read as part of the agent's reply, not as a floating band. */
  attachments?: DocumentAttachment[]
} & AttachmentCardDeps) {
  const label = `Message from ${message.author} (${originLabel[message.origin]})`
  return (
    <article className={`message-item message-origin-${message.origin}`} aria-label={label} data-grouped={String(grouped)}>
      <header>
        <strong>{message.author}</strong>
        <span className="message-meta"><span>{originLabel[message.origin]}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{message.state}</span></span>
      </header>
      {parent ? <blockquote className="message-reply">Replying to {parent.author}: {parent.content}</blockquote> : null}
      {/* Every origin renders markdown, including the reader's own messages — Discord makes no
          distinction, and a user who types `**bold**` means bold there too. */}
      <div className="message-body"><Markdown source={message.content} variant="chat" /></div>
      <TranscriptAttachments
        attachments={attachments}
        nested
        {...(onOpenDocument ? { onOpenDocument } : {})}
        {...(documentContentUrl ? { documentContentUrl } : {})}
      />
      <button type="button" className="message-reply-action" onClick={() => onReply(message)} aria-label={`Reply to message from ${message.author}`}>Reply</button>
    </article>
  )
}
