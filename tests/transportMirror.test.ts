import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { ConversationEventStream, ConversationService, SqliteConversationRepository, TurnCoordinator } from "../hub/conversations"
import { Gateway, InboundMultiplexer } from "../hub/gateway"

test("web messages mirror only to outbound-eligible links", async () => {
  const repo = new SqliteConversationRepository(new Database(":memory:")); let n = 0
  const events = new ConversationEventStream((id, after, limit) => repo.listMessages(id, after, limit))
  const service = new ConversationService(repo, () => 10, () => `id-${++n}`, events)
  const c = service.create("me", { title: "x", primaryAgent: "a" })
  const twoWay = service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "two", syncMode: "two_way" })
  service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "in", syncMode: "inbound_only" })
  const outbound = service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "out", syncMode: "outbound_only" })
  service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "notifications", syncMode: "notifications_only" })
  const delivered: string[][] = []
  const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, events, { deliver: async (_m, links) => { delivered.push(links.map(l => l.id)); return [] } }, () => 10, () => `id-${++n}`)
  await coordinator.submitWebTurn("me", c.id, { content: "hello", clientKey: "web-1" })
  expect(delivered).toEqual([[twoWay.id, outbound.id]])
})

test("Discord inbound publishes a committed event for web subscribers", async () => {
  const repo = new SqliteConversationRepository(new Database(":memory:")); let n = 0
  const events = new ConversationEventStream((id, after, limit) => repo.listMessages(id, after, limit)); const seen: string[] = []
  const service = new ConversationService(repo, () => 10, () => `id-${++n}`, events)
  const c = service.create("me", { title: "x", primaryAgent: "a" }); service.addTransportLink("me", c.id, { adapter: "discord", externalLocationId: "c" })
  events.subscribe(c.id, 0, event => { if (event.kind === "message_committed" && event.message) seen.push(event.message.origin) })
  const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, events, { deliver: async () => [] }, () => 10, () => `id-${++n}`)
  await coordinator.acceptSurfaceEvent({ adapter: "discord", eventId: "m", externalLocationId: "c", externalMessageId: "m", authorId: "u", authorName: "U", content: "hello", createdAt: 1 })
  expect(seen).toEqual(["transport"])
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

test("canonical inbound registration leaves legacy card, modal, and reaction callbacks intact", () => {
  const gateway = Object.create(Gateway.prototype) as Gateway
  ;(gateway as any).onMessages = new InboundMultiplexer()
  const calls: string[] = []; const legacy = () => calls.push("legacy"); const canonical = () => calls.push("canonical"); const reaction = () => {}; const card = () => {}; const modal = () => {}
  gateway.handleInbound(legacy); gateway.handleInbound(canonical)
  gateway.onReaction(reaction); gateway.onNotifyButton(card); gateway.onModalSubmit(modal)
  ;(gateway as any).onMessages.emit({}); expect(calls).toEqual(["legacy", "canonical"])
  expect((gateway as any).reactionCb).toBe(reaction)
  expect((gateway as any).notifyButtonCb).toBe(card)
  expect((gateway as any).modalSubmitCb).toBe(modal)
})
