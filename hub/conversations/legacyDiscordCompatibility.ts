import type { CardSpec } from "../types"
import type { ConversationRepository } from "./repository"

type CompatibilityRepository = Pick<ConversationRepository, "getConversation" | "listTransportLinks">
export interface LegacyDiscordGateway {
  sendCard(chatId: string, card: CardSpec): Promise<string | undefined>
  editCard(chatId: string, messageId: string, card: CardSpec): Promise<void>
  sendFiles(chatId: string, attachments: { data: Buffer; name: string }[], caption?: string): Promise<boolean>
}

export class LegacyDiscordCompatibilityRouter {
  constructor(private readonly repo: CompatibilityRepository, private readonly gateway: LegacyDiscordGateway) {}

  resolveChatId(chatId: string): string {
    if (!this.repo.getConversation(chatId)) return chatId
    return this.repo.listTransportLinks(chatId).find(link => link.enabled && link.adapter === "discord")?.externalLocationId ?? chatId
  }

  sendCard(chatId: string, card: CardSpec): Promise<string | undefined> {
    return this.gateway.sendCard(this.resolveChatId(chatId), card)
  }
  editCard(chatId: string, messageId: string, card: CardSpec): Promise<void> {
    return this.gateway.editCard(this.resolveChatId(chatId), messageId, card)
  }
  sendFiles(chatId: string, attachments: { data: Buffer; name: string }[], caption?: string): Promise<boolean> {
    return this.gateway.sendFiles(this.resolveChatId(chatId), attachments, caption)
  }
}
