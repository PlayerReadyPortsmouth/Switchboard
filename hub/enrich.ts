/** Prepend optional memory + recent-conversation blocks to a message before it
 *  is handed to an agent. Pure; empty blocks are dropped. Order: memory first
 *  (durable knowledge), then recent context, then the live message. */
export function enrich(content: string, blocks: { memory?: string; context?: string }): string {
  const parts = [blocks.memory, blocks.context, content].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  )
  return parts.join("\n\n")
}
