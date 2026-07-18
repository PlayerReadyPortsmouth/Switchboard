import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { ConversationEventStream, ConversationService, inboundLinkRoute, SqliteConversationRepository, TurnCoordinator, TurnCoordinatorClosingError } from "../hub/conversations"
import type { ConversationEvent } from "../hub/conversations/events"
import type { InboundMessage } from "../hub/types"
import { DiscordAdapter, SurfaceRouter, type DiscordGatewayPort, type NormalizedSurfaceEvent, type SurfaceDeliveryResult } from "../hub/surfaces"

function fixture(options: { dispatch?: boolean; dispatchError?: Error; reportError?: (error: unknown) => void } = {}) {
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
  const coordinator = new TurnCoordinator(service, repo, dispatcher, stream, router, () => ++now, () => `turn-${++id}`, options.reportError)
  return { repo, service, conversation, coordinator, dispatched, delivered, events, order }
}

describe("TurnCoordinator", () => {
  test("routes only enabled inbound links canonically and all others to legacy", () => {
    const link = (syncMode: "two_way" | "inbound_only" | "outbound_only" | "notifications_only", enabled = true) => ({ syncMode, enabled } as any)
    expect(inboundLinkRoute(null)).toBe("legacy")
    expect(inboundLinkRoute(link("two_way", false))).toBe("legacy")
    expect(inboundLinkRoute(link("outbound_only"))).toBe("legacy")
    expect(inboundLinkRoute(link("notifications_only"))).toBe("legacy")
    expect(inboundLinkRoute(link("two_way"))).toBe("canonical")
    expect(inboundLinkRoute(link("inbound_only"))).toBe("canonical")
  })
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

  test("durably fans inbound events to other eligible links but never echoes to the origin", async () => {
    const f = fixture()
    f.repo.createTransportLink({ id: "origin", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    f.repo.createTransportLink({ id: "webhook", conversationId: f.conversation.id, adapter: "webhook", externalLocationId: "other", label: null, syncMode: "outbound_only", enabled: true }, 1)
    f.repo.createTransportLink({ id: "inbound", conversationId: f.conversation.id, adapter: "mail", externalLocationId: "in", label: null, syncMode: "inbound_only", enabled: true }, 1)
    const result = await f.coordinator.acceptSurfaceEvent({ adapter: "discord", eventId: "fan", externalLocationId: "room", externalMessageId: "fan", authorId: "u", authorName: "U", content: "fan out", createdAt: 2 })
    expect(result?.inserted).toBe(true)
    expect(f.delivered).toEqual([result!.message.id])
    expect(f.repo.listDueDeliveries(99)).toHaveLength(0)
  })

  test("dispatches once before slow fan-out and reports ownership loss after lease reclaim", async () => {
    const repo = new SqliteConversationRepository(new Database(":memory:"))
    let now = 1; let id = 0; let release!: () => void
    const stream = new ConversationEventStream(() => [])
    const service = new ConversationService(repo, () => ++now, () => `id-${++id}`, stream)
    const conversation = service.create("owner", { title: "Race", primaryAgent: "architect" })
    repo.createTransportLink({ id: "origin", conversationId: conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    repo.createTransportLink({ id: "mirror", conversationId: conversation.id, adapter: "webhook", externalLocationId: "mirror", label: null, syncMode: "outbound_only", enabled: true }, 1)
    const dispatched: InboundMessage[] = []; const errors: unknown[] = []
    const coordinator = new TurnCoordinator(service, repo, { dispatch: (_a, _c, inbound) => (dispatched.push(inbound), true) }, stream, {
      deliver: async () => { await new Promise<void>(resolve => { release = resolve }); return [{ deliveryId: "d", adapter: "webhook", ok: true, externalMessageId: "sent" }] },
    }, () => ++now, () => `turn-${++id}`, error => errors.push(error))
    const event: NormalizedSurfaceEvent = { adapter: "discord", eventId: "race", externalLocationId: "room", externalMessageId: "race", authorId: "u", authorName: "U", content: "go", createdAt: 2 }
    expect((await coordinator.acceptSurfaceEvent(event))?.inserted).toBe(true)
    expect(dispatched).toHaveLength(1)
    const reclaimed = repo.claimDueDeliveries("worker", 100_000, 130_000)
    expect(reclaimed).toHaveLength(1)
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errors).toHaveLength(1)
    expect((await coordinator.acceptSurfaceEvent(event))?.inserted).toBe(false)
    expect(dispatched).toHaveLength(1)
  })

  test("rejects malformed normalized events without persistence or dispatch", async () => {
    const reported: unknown[] = []
    const f = fixture({ reportError: error => reported.push(error) })
    f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    await expect(f.coordinator.acceptSurfaceEvent({ adapter: "discord", eventId: " ", externalLocationId: "room", externalMessageId: "m", authorId: "u", authorName: "U", content: "x", createdAt: Number.NaN })).rejects.toThrow("Malformed normalized surface event")
    expect(f.repo.listMessages(f.conversation.id)).toHaveLength(0)
    expect(f.dispatched).toHaveLength(0)
    expect((reported[0] as Error).message).toBe("Malformed normalized surface event")
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

  test("accepts inbound_only surface links", async () => {
    const f = fixture()
    f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "inbound_only", enabled: true }, 1)
    const event: NormalizedSurfaceEvent = { adapter: "discord", eventId: "evt", externalLocationId: "room", externalMessageId: "m", authorId: "u", authorName: "User", content: "accepted", createdAt: 1 }
    expect((await f.coordinator.acceptSurfaceEvent(event))?.inserted).toBe(true)
  })

  test("persists agent text and delivery rows before invoking the surface router", async () => {
    const f = fixture()
    f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)

    const result = await f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer", correlationId: "callback-1" })

    expect(result?.message).toMatchObject({ origin: "agent", author: "architect", content: "answer", state: "completed" })
    expect(result?.deliveries).toHaveLength(1)
    expect(f.order).toContain("deliver:completed:0")
    expect(f.repo.listDueDeliveries(999)).toHaveLength(0)
  })

  test("canonical message identity takes precedence over a legacy correlation token", async () => {
    const f = fixture()
    const submitted = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "question", clientKey: "identity" })
    const result = await f.coordinator.acceptAgentReply({
      agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer",
      messageId: submitted.message.id, correlationId: "legacy-token",
    })
    if (!result || "closed" in result) throw new Error("expected an accepted agent turn")
    expect(result.message.clientKey).toBe(`agent:architect:${submitted.message.id}`)
  })

  test("production coordinator publishes queued working completed for an exact terminal outcome", async () => {
    const f = fixture()
    const submitted = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "question", clientKey: "terminal" })
    await f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer", messageId: submitted.message.id })
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: submitted.message.id, state: "completed" })
    expect(f.events.filter(event => event.kind === "turn_state").map(event => [event.state, event.detail?.messageId])).toEqual([
      ["queued", submitted.message.id], ["working", submitted.message.id], ["completed", submitted.message.id],
    ])
  })

  test("concurrent turns complete by exact message ID and duplicate outcomes do not repeat terminals", async () => {
    const f = fixture()
    const first = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "one", clientKey: "one" })
    const second = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "two", clientKey: "two" })
    await f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer two", messageId: second.message.id })
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: second.message.id, state: "completed" })
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: second.message.id, state: "completed" })
    await f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer one", messageId: first.message.id })
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: first.message.id, state: "completed" })
    expect(f.events.filter(event => event.kind === "turn_state" && event.state === "completed").map(event => event.detail?.messageId)).toEqual([second.message.id, first.message.id])
  })

  test("card-only and reset outcomes terminally settle their exact accepted turns", async () => {
    const f = fixture()
    const card = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "card", clientKey: "card" })
    const reset = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "reset", clientKey: "reset" })
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: card.message.id, state: "completed" })
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: reset.message.id, state: "failed" })
    expect(f.events.filter(event => event.kind === "turn_state" && ["completed", "failed"].includes(event.state!)).map(event => [event.detail?.messageId, event.state])).toEqual([
      [card.message.id, "completed"], [reset.message.id, "failed"],
    ])
  })

  test("an uncorrelated legacy reply is ignored without throwing or settling a canonical turn", async () => {
    const f = fixture()
    const submitted = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "question", clientKey: "legacy" })
    expect(await f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "legacy" })).toBeNull()
    expect(f.events.filter(event => event.kind === "turn_state" && ["completed", "failed"].includes(event.state!))).toEqual([])
    f.coordinator.acceptTurnOutcome({ agent: "architect", chatId: f.conversation.id, messageId: submitted.message.id, state: "failed" })
  })

  test("publishes one failed terminal when an accepted reply cannot be persisted", async () => {
    const f = fixture()
    const submitted = await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "question", clientKey: "persist-failure" })
    const failure = new Error("append failed")
    ;(f.service as any).appendAgentMessage = () => { throw failure }
    await expect(f.coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: f.conversation.id, text: "answer", messageId: submitted.message.id })).rejects.toBe(failure)
    expect(f.events.filter(event => event.kind === "turn_state" && ["completed", "failed"].includes(event.state!)).map(event => [event.state, event.detail?.messageId])).toEqual([["failed", submitted.message.id]])
  })

  test("resolves a canonical parent through the repository and router for Discord threading", async () => {
    const repo = new SqliteConversationRepository(new Database(":memory:"))
    let now = 10
    const stream = new ConversationEventStream(() => [])
    const service = new ConversationService(repo, () => ++now, () => `id-${now}`, stream)
    const conversation = service.create("owner", { title: "Thread", primaryAgent: "architect" })
    const link = repo.createTransportLink({ id: "discord-link", conversationId: conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, ++now)
    const inbound: NormalizedSurfaceEvent = { adapter: "discord", eventId: "event-parent", externalLocationId: "room", externalMessageId: "discord-parent", authorId: "user", authorName: "User", content: "question", createdAt: ++now }
    let replyId: string | undefined
    const gateway: DiscordGatewayPort = { handleInbound() {}, async start() {}, async stop() {}, async sendText(_chat, _text, reply) { replyId = reply; return "discord-child" } }
    const router = new SurfaceRouter([new DiscordAdapter(gateway, "token")])
    const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, stream, router, () => ++now, () => `turn-${now}`)
    const parent = await coordinator.acceptSurfaceEvent(inbound)
    await coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: conversation.id, text: "answer", correlationId: "reply", replyTo: parent!.message.id })
    expect(replyId).toBe("discord-parent")
  })

  test("agent output resolves before slow delivery, reports lease loss, and drain tracks background work", async () => {
    const unhandled: unknown[] = []; const listener = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", listener)
    const repo = new SqliteConversationRepository(new Database(":memory:"))
    let now = 1; let release!: () => void; const errors: unknown[] = []
    const stream = new ConversationEventStream(() => [])
    const service = new ConversationService(repo, () => ++now, () => `id-${now}`, stream)
    const conversation = service.create("owner", { title: "Agent race", primaryAgent: "architect" })
    repo.createTransportLink({ id: "link", conversationId: conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, stream, {
      deliver: async () => { await new Promise<void>(resolve => { release = resolve }); return [{ deliveryId: "d", adapter: "discord", ok: true }] },
    }, () => ++now, () => `turn-${now}`, error => errors.push(error))
    const result = await coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: conversation.id, correlationId: "slow", text: "answer" })
    expect(result?.inserted).toBe(true)
    await Promise.resolve()
    expect(repo.claimDueDeliveries("worker", 100_000, 130_000)).toHaveLength(1)
    let drained = false
    const drain = coordinator.drainDeliveries().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    release(); await drain; await new Promise(resolve => setTimeout(resolve, 0))
    process.off("unhandledRejection", listener)
    expect(errors).toHaveLength(1)
    expect(unhandled).toEqual([])
  })

  test("shutdown boundary rejects new turns while draining pre-boundary delivery", async () => {
    const repo = new SqliteConversationRepository(new Database(":memory:"))
    let now = 1; let release!: () => void; let sends = 0; let dispatches = 0
    const stream = new ConversationEventStream(() => [])
    const service = new ConversationService(repo, () => ++now, () => `id-${now}`, stream)
    const conversation = service.create("owner", { title: "Shutdown", primaryAgent: "architect" })
    repo.createTransportLink({ id: "link", conversationId: conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    const coordinator = new TurnCoordinator(service, repo, { dispatch: () => (++dispatches, true) }, stream, {
      deliver: async () => { sends++; await new Promise<void>(resolve => { release = resolve }); return [{ deliveryId: "d", adapter: "discord", ok: true }] },
    }, () => ++now, () => `turn-${now}`)
    await coordinator.submitWebTurn("owner", conversation.id, { content: "before", clientKey: "before" })
    await Promise.resolve(); expect(sends).toBe(1)
    coordinator.beginShutdown(); coordinator.beginShutdown()
    const drain = coordinator.drainDeliveries()
    await expect(coordinator.submitWebTurn("owner", conversation.id, { content: "after", clientKey: "after" })).rejects.toBeInstanceOf(TurnCoordinatorClosingError)
    expect(await coordinator.acceptSurfaceEvent({ adapter: "discord", eventId: "after", externalLocationId: "room", externalMessageId: "after", authorId: "u", authorName: "U", content: "after", createdAt: 3 })).toBeNull()
    expect(await coordinator.acceptAgentReply({ agent: "architect", kind: "reply", chatId: conversation.id, correlationId: "after", text: "after" })).toEqual({ closed: true })
    expect(repo.listMessages(conversation.id).map(message => message.content)).toEqual(["before"])
    expect(dispatches).toBe(1); expect(sends).toBe(1)
    release(); await drain
  })

  test("throwing background reporter cannot create an unhandled rejection", async () => {
    const unhandled: unknown[] = []; const listener = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", listener)
    const f = fixture({ reportError: () => { throw new Error("reporter failed") } })
    f.repo.createTransportLink({ id: "link", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "room", label: null, syncMode: "two_way", enabled: true }, 1)
    ;(f.coordinator as any).router.deliver = async () => { throw new Error("send failed") }
    await f.coordinator.submitWebTurn("owner", f.conversation.id, { content: "x", clientKey: "x" })
    await f.coordinator.drainDeliveries(); await new Promise(resolve => setTimeout(resolve, 0))
    process.off("unhandledRejection", listener)
    expect(unhandled).toEqual([])
  })

  test("does not duplicate agent output for a repeated callback", async () => {
    const f = fixture()
    const callback = { agent: "architect", kind: "reply" as const, chatId: f.conversation.id, text: "once", correlationId: "same" }
    expect((await f.coordinator.acceptAgentReply(callback))?.inserted).toBe(true)
    expect((await f.coordinator.acceptAgentReply(callback))?.inserted).toBe(false)
    expect(f.repo.listMessages(f.conversation.id).map(({ content }) => content)).toEqual(["once"])
    expect(f.delivered).toHaveLength(0)
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

  // The shared dev-agent conversation shape: one canonical conversation carrying BOTH a
  // Discord transport link and a web participant. Proves each leg of the two-way mirror.
  test("a discord-linked conversation mirrors both ways for a web participant", async () => {
    const f = fixture()
    f.repo.addParticipant({ conversationId: f.conversation.id, identity: "ops@example.com", kind: "user", role: "member", createdAt: 1 })
    const link = f.repo.createTransportLink({ id: "link-1", conversationId: f.conversation.id, adapter: "discord", externalLocationId: "chan-1", label: null, syncMode: "two_way", enabled: true }, 1)

    // Leg 1 — web ➝ Discord: the web turn is persisted and queued for delivery to the link.
    const web = await f.coordinator.submitWebTurn("ops@example.com", f.conversation.id, { content: "from the web", clientKey: "web-mirror-1" })
    expect(web.inserted).toBe(true)
    expect(f.delivered).toEqual([web.message.id])
    expect(f.repo.resolveTransportLink("discord", "chan-1")?.id).toBe(link.id)

    // Leg 2 — Discord ➝ web: an inbound surface event lands on the same canonical transcript,
    // which the web participant can read (no second delivery — it came from that link).
    const inbound = await f.coordinator.acceptSurfaceEvent({ adapter: "discord", eventId: "evt-1", externalLocationId: "chan-1", externalMessageId: "dm-1", authorId: "u1", authorName: "Ada", content: "from discord", createdAt: 200 })
    expect(inbound?.inserted).toBe(true)
    expect(f.delivered).toEqual([web.message.id])
    expect(f.service.history("ops@example.com", f.conversation.id).map(m => [m.origin, m.content])).toEqual([
      ["web", "from the web"], ["transport", "from discord"],
    ])
  })
})
