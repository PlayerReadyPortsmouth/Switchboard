export interface ChatEvent {
  kind: "chat"
  ts: number
  author: string
  content: string
  origin: "discord" | "web" | "agent"
}

export interface ToolEvent {
  kind: "tool_use" | "tool_result"
  ts: number
  agent: string
  tools?: { id: string; name: string }[]        // present for kind === "tool_use"
  results?: { id: string; isError: boolean }[]  // present for kind === "tool_result"
}

export type ChannelEvent = ChatEvent | ToolEvent

/** In-memory per-channel pub/sub feeding the web dashboard's live chat pane.
 *  A hub restart drops subscribers — browser tabs reconnect and re-fetch
 *  history, same recovery story as the SSE-backed metrics/status views. */
export class ChannelStream {
  private subscribers = new Map<string, Set<(evt: ChannelEvent) => void>>()

  subscribe(channelId: string, cb: (evt: ChannelEvent) => void): () => void {
    let set = this.subscribers.get(channelId)
    if (!set) { set = new Set(); this.subscribers.set(channelId, set) }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.subscribers.delete(channelId)
    }
  }

  publish(channelId: string, evt: ChannelEvent): void {
    const set = this.subscribers.get(channelId)
    if (!set) return
    for (const cb of set) cb(evt)
  }
}
