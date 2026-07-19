import { createHash } from "node:crypto"
import type { CachedMsg } from "../messageCache"
import type { NormalizedSurfaceEvent } from "../surfaces"
import type { ConversationRepository } from "./repository"
import type { Conversation } from "./types"

export type DiscordMigrationEvent = NormalizedSurfaceEvent & { locationName?: string }

/** Separator between a thread's parent channel and the thread itself. U+203A — a
 *  single glyph that reads as a path and can't be confused with a name character. */
const THREAD_SEPARATOR = " › "
const DM_PREFIX = "DM · "
/** Discord caps channel names at 100 chars; clip well below that so a sidebar row
 *  stays readable and a two-part thread title still fits. */
const MAX_NAME = 48

/** Collapse whitespace and clip an over-long name to a readable width. */
function clip(name: string): string {
  const tidy = name.trim().replace(/\s+/g, " ")
  return tidy.length > MAX_NAME ? `${tidy.slice(0, MAX_NAME - 1).trimEnd()}…` : tidy
}

/** Render a channel name in Discord's own `#channel` idiom, without doubling a `#`
 *  that the channel name already carries. */
function channelLabel(name: string): string {
  const tidy = clip(name)
  return tidy.startsWith("#") ? tidy : `#${tidy}`
}

/** The legible title for a Discord-migrated conversation:
 *   - guild channel  → `#dev-agent`
 *   - thread         → `#dev-agent › deploy questions` (parent AND thread, so it's unambiguous)
 *   - DM             → `DM · ada`
 *   - name unknown   → `Discord <id>` — the pre-existing fallback. We never invent a
 *     title; an unresolvable name degrades to exactly what it rendered as before. */
export function discordConversationTitle(event: DiscordMigrationEvent): string {
  const fallback = `Discord ${event.externalLocationId}`
  const own = event.locationName?.trim()
  if (event.isDM) {
    const who = event.authorName?.trim()
    return who ? `${DM_PREFIX}${clip(who)}` : fallback
  }
  if (!own) return fallback
  const parent = event.threadParentName?.trim()
  return parent ? `${channelLabel(parent)}${THREAD_SEPARATOR}${clip(own)}` : channelLabel(own)
}

/** Does this title look like one WE generated, rather than one a human chose in the
 *  web UI? Only migrator-owned titles are refreshed on rename — a conversation a
 *  person deliberately renamed to "ReadyAPP" must never be clobbered by the channel
 *  name on its next inbound message. */
function isMigratorOwnedTitle(title: string, externalLocationId: string): boolean {
  return title === `Discord ${externalLocationId}` || title.startsWith("#") || title.startsWith(DM_PREFIX)
}
export interface DiscordConversationMigrationDeps {
  repo: Pick<ConversationRepository, "ensureConversationForTransport" | "getParticipant" | "addParticipant" | "appendMessage" | "updateConversation">
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
    const title = discordConversationTitle(event)
    const ensured = deps.repo.ensureConversationForTransport({
      conversation: { id: conversationId, title, primaryAgent: configuredAgent, createdBy: creator, createdAt },
      owner: { conversationId, identity: creator, kind: "user", role: "owner", createdAt },
      link: { id: deps.id(), conversationId, adapter: "discord", externalLocationId: event.externalLocationId, label: event.locationName?.trim() || null, syncMode: "two_way", enabled: true },
      now: createdAt,
    })
    // Runs for existing conversations too, so a channel rename — and the legacy
    // `Discord <snowflake>` titles migrated before names were carried — self-correct
    // on the next inbound message, with no manual DB edit.
    const conversation = refreshTitle(deps, ensured.conversation, title, event.externalLocationId)
    ensureExternalParticipant(deps, ensured.conversation.id, event.authorId)
    // Runs for existing conversations too (this migrator is invoked on every inbound
    // Discord message), so enabling the mirror backfills channels migrated earlier.
    ensureMirrorParticipants(deps, ensured.conversation.id)
    importReliableHistory(deps, ensured.conversation.id, event.externalLocationId)
    return conversation
  }
}

/** Correct a stale machine-generated title in place. No-ops unless the title actually
 *  changed — `updateConversation` bumps `updated_at`, which is the web sidebar's sort
 *  key, so writing on every inbound message would both churn the DB and reshuffle the
 *  list. Never throws: a failed rename must not drop the message. */
function refreshTitle(deps: DiscordConversationMigrationDeps, conversation: Conversation, desired: string, externalLocationId: string): Conversation {
  if (conversation.title === desired) return conversation
  if (desired === `Discord ${externalLocationId}`) return conversation  // never downgrade a real name back to the snowflake
  if (!isMigratorOwnedTitle(conversation.title, externalLocationId)) return conversation
  try { return deps.repo.updateConversation(conversation.id, { title: desired }, deps.now()) }
  catch { return conversation }
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
