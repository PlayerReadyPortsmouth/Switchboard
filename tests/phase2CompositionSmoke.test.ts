import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ConversationEventStream, ConversationService, SqliteConversationRepository, TurnCoordinator } from "../hub/conversations"
import { DeliveryWorker, DiscordAdapter, SurfaceRouter, type DiscordGatewayPort } from "../hub/surfaces"
import { handleWebRequest, type WebDeps } from "../hub/webServer"
import type { AgentReply, InboundMessage } from "../hub/types"

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://switchboard${path}`, { method, headers: { "x-switchboard-user": "owner", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
}

async function removeTemp(dir: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) throw error; await Bun.sleep(10) }
  }
}

test("web-only production composition persists submit, fake agent reply, SSE, and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-web-smoke-")); const file = join(dir, "state.sqlite")
  let db = new Database(file, { create: true }); let repo = new SqliteConversationRepository(db); let id = 0; let now = 100
  let dispatched: InboundMessage | undefined
  const events = new ConversationEventStream((conversationId, after, limit) => repo.listMessages(conversationId, after, limit))
  const service = new ConversationService(repo, () => ++now, () => `id-${++id}`, events, name => name === "fake")
  const coordinator = new TurnCoordinator(service, repo, { dispatch: (_agent, _conversation, inbound) => (dispatched = inbound, true) }, events, new SurfaceRouter([]), () => ++now, () => `turn-${++id}`)
  const deps = {
    requireUser: (req: Request) => req.headers.get("x-switchboard-user"),
    createConversation: (identity: string, input: any) => service.create(identity, input),
    listConversations: (identity: string, archived?: boolean) => service.list(identity, archived),
    getConversation: (identity: string, conversationId: string) => service.get(identity, conversationId),
    archiveConversation: (identity: string, conversationId: string) => service.archive(identity, conversationId),
    appendConversationMessage: (identity: string, conversationId: string, input: any) => coordinator.submitWebTurn(identity, conversationId, input),
    listConversationMessages: (identity: string, conversationId: string, after?: number, limit?: number) => service.history(identity, conversationId, after, limit),
    addConversationLink: (identity: string, conversationId: string, input: any) => service.addTransportLink(identity, conversationId, input),
    listConversationLinks: (identity: string, conversationId: string) => service.listTransportLinks(identity, conversationId),
    subscribeConversation: (identity: string, conversationId: string, after: number, cb: any) => { service.get(identity, conversationId); return events.subscribe(conversationId, after, cb) },
  } as WebDeps
  try {
    const createdResponse = await handleWebRequest(request("/api/conversations", "POST", { title: "Smoke", primaryAgent: "fake" }), deps)
    const conversation = await createdResponse.json() as { id: string }
    expect((await handleWebRequest(request("/api/conversations", "POST", { title: "No transport", primaryAgent: "ephemeral" }), deps)).status).toBe(400)
    const states: string[] = []
    events.subscribe(conversation.id, 0, event => { if (event.kind === "turn_state") states.push(`${event.state}:${event.detail?.messageId}`) })
    expect((await handleWebRequest(request(`/api/conversations/${conversation.id}/messages`, "POST", { content: "question" }, { "idempotency-key": "web-1" }), deps)).status).toBe(201)
    const reply: AgentReply = { agent: "fake", kind: "reply", chatId: dispatched!.chatId, correlationId: "reply-1", text: "answer" }
    await coordinator.acceptAgentReply(reply)
    expect(states).toEqual([`queued:${dispatched!.messageId}`, `working:${dispatched!.messageId}`, `completed:${dispatched!.messageId}`])
    const sse = await handleWebRequest(request(`/api/conversations/${conversation.id}/events?after=0`), deps)
    const reader = sse.body!.getReader(); let text = ""
    while (!text.includes("answer")) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value) }
    await reader.cancel()
    expect(text).toContain("question"); expect(text).toContain("answer")
    db.close(); db = new Database(file); repo = new SqliteConversationRepository(db)
    expect(repo.listMessages(conversation.id).map(message => message.content)).toEqual(["question", "answer"])
  } finally { db.close(false); await removeTemp(dir) }
})

test("fake Discord production composition deduplicates inbound and sends one eligible agent delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-discord-smoke-")); const db = new Database(join(dir, "state.sqlite"), { create: true })
  const repo = new SqliteConversationRepository(db); let id = 0; let now = 100; let inbound: ((message: InboundMessage) => void) | undefined; const sends: string[] = []
  const port: DiscordGatewayPort = {
    handleInbound: cb => { inbound = cb }, async start() {}, async stop() {},
    async sendText(_channel, _text, _reply, deliveryId) { sends.push(deliveryId); return "discord-reply" },
  }
  const router = new SurfaceRouter([new DiscordAdapter(port, "fake-token")])
  const events = new ConversationEventStream((conversationId, after, limit) => repo.listMessages(conversationId, after, limit))
  const service = new ConversationService(repo, () => ++now, () => `id-${++id}`, events)
  const conversation = service.create("owner", { title: "Discord", primaryAgent: "fake" })
  service.addTransportLink("owner", conversation.id, { adapter: "discord", externalLocationId: "room", syncMode: "two_way" })
  const coordinator = new TurnCoordinator(service, repo, { dispatch: () => true }, events, router, () => ++now, () => `turn-${++id}`)
  const worker = new DeliveryWorker(repo, router, { now: () => ++now, jitter: () => 0 })
  await router.startAll(event => coordinator.acceptSurfaceEvent(event).then(() => {}))
  try {
    const message: InboundMessage = { chatId: "room", messageId: "discord-in", userId: "user", user: "User", content: "question", ts: new Date(1).toISOString(), isDM: false }
    inbound!(message); inbound!(message); await new Promise(resolve => setTimeout(resolve, 0))
    await coordinator.acceptAgentReply({ agent: "fake", kind: "reply", chatId: conversation.id, correlationId: "reply-1", text: "answer" })
    await worker.tick()
    expect(repo.listMessages(conversation.id).map(item => item.content)).toEqual(["question", "answer"])
    expect(repo.listDueDeliveries(9999)).toHaveLength(0)
    expect(sends).toHaveLength(1)
  } finally { await worker.stop(); await router.stopAll(); db.close(false); await removeTemp(dir) }
})
