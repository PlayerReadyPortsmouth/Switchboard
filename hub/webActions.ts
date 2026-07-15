import type { InboundMessage } from "./types"

/** Build the InboundMessage for a web-sent chat message — routed through the
 *  exact same orchestrator.handleMessage() path as a Discord message, tagged
 *  so audit/actor attribution reads `web:<email>` instead of a Discord id.
 *  `genId` is injected (house rule: no Math.random for identifiers). */
export function buildWebInboundMessage(
  chatId: string, email: string, text: string, now: number, genId: () => string,
): InboundMessage {
  return {
    chatId, messageId: genId(), userId: `web:${email}`, user: email,
    content: text, ts: new Date(now).toISOString(), isDM: false,
  }
}

/** The line posted to the real Discord channel when a web chat message is
 *  mirrored in, so Discord-side participants see who sent it and from where. */
export function formatMirrorLine(email: string, text: string): string {
  return `**${email} (web):** ${text}`
}
