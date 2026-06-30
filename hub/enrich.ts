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

/** Inline forwarded message(s) into the message, so the agent sees content a user
 *  forwarded from elsewhere (Discord delivers it in `message_snapshots`, separate
 *  from the typed text). Snapshots carry no author — Discord strips identity — so
 *  the block is unattributed. Forwarded attachments flow through the normal
 *  attachment pipeline (and are surfaced by `foldAttachments`); this handles text. */
export function foldForward(content: string, forwards?: { content: string }[]): string {
  if (!forwards || forwards.length === 0) return content
  const blocks = forwards.map((f) => {
    const t = f.content.replace(/\s+/g, " ").trim().slice(0, 1000)
    return t
      ? `↪️ Forwarded message: "${t}"`
      : "↪️ Forwarded message (no text — see attachments)"
  })
  return `${blocks.join("\n")}\n${content}`
}

/** A user-uploaded file after the hub has tried to download it locally. `path` is
 *  the on-disk location the agent can Read; absent ⇒ it wasn't downloaded. */
export interface FoldableAttachment {
  name: string
  type: string
  size: number
  path?: string
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Prepend a breadcrumb listing uploaded files so the agent knows they exist and
 *  where to Read them. Downloaded files show their local path; ones we couldn't
 *  fetch (no url / too large / failed) are flagged so the agent isn't left blind.
 *  No-op when there are no attachments. */
export function foldAttachments(content: string, files?: FoldableAttachment[]): string {
  if (!files || files.length === 0) return content
  const lines = files.map((f) =>
    f.path
      ? `  • ${f.path} (${f.type}, ${humanBytes(f.size)})`
      : `  • ${f.name} (${f.type}, ${humanBytes(f.size)}) — NOT downloaded`,
  )
  const header = "📎 Attached file(s) — use the Read tool on these local paths:"
  return `${[header, ...lines].join("\n")}\n\n${content}`
}
