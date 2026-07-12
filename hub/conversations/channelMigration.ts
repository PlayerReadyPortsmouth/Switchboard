import { createHash } from "node:crypto"
import type { CachedMsg } from "../messageCache"
import type { NormalizedSurfaceEvent } from "../surfaces"
import type { ConversationRepository } from "./repository"
import type { Conversation } from "./types"

export type DiscordMigrationEvent = NormalizedSurfaceEvent & { locationName?: string }
export interface DiscordConversationMigrationDeps {
  repo: Pick<ConversationRepository, "ensureConversationForTransport" | "getParticipant" | "addParticipant" | "appendMessage">
  now: () => number
  id: () => string
  cachedHistory?: (channelId: string) => CachedMsg[]
  audit?: (detail: { channelId: string; imported: number; skipped: number }) => void
}

/** Build the stateful channel migration boundary used by the Discord adapter. */
export function createDiscordConversationMigrator(deps: DiscordConversationMigrationDeps) {
  return function ensureDiscordConversation(event: DiscordMigrationEvent, configuredAgent: string): Conversation {
    const createdAt = deps.now()
    const conversationId = deps.id()
    const creator = "system:discord-migration"
    const ensured = deps.repo.ensureConversationForTransport({
      conversation: { id: conversationId, title: event.locationName?.trim() || `Discord ${event.externalLocationId}`, primaryAgent: configuredAgent, createdBy: creator, createdAt },
      owner: { conversationId, identity: creator, kind: "user", role: "owner", createdAt },
      link: { id: deps.id(), conversationId, adapter: "discord", externalLocationId: event.externalLocationId, label: event.locationName?.trim() || null, syncMode: "two_way", enabled: true },
      now: createdAt,
    })
    ensureExternalParticipant(deps, ensured.conversation.id, event.authorId)
    importReliableHistory(deps, ensured.conversation.id, event.externalLocationId)
    return ensured.conversation
  }
}

function ensureExternalParticipant(deps: DiscordConversationMigrationDeps, conversationId: string, authorId: string): void {
  const identity = `discord:${authorId}`
  if (deps.repo.getParticipant(conversationId, identity)) return
  try { deps.repo.addParticipant({ conversationId, identity, kind: "external", role: "member", createdAt: deps.now() }) }
  catch (error) { if (!deps.repo.getParticipant(conversationId, identity)) throw error }
}

function importReliableHistory(deps: DiscordConversationMigrationDeps, conversationId: string, channelId: string): void {
  const cached = deps.cachedHistory?.(channelId) ?? []
  let imported = 0, skipped = 0
  cached.forEach((entry, ordinal) => {
    const author = entry.role === "user" ? entry.userId && `discord:${entry.userId}` : entry.agent
    if (!author || !Number.isFinite(entry.ts) || typeof entry.text !== "string") { skipped++; return }
    if (entry.role === "user") ensureExternalParticipant(deps, conversationId, entry.userId!)
    const key = createHash("sha256").update(`${channelId}\0${entry.ts}\0${entry.role}\0${ordinal}`).digest("hex")
    const result = deps.repo.appendMessage({ id: deps.id(), conversationId, author, origin: entry.role === "user" ? "transport" : "agent", content: entry.text, state: "committed", clientKey: `discord-import:${key}`, createdAt: entry.ts })
    if (result.inserted) imported++
  })
  deps.audit?.({ channelId, imported, skipped })
}
