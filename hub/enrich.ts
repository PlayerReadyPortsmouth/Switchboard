/** Prepend optional memory + recent-conversation blocks to a message before it
 *  is handed to an agent. Pure; empty blocks are dropped. Order: memory first
 *  (durable knowledge), then recent context, then the live message. */
export function enrich(content: string, blocks: { memory?: string; context?: string }): string {
  const parts = [blocks.memory, blocks.context, content].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  )
  return parts.join("\n\n")
}

/** Inline a quote-reply target into the message, so the agent sees what the user
 *  replied to (Discord reply references don't appear in fetched history). */
export function foldQuote(content: string, quote?: { user: string; content: string }): string {
  if (!quote || !quote.content.trim()) return content
  const q = quote.content.replace(/\s+/g, " ").trim().slice(0, 200)
  return `(replying to ${quote.user}: "${q}")\n${content}`
}
