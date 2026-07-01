import type { InboundMessage } from "./types"
import type { PendingApproval } from "./approval"

export interface PendingApprovalJson {
  id: string
  kind: string
  target: string
  actor: string
  chat?: string
  summary: string
  createdAt: number
  expiresAt: number
}

/** Project pending approvals for the web panel — drops `fire` (a closure,
 *  not serializable) and `state` (the list only ever contains "pending"). */
export function pendingApprovalsToJson(list: PendingApproval[]): PendingApprovalJson[] {
  return list.map((e) => ({
    id: e.id, kind: e.kind, target: e.target, actor: e.actor, chat: e.chat,
    summary: e.summary, createdAt: e.createdAt, expiresAt: e.expiresAt,
  }))
}

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
