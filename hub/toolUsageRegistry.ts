// hub/toolUsageRegistry.ts
export interface ToolStat { count: number; errors: number }
export interface AgentToolUsage { agent: string; tools: Record<string, ToolStat>; total: number }
export interface LiveTool { current: string | null; last?: { name: string; error: boolean } }

interface Live { current: string | null; last?: { name: string; error: boolean } }

/** Per-agent tool tallies + live current/last tool, fed from the agent stream's
 *  tool_use / tool_result events. Cumulative since hub restart. Pure state. */
export class ToolUsageRegistry {
  private agents = new Map<string, Map<string, ToolStat>>()
  private live = new Map<string, Live>()
  // id → {agent,name} so a later tool_result can be attributed; bounded (insertion-ordered Map, evict oldest).
  private pending = new Map<string, { agent: string; name: string }>()

  constructor(private pendingCap = 1000) {}

  private statFor(agent: string, name: string): ToolStat {
    let tools = this.agents.get(agent)
    if (!tools) { tools = new Map(); this.agents.set(agent, tools) }
    let s = tools.get(name)
    if (!s) { s = { count: 0, errors: 0 }; tools.set(name, s) }
    return s
  }
  private liveOf(agent: string): Live {
    let l = this.live.get(agent)
    if (!l) { l = { current: null }; this.live.set(agent, l) }
    return l
  }

  recordToolUse(agent: string, tools: { id: string; name: string }[]): void {
    for (const t of tools) {
      this.statFor(agent, t.name).count++
      if (this.pending.size >= this.pendingCap) {
        const oldest = this.pending.keys().next().value
        if (oldest !== undefined) this.pending.delete(oldest)
      }
      this.pending.set(t.id, { agent, name: t.name })
      const l = this.liveOf(agent)
      l.current = t.name
      l.last = { name: t.name, error: false }
    }
  }

  recordToolResult(results: { id: string; isError: boolean }[]): void {
    for (const r of results) {
      const p = this.pending.get(r.id)
      if (!p) continue
      this.pending.delete(r.id)
      if (r.isError) {
        this.statFor(p.agent, p.name).errors++
        const l = this.liveOf(p.agent)
        if (l.last && l.last.name === p.name) l.last.error = true
      }
    }
  }

  endTurn(agent: string): void { const l = this.live.get(agent); if (l) l.current = null }

  liveFor(agent: string): LiveTool { const l = this.live.get(agent); return l ? { current: l.current, last: l.last } : { current: null } }

  forAgent(agent: string): AgentToolUsage | undefined {
    const tools = this.agents.get(agent)
    if (!tools) return undefined
    const rec: Record<string, ToolStat> = {}
    let total = 0
    for (const [name, s] of tools) { rec[name] = { ...s }; total += s.count }
    return { agent, tools: rec, total }
  }

  snapshot(): AgentToolUsage[] {
    return [...this.agents.keys()]
      .map(a => this.forAgent(a)!)
      .sort((x, y) => y.total - x.total)
  }
}
