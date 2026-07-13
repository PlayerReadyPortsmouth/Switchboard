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

test("selects one deterministic outbound-eligible Discord link", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  repo.createConversation({ id: "c", title: "Discord", primaryAgent: "a", createdBy: "o", createdAt: 1 })
  repo.createTransportLink({ id: "z", conversationId: "c", adapter: "discord", externalLocationId: "later", label: null, syncMode: "outbound_only", enabled: true }, 2)
  repo.createTransportLink({ id: "a", conversationId: "c", adapter: "discord", externalLocationId: "first", label: null, syncMode: "two_way", enabled: true }, 1)
  const router = new LegacyDiscordCompatibilityRouter(repo, {} as any)
  expect(router.resolveChatId("c")).toBe("first")
})

test("declines canonical conversations without an outbound-eligible Discord link but preserves raw channel ids", async () => {
  for (const [mode, enabled, adapter] of [["inbound_only", true, "discord"], ["notifications_only", true, "discord"], ["two_way", false, "discord"], ["two_way", true, "webhook"]] as const) {
    const repo = new SqliteConversationRepository(new Database(":memory:"))
    repo.createConversation({ id: "canonical", title: "No output", primaryAgent: "a", createdBy: "o", createdAt: 1 })
    repo.createTransportLink({ id: "link", conversationId: "canonical", adapter, externalLocationId: "wrong", label: null, syncMode: mode, enabled }, 1)
    const calls: string[] = []
    const router = new LegacyDiscordCompatibilityRouter(repo, {
      async sendCard(chatId) { calls.push(chatId); return "id" }, async editCard(chatId) { calls.push(chatId) }, async sendFiles(chatId) { calls.push(chatId); return true },
    })
    expect(router.resolveChatId("canonical")).toBeNull()
    expect(await router.sendCard("canonical", { title: "x", body: "", buttons: [] })).toBeUndefined()
    expect(await router.sendFiles("canonical", [], "x")).toBe(false)
    await router.editCard("canonical", "m", { title: "x", body: "", buttons: [] })
    expect(calls).toEqual([])
    expect(router.resolveChatId("raw-discord-channel")).toBe("raw-discord-channel")
  }
})
