import type { ChannelAgent, ThreadAgentsConfig } from "./types"

/** The agent a channel is pinned to (messages bypass the router), or null. */
export function resolvePinnedAgent(chatId: string, pins: ChannelAgent[]): string | null {
  return pins.find((p) => p.channelId === chatId)?.agent ?? null
}

/** The agent to reset when `emojiName` is reacted in `chatId`, or null if the
 *  channel isn't pinned or its clearReaction doesn't match. */
export function clearReactionAgent(chatId: string, emojiName: string, pins: ChannelAgent[]): string | null {
  const p = pins.find((x) => x.channelId === chatId)
  return p && p.clearReaction && p.clearReaction === emojiName ? p.agent : null
}

export interface ThreadRoute { agent: string; threadWorktreeRepo?: string }

/** The agent (and, if the pin names one, which repo subdirectory of its cwd)
 *  a Discord thread should route to as its own dedicated instance, or null
 *  when threading isn't in play (not a thread, parent not pinned, parent not
 *  opted in, or the hub-wide feature is off). */
export function resolveThreadAgent(
  threadParentId: string | undefined,
  pins: ChannelAgent[],
  threadCfg: ThreadAgentsConfig | undefined,
): ThreadRoute | null {
  if (!threadParentId || !threadCfg?.enabled) return null
  const pin = pins.find((p) => p.channelId === threadParentId)
  return pin?.threaded ? { agent: pin.agent, threadWorktreeRepo: pin.threadWorktreeRepo } : null
}
