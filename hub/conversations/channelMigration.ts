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
  /** Web identities to join to every Discord-migrated conversation so it lists in
   *  their workspace. Returns [] when the conversation mirror is disabled, which
   *  keeps the pre-existing behaviour byte-identical. */
  mirrorParticipants?: () => readonly string[]
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
    // Runs for existing conversations too (this migrator is invoked on every inbound
    // Discord message), so enabling the mirror backfills channels migrated earlier.
    ensureMirrorParticipants(deps, ensured.conversation.id)
    importReliableHistory(deps, ensured.conversation.id, event.externalLocationId)
    return ensured.conversation
  }
}

function ensureMirrorParticipants(deps: DiscordConversationMigrationDeps, conversationId: string): void {
  for (const identity of deps.mirrorParticipants?.() ?? []) {
    const trimmed = identity.trim()
    // "*" is a role-check wildcard elsewhere in config and is not an identity — never store it.
    if (!trimmed || trimmed === "*") continue
    ensureParticipant(deps, conversationId, trimmed, "user", "member")
  }
}

function ensureExternalParticipant(deps: DiscordConversationMigrationDeps, conversationId: string, authorId: string): void {
  ensureParticipant(deps, conversationId, `discord:${authorId}`, "external", "member")
}

function ensureParticipant(deps: DiscordConversationMigrationDeps, conversationId: string, identity: string, kind: "user" | "external", role: "owner" | "member" | "viewer"): void {
  if (deps.repo.getParticipant(conversationId, identity)) return
  try { deps.repo.addParticipant({ conversationId, identity, kind, role, createdAt: deps.now() }) }
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
