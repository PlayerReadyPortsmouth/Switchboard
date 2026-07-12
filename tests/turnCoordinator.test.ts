import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { ConversationEventStream, ConversationService, SqliteConversationRepository, TurnCoordinator } from "../hub/conversations"
import type { ConversationEvent } from "../hub/conversations/events"
import type { InboundMessage } from "../hub/types"
import type { NormalizedSurfaceEvent, SurfaceDeliveryResult } from "../hub/surfaces"

function fixture(options: { dispatch?: boolean; dispatchError?: Error } = {}) {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let now = 100
  let id = 0
  const events: ConversationEvent[] = []
  const stream = new ConversationEventStream(() => [])
  const originalPublish = stream.publish.bind(stream)
  stream.publish = (event) => { events.push(event); originalPublish(event) }
  const service = new ConversationService(repo, () => ++now, () => `id-${++id}`, stream)
  const conversation = service.create("owner", { title: "Canonical", primaryAgent: "architect" })
  const dispatched: InboundMessage[] = []
  const order: string[] = []
  const dispatcher = {
    dispatch(_agent: string, _conversationId: string, inbound: InboundMessage) {
      order.push(`dispatch:${repo.listMessages(conversation.id).length}`)
      dispatched.push(inbound)
      if (options.dispatchError) throw options.dispatchError
      return options.dispatch ?? true
    },
  }
  const delivered: string[] = []
  const router = {
    async deliver(message: { id: string }): Promise<SurfaceDeliveryResult[]> {
      order.push(`deliver:${repo.getMessage(message.id)?.state}:${repo.listDueDeliveries(999).length}`)
      delivered.push(message.id)
      return []
    },
  }
  const coordinator = new TurnCoordinator(service, repo, dispatcher, stream, router, () => ++now, () => `turn-${++id}`)
  return { repo, service, conversation, coordinator, dispatched, delivered, events, order }
}

describe("TurnCoordinator", () => {
  test("persists web input before dispatch and uses the conversation as agent chatId", async () => {
    const f = fixture()
    const result = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "hello", clientKey: "web-1" })

    expect(result.inserted).toBe(true)
    expect(f.order).toEqual(["dispatch:1"])
    expect(f.dispatched[0]).toMatchObject({ chatId: f.conversation.id, messageId: result.message.id, userId: "web:owner", user: "owner", content: "hello", isDM: false })
    expect(f.events.filter(({ kind }) => kind === "turn_state").map(({ state }) => state)).toEqual(["queued", "working"])
  })

  test("does not redispatch a duplicate web submission", async () => {
    const f = fixture()
    const input = { content: "hello", clientKey: "same-web-key" }

    expect((await f.coordinator.submitWebTurn("owner", f.conversation.id, input)).inserted).toBe(true)
    expect((await f.coordinator.submitWebTurn("owner", f.conversation.id, input)).inserted).toBe(false)
    expect(f.dispatched).toHaveLength(1)
    expect(f.repo.listMessages(f.conversation.id)).toHaveLength(1)
  })

  test("deduplicates a surface receipt before dispatch", async () => {
    const f = fixture()
    f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    const event: NormalizedSurfaceEvent = { adapter: "discord", eventId: "evt-1", externalLocationId: "room", externalMessageId: "external-1", authorId: "42", authorName: "Ada", content: "from discord", createdAt: 50 }

    expect((await f.coordinator.acceptSurfaceEvent(event))?.inserted).toBe(true)
    expect((await f.coordinator.acceptSurfaceEvent(event))?.inserted).toBe(false)
    expect(f.dispatched).toHaveLength(1)
    expect(f.dispatched[0]).toMatchObject({ chatId: f.conversation.id, userId: "discord:42", user: "discord:Ada", content: "from discord" })
  })

  test("rejects disabled and non-inbound surface links", async () => {
    for (const [syncMode, enabled] of [["outbound_only", true], ["notifications_only", true], ["two_way", false]] as const) {
      const f = fixture()
      f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode, enabled }, 1)
      const event: NormalizedSurfaceEvent = { adapter: "discord", eventId: "evt", externalLocationId: "room", externalMessageId: "m", authorId: "u", authorName: "User", content: "ignored", createdAt: 1 }
      expect(await f.coordinator.acceptSurfaceEvent(event)).toBeNull()
      expect(f.dispatched).toHaveLength(0)
      expect(f.repo.listMessages(f.conversation.id)).toHaveLength(0)
    }
  })

  test("persists agent text and delivery rows before invoking the surface router", async () => {
    const f = fixture()
    f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)

    const result = await f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer", correlationId: "callback-1" })

    expect(result?.message).toMatchObject({ origin: "agent", author: "architect", content: "answer", state: "completed" })
    expect(result?.deliveries).toHaveLength(1)
    expect(f.order).toContain("deliver:completed:1")
    expect(f.repo.listDueDeliveries(999)).toHaveLength(1)
  })

  test("does not duplicate agent output for a repeated callback", async () => {
    const f = fixture()
    const callback = { agent: "architect", kind: "reply" as const, chatId: f.conversation.id, text: "once", correlationId: "same" }
    expect((await f.coordinator.acceptAgentReply(callback))?.inserted).toBe(true)
    expect((await f.coordinator.acceptAgentReply(callback))?.inserted).toBe(false)
    expect(f.repo.listMessages(f.conversation.id).map(({ content }) => content)).toEqual(["once"])
    expect(f.delivered).toHaveLength(1)
  })

  test("keeps the committed user message and publishes failed when dispatch fails", async () => {
    const f = fixture({ dispatch: false })
    const result = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "stay", clientKey: "failure" })

    expect(f.repo.getMessage(result.message.id)?.content).toBe("stay")
    expect(f.events.filter(({ kind }) => kind === "turn_state").map(({ state }) => state)).toEqual(["queued", "failed"])
  })

  test("publishes failed and rethrows when dispatcher throws", async () => {
    const failure = new Error("transport exploded")
    const f = fixture({ dispatchError: failure })

    await expect(f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "persist me", clientKey: "throwing" })).rejects.toBe(failure)
    expect(f.repo.listMessages(f.conversation.id).map(({ content }) => content)).toEqual(["persist me"])
    expect(f.events.filter(({ kind }) => kind === "turn_state").map(({ state }) => state)).toEqual(["queued", "failed"])
  })
})
