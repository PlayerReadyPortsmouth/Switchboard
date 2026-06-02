import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"
import type { RouteDecision } from "./router"

export function chatKey(
  scope: "user" | "channel",
  isDM: boolean,
  channelId: string,
  userId: string,
): string {
  if (isDM) return `dm:${userId}`
  return scope === "channel" ? `guild:${channelId}` : `guild:${channelId}:${userId}`
}

export function decideAgent(args: {
  current: string | null
  permitted: string[]
  decision: RouteDecision | null
  threshold: number
  defaultAgent: string
}): string {
  const { current, permitted, decision, threshold, defaultAgent } = args
  const currentValid = current != null && permitted.includes(current)

  if (decision) {
    if (!currentValid) return decision.agent                  // route fresh
    if (decision.agent === current) return current            // stay
    if (decision.confidence >= threshold) return decision.agent // confident switch
    return current                                            // sticky
  }
  // Router failed.
  if (currentValid) return current
  if (permitted.includes(defaultAgent)) return defaultAgent
  return permitted[0]
}

export interface Binding { agent: string; sessionId?: string; lastActive: number }

/** Persisted chatKey → Binding store. */
export class BindingStore {
  private map: Record<string, Binding> = {}
  constructor(private path: string) {
    try { this.map = JSON.parse(readFileSync(path, "utf8")) } catch { this.map = {} }
  }
  get(key: string): Binding | undefined { return this.map[key] }
  set(key: string, b: Binding): void { this.map[key] = b; this.save() }
  clear(key: string): void { delete this.map[key]; this.save() }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }
}
