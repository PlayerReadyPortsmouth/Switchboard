// hub/toolBoard.ts
import type { CardSpec } from "./types"
import type { AgentToolUsage } from "./toolUsageRegistry"

/** `Read ×12 · Bash ×7 (1✗) · attach_file ×1`, tools by count desc, truncated to
 *  Discord's 1024-char field limit with a `+N more` suffix. */
export function formatToolLine(a: AgentToolUsage): string {
  const parts = Object.entries(a.tools)
    .sort((x, y) => y[1].count - x[1].count)
    .map(([name, s]) => `${name} ×${s.count}${s.errors ? ` (${s.errors}✗)` : ""}`)
  const LIMIT = 1024
  const out: string[] = []
  let len = 0
  for (let i = 0; i < parts.length; i++) {
    const sep = out.length ? " · " : ""
    const remaining = parts.length - i
    const tail = ` · +${remaining} more`
    // Stop if adding this part would leave no room for a possible "+N more".
    if (len + sep.length + parts[i].length + (remaining > 1 ? tail.length : 0) > LIMIT) {
      out.push(`+${remaining} more`)
      break
    }
    out.push(parts[i]); len += sep.length + parts[i].length
  }
  return out.join(" · ") || "_none_"
}

/** Render the per-agent tool tallies as one embed. Pure. */
export function renderToolBoard(snapshot: AgentToolUsage[]): CardSpec {
  const fields = snapshot.slice(0, 25).map(a => ({ name: a.agent, value: formatToolLine(a) }))
  if (!fields.length) fields.push({ name: "Tools", value: "_no tool activity yet_" })
  const card: CardSpec = { title: "🛠 Tool usage", body: "Cumulative since restart.", fields, buttons: [] }
  if (snapshot.length > 25) card.footer = `+${snapshot.length - 25} more agents`
  return card
}
