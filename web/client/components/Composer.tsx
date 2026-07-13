import { useLayoutEffect, useRef, type KeyboardEvent, type Ref } from "react"
import type { Message } from "../types"

export function Composer({ value, replyTo, sending, error, textareaRef, onChange, onSubmit, onRetry, onDismissReply }: {
  value: string
  replyTo: Message | null
  sending: boolean
  error: string
  textareaRef?: Ref<HTMLTextAreaElement>
  onChange(value: string): void
  onSubmit(): void
  onRetry(): void
  onDismissReply(): void
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const textarea = localRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, 6 * 24 + 24)}px`
  }, [value])
  const setRef = (node: HTMLTextAreaElement | null) => {
    localRef.current = node
    if (typeof textareaRef === "function") textareaRef(node)
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = node
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (value.trim() && !sending) onSubmit()
  }
  return (
    <div className="composer-shell">
      {replyTo ? <div className="reply-preview"><span>Replying to {replyTo.author}</span><blockquote>{replyTo.content}</blockquote><button type="button" onClick={onDismissReply} aria-label="Dismiss reply">×</button></div> : null}
      <div className="composer-field">
        <textarea ref={setRef} rows={1} aria-label="Message" value={value} onChange={event => onChange(event.currentTarget.value)} onKeyDown={keyDown} placeholder="Message the conversation" style={{ maxHeight: "calc(6 * 1.5em + 24px)" }} />
        <button type="button" className="send-action" disabled={sending || !value.trim()} onClick={onSubmit} aria-label="Send message">{sending ? "Sending…" : "Send"}</button>
      </div>
      <div className="composer-status" role="status" aria-live="polite">
        {error ? <><span>{error}</span><button type="button" onClick={onRetry} aria-label="Retry send">Retry</button></> : sending ? <span>Sending…</span> : null}
      </div>
    </div>
  )
}
