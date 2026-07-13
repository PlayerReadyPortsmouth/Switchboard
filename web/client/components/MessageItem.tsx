import type { Message } from "../types"

const originLabel = { web: "Web", agent: "Agent", transport: "Transport", system: "System" } as const

export function MessageItem({ message, grouped, parent, onReply }: { message: Message; grouped: boolean; parent?: Message; onReply(message: Message): void }) {
  const label = `Message from ${message.author} (${originLabel[message.origin]})`
  return (
    <article className={`message-item message-origin-${message.origin}`} aria-label={label} data-grouped={String(grouped)}>
      <header>
        <strong>{message.author}</strong>
        <span className="message-meta"><span>{originLabel[message.origin]}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span>{message.state}</span></span>
      </header>
      {parent ? <blockquote className="message-reply">Replying to {parent.author}: {parent.content}</blockquote> : null}
      <p>{message.content}</p>
      <button type="button" className="message-reply-action" onClick={() => onReply(message)} aria-label={`Reply to message from ${message.author}`}>Reply</button>
    </article>
  )
}
