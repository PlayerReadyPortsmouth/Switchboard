import { createHash } from "node:crypto"
import type { CachedMsg } from "../messageCache"
import type { NormalizedSurfaceEvent } from "../surfaces"
import { RepositoryConflictError, type ConversationRepository } from "./repository"
import type { Conversation } from "./types"

export type DiscordMigrationEvent = NormalizedSurfaceEvent & { locationName?: string }
export interface DiscordConversationMigrationDeps {
  repo: Pick<ConversationRepository, "resolveTransportLink" | "getConversation" | "createConversationWithOwner" | "createTransportLink" | "getParticipant" | "addParticipant" | "appendMessage">
  now: () => number
  id: () => string
  cachedHistory?: (channelId: string) => CachedMsg[]
  audit?: (detail: { channelId: string; imported: number; skipped: number }) => void
}

/** Build the stateful channel migration boundary used by the Discord adapter. */
export function createDiscordConversationMigrator(deps: DiscordConversationMigrationDeps) {
  return function ensureDiscordConversation(event: DiscordMigrationEvent, configuredAgent: string): Conversation {
    const existing = deps.repo.resolveTransportLink("discord", event.externalLocationId)
    if (existing) {
      const conversation = deps.repo.getConversation(existing.conversationId)!
      ensureExternalParticipant(deps, conversation.id, event.authorId)
      return conversation
    }

    const createdAt = deps.now()
    const conversationId = deps.id()
    const creator = "system:discord-migration"
    const candidate = deps.repo.createConversationWithOwner(
      { id: conversationId, title: event.locationName?.trim() || `Discord ${event.externalLocationId}`, primaryAgent: configuredAgent, createdBy: creator, createdAt },
      { conversationId, identity: creator, kind: "user", role: "owner", createdAt },
    )
    try {
      deps.repo.createTransportLink({ id: deps.id(), conversationId, adapter: "discord", externalLocationId: event.externalLocationId, label: event.locationName?.trim() || null, syncMode: "two_way", enabled: true }, createdAt)
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error
      const winner = deps.repo.resolveTransportLink("discord", event.externalLocationId)
      if (!winner) throw error
      const conversation = deps.repo.getConversation(winner.conversationId)!
      ensureExternalParticipant(deps, conversation.id, event.authorId)
      return conversation
    }

    ensureExternalParticipant(deps, candidate.id, event.authorId)
    importReliableHistory(deps, candidate.id, event.externalLocationId)
    return candidate
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
    const key = createHash("sha256").update(`${channelId}\0${entry.ts}\0${entry.role}\0${ordinal}`).digest("hex")
    const result = deps.repo.appendMessage({ id: deps.id(), conversationId, author, origin: entry.role === "user" ? "transport" : "agent", content: entry.text, state: "committed", clientKey: `discord-import:${key}`, createdAt: entry.ts })
    if (result.inserted) imported++
  })
  deps.audit?.({ channelId, imported, skipped })
}
