import type { Message } from "../types"
import { MessageItem } from "./MessageItem"

const FIVE_MINUTES = 5 * 60 * 1000

export function canonicalMessages(messages: Message[]): Message[] {
  const unique = new Map<string, Message>()
  for (const message of messages) unique.set(message.id, message)
  return [...unique.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
}

export function Transcript({ messages, onReply }: { messages: Message[]; onReply(message: Message): void }) {
  const canonical = canonicalMessages(messages)
  const byId = new Map(canonical.map(message => [message.id, message]))
  if (!canonical.length) return <div className="transcript-record transcript-record-empty"><p>No messages yet. The canonical record will appear here after a message is accepted.</p></div>
  return (
    <div className="transcript-record">
      {canonical.map((message, index) => {
        const previous = canonical[index - 1]
        const grouped = Boolean(previous && previous.author === message.author && !previous.replyTo && !message.replyTo && message.createdAt - previous.createdAt <= FIVE_MINUTES)
        return <MessageItem key={message.id} message={message} grouped={grouped} parent={message.replyTo ? byId.get(message.replyTo) : undefined} onReply={onReply} />
      })}
    </div>
  )
}
