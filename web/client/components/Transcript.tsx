import type { DocumentAttachment, Message } from "../types"
import { MessageItem } from "./MessageItem"
import { TranscriptAttachments, anchorAttachments, type AttachmentCardDeps } from "./TranscriptAttachments"

const FIVE_MINUTES = 5 * 60 * 1000

export function canonicalMessages(messages: Message[]): Message[] {
  const unique = new Map<string, Message>()
  for (const message of messages) unique.set(message.id, message)
  return [...unique.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

export function Transcript({ messages, onReply, attachments = [], onOpenDocument, documentContentUrl }: {
  messages: Message[]
  onReply(message: Message): void
  attachments?: DocumentAttachment[]
} & AttachmentCardDeps) {
  const canonical = canonicalMessages(messages)
  const byId = new Map(canonical.map(message => [message.id, message]))
  // Cards are anchored to the agent message that produced them and rendered inside it; only
  // the ones with no message to sit under yet fall through to the trailing group below.
  const { byMessage, trailing } = anchorAttachments(canonical, attachments)
  const cardDeps = {
    ...(onOpenDocument ? { onOpenDocument } : {}),
    ...(documentContentUrl ? { documentContentUrl } : {}),
  }
  if (!canonical.length && !trailing.length) return <div className="transcript-record transcript-record-empty"><p>No messages yet. The canonical record will appear here after a message is accepted.</p></div>
  return (
    <div className="transcript-record">
      {canonical.map((message, index) => {
        const previous = canonical[index - 1]
        const timestampDelta = previous ? message.createdAt - previous.createdAt : -1
        const grouped = Boolean(previous && previous.author === message.author && !previous.replyTo && !message.replyTo && timestampDelta >= 0 && timestampDelta <= FIVE_MINUTES)
        return <MessageItem
          key={message.id}
          message={message}
          grouped={grouped}
          parent={message.replyTo ? byId.get(message.replyTo) : undefined}
          onReply={onReply}
          attachments={byMessage.get(message.id) ?? []}
          {...cardDeps}
        />
      })}
      <TranscriptAttachments attachments={trailing} {...cardDeps} />
    </div>
  )
}
