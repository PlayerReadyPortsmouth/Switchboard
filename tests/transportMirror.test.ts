import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { ConversationEventStream, ConversationService, SqliteConversationRepository, TurnCoordinator } from "../hub/conversations"

test("web messages mirror only to outbound-eligible links", async () => {
  const repo = new SqliteConversationRepository(new Database(":memory:")); let n = 0
  const events = new ConversationEventStream((id, after, limit) => repo.listMessages(id, after, limit))
  const service = new ConversationService(repo, () => 10, () => `id-${++n}`, events)
  const c = service.create("me", { title: "x", primaryAgent: "a" })
  const twoWay = service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "two", syncMode: "two_way" })
  service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "in", syncMode: "inbound_only" })
  const delivered: string[][] = []
  const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, events, { deliver: async (_m, links) => { delivered.push(links.map(l => l.id)); return [] } }, () => 10, () => `id-${++n}`)
  await coordinator.submitWebTurn("me", c.id, { content: "hello", clientKey: "web-1" })
  expect(delivered).toEqual([[twoWay.id]])
})

test("Discord inbound is deduped and is never echoed to its origin", async () => {
  const repo = new SqliteConversationRepository(new Database(":memory:")); let n = 0
  const events = new ConversationEventStream((id, after, limit) => repo.listMessages(id, after, limit))
  const service = new ConversationService(repo, () => 10, () => `id-${++n}`, events)
  const c = service.create("me", { title: "x", primaryAgent: "a" }); service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "c", syncMode: "two_way" })
  let deliveries = 0
  const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, events, { deliver: async () => { deliveries++; return [] } }, () => 10, () => `id-${++n}`)
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c", externalMessageId: "m1", authorId: "u", authorName: "U", content: "hello", createdAt: 1 }
  expect((await coordinator.acceptSurfaceEvent(event))?.inserted).toBe(true)
  expect((await coordinator.acceptSurfaceEvent(event))?.inserted).toBe(false)
  expect(repo.listMessages(c.id)).toHaveLength(1); expect(deliveries).toBe(0)
})
