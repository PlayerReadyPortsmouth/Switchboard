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

  resolveChatId(chatId: string): string | null {
    if (!this.repo.getConversation(chatId)) return chatId
    return this.repo.listTransportLinks(chatId)
      .filter(link => link.enabled && link.adapter === "discord" && (link.syncMode === "two_way" || link.syncMode === "outbound_only"))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]?.externalLocationId ?? null
  }

  sendCard(chatId: string, card: CardSpec): Promise<string | undefined> {
    const resolved = this.resolveChatId(chatId)
    return resolved ? this.gateway.sendCard(resolved, card) : Promise.resolve(undefined)
  }
  editCard(chatId: string, messageId: string, card: CardSpec): Promise<void> {
    const resolved = this.resolveChatId(chatId)
    return resolved ? this.gateway.editCard(resolved, messageId, card) : Promise.resolve()
  }
  sendFiles(chatId: string, attachments: { data: Buffer; name: string }[], caption?: string): Promise<boolean> {
    const resolved = this.resolveChatId(chatId)
    return resolved ? this.gateway.sendFiles(resolved, attachments, caption) : Promise.resolve(false)
  }
}
