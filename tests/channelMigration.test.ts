import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createDiscordConversationMigrator } from "../hub/conversations/channelMigration"
import { SqliteConversationRepository } from "../hub/conversations"

test("first Discord event creates one linked conversation and imports only reliable cache", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const audits: unknown[] = []
  let n = 0
  const ensure = createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}`,
    cachedHistory: () => [
      { role: "user", text: "first", ts: 10, userId: "u1" },
      { role: "agent", text: "second", ts: 20, agent: "helper" },
      { role: "user", text: "ambiguous", ts: 30 },
    ], audit: detail => audits.push(detail) })
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u2", authorName: "Ada", content: "now", createdAt: 40, locationName: "general" }
  const conversation = ensure(event, "default")
  expect(conversation.title).toBe("general")
  expect(conversation.primaryAgent).toBe("default")
  expect(repo.resolveTransportLink("discord", "c1")?.syncMode).toBe("two_way")
  expect(repo.getParticipant(conversation.id, "discord:u2")?.kind).toBe("external")
  expect(repo.listMessages(conversation.id).map(m => [m.author, m.origin, m.content])).toEqual([
    ["discord:u1", "transport", "first"], ["helper", "agent", "second"],
  ])
  expect(audits).toEqual([{ channelId: "c1", imported: 2, skipped: 1 }])
})

test("repeated ensure resolves the unique transport-link winner", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let n = 0
  const ensure = createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}` })
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u", authorName: "U", content: "hi", createdAt: 40 }
  expect(ensure(event, "a").id).toBe(ensure(event, "b").id)
  expect(repo.resolveTransportLink("discord", "c1")?.conversationId).toBe(ensure(event, "c").id)
})
