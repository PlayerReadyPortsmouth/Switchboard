import type { ChannelAgent } from "./types"

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
