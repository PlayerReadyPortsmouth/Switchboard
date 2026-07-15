import { renderApprovalCard } from "./approval"
import type { ApprovalNotificationPort } from "./approvalService"
import type { ApprovalNotificationView } from "./approvalTypes"
import type { CardSpec } from "./types"

export interface DiscordApprovalNotificationGateway {
  sendCard(chatId: string, card: CardSpec): Promise<string | undefined>
  editCardOrThrow(chatId: string, messageId: string, card: CardSpec): Promise<void>
}

export interface DiscordApprovalNotificationOptions {
  channelId?: string
}

interface DiscordNotificationReference {
  chatId: string
  messageId: string
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function decodeReference(reference: string): DiscordNotificationReference {
  let decoded: unknown
  try {
    decoded = JSON.parse(reference)
  } catch {
    throw new Error("invalid_notification_reference")
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("invalid_notification_reference")
  }
  const keys = Object.keys(decoded).sort()
  if (keys.length !== 2 || keys[0] !== "chatId" || keys[1] !== "messageId") {
    throw new Error("invalid_notification_reference")
  }
  const value = decoded as Record<string, unknown>
  if (!nonEmpty(value.chatId) || !nonEmpty(value.messageId)) {
    throw new Error("invalid_notification_reference")
  }
  return { chatId: value.chatId, messageId: value.messageId }
}

export class DiscordApprovalNotificationPort implements ApprovalNotificationPort {
  readonly adapter = "discord"

  constructor(
    private readonly gateway: DiscordApprovalNotificationGateway,
    private readonly options: DiscordApprovalNotificationOptions,
  ) {}

  async post(input: {
    approval: ApprovalNotificationView
    origin: { surface?: string; externalLocation?: string } | null
  }): Promise<string | null> {
    const configured = this.options.channelId?.trim()
    const fallback = input.origin?.surface === "discord"
      ? input.origin.externalLocation?.trim()
      : undefined
    const chatId = configured || fallback
    if (!chatId) return null

    const messageId = await this.gateway.sendCard(chatId, renderApprovalCard(input.approval))
    return messageId ? JSON.stringify({ chatId, messageId }) : null
  }

  async update(reference: string, approval: ApprovalNotificationView): Promise<void> {
    const decoded = decodeReference(reference)
    await this.gateway.editCardOrThrow(
      decoded.chatId,
      decoded.messageId,
      renderApprovalCard(approval),
    )
  }
}
