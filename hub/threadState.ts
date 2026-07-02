import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname } from "path"

export interface ThreadState {
  agentName: string
  parentChannelId: string
  worktreePath: string
  lastActive: number
  live: boolean
}

/** Persisted threadId → ThreadState store. Mirrors BindingStore (hub/bindings.ts). */
export class ThreadStateStore {
  private map: Record<string, ThreadState> = {}
  constructor(private path: string) {
    try { this.map = JSON.parse(readFileSync(path, "utf8")) } catch { this.map = {} }
  }
  get(threadId: string): ThreadState | undefined { return this.map[threadId] }
  set(threadId: string, s: ThreadState): void { this.map[threadId] = s; this.save() }
  delete(threadId: string): void { delete this.map[threadId]; this.save() }
  all(): Record<string, ThreadState> { return this.map }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = this.path + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.map, null, 2))
    renameSync(tmp, this.path)
  }
}
