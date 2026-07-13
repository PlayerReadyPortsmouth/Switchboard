import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { SqliteConversationRepository } from "../hub/conversations"
import { LegacyDiscordCompatibilityRouter } from "../hub/conversations/legacyDiscordCompatibility"

test("canonical migrated Discord rich operations target the linked external channel", async () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  repo.createConversation({ id: "canonical-uuid", title: "Discord", primaryAgent: "a", createdBy: "o", createdAt: 1 })
  repo.createTransportLink({ id: "link", conversationId: "canonical-uuid", adapter: "discord", externalLocationId: "discord-channel", label: null, syncMode: "two_way", enabled: true }, 1)
  const calls: unknown[][] = []
  const router = new LegacyDiscordCompatibilityRouter(repo, {
    async sendCard(...args: unknown[]) { calls.push(["card", ...args]); return "card-id" },
    async editCard(...args: unknown[]) { calls.push(["edit", ...args]) },
    async sendFiles(...args: unknown[]) { calls.push(["files", ...args]); return true },
  })
  await router.sendCard("canonical-uuid", { title: "Card", body: "body", buttons: [] })
  await router.editCard("canonical-uuid", "card-id", { title: "Updated", body: "body", buttons: [] })
  await router.sendFiles("canonical-uuid", [{ data: Buffer.from("x"), name: "x.txt" }], "caption")
  expect(calls.map(call => call[1])).toEqual(["discord-channel", "discord-channel", "discord-channel"])
})
