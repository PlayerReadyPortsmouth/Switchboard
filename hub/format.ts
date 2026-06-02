import type { AgentConfig } from "./types"

export function chunk(text: string, limit: number, mode: "length" | "newline"): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length >= limit) {
    let cut = limit
    if (mode === "newline") {
      const para = rest.lastIndexOf("\n\n", limit)
      const line = rest.lastIndexOf("\n", limit)
      const space = rest.lastIndexOf(" ", limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest) out.push(rest)
  return out
}

/** Split text to Discord's limit and tag the first chunk with the agent's identity. */
export function formatOutbound(
  text: string,
  agent: AgentConfig,
  style: "prefix" | "embed",
  limit: number,
  mode: "length" | "newline",
  name: string,
): string[] {
  const tag = style === "prefix" ? `**${agent.emoji} ${name}** · ` : ""
  // Reserve room for the tag so the first chunk still fits under the limit.
  const chunks = chunk(text, limit - tag.length, mode)
  if (chunks.length === 0) return [tag]
  return chunks.map((c, i) => (i === 0 ? tag + c : c))
}
